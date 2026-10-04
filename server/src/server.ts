// Local HTTP server for Stragis (standalone / Electron).
//
// - POST /actions  JSON { action, args } -> validates args with the action's
//   zod request schema, calls handler(ctx, args), returns the JSON result.
// - GET  /health   -> { ok: true }
// - Everything else: static files from client/dist with SPA fallback.
//
// Runtime: plain Node 20+ (also runs under Electron's Node via
// ELECTRON_RUN_AS_NODE). Production build is a single bundled ESM file
// produced by esbuild (see package.json "build:server"); better-sqlite3
// stays external because it is a native module.
//
// Port: env PORT, default 4317. DB path: env STRAGIS_DB_PATH (see db.ts).

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Actions } from "./actions";
import { createDb } from "./db";
import type { ActionContext } from "./sdk-shim";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

function clientDistDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // server/src or server/dist -> ../../client/dist
  const fromModule = path.resolve(here, "../../client/dist");
  if (fs.existsSync(path.join(fromModule, "index.html"))) return fromModule;
  return path.resolve(process.cwd(), "client/dist");
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(payload);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export interface StartedServer {
  server: http.Server;
  port: number;
  close: () => Promise<void>;
}

export function startServer(port = Number(process.env.PORT ?? 4317)): Promise<StartedServer> {
  const { db } = createDb();
  const ctx: ActionContext = {
    // actions.ts calls ctx.db<typeof schema>() — the concrete db instance
    // is already typed against that schema.
    db: (() => db) as ActionContext["db"],
    invalidateQueries: () => {
      /* no-op: the React client invalidates its own queries after mutations */
    },
  };
  const distDir = clientDistDir();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const pathname = decodeURIComponent(url.pathname);

      if (pathname === "/health") {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (pathname === "/actions") {
        if (req.method !== "POST") {
          sendJson(res, 405, { ok: false, error: "POST required" });
          return;
        }
        let payload: { action?: unknown; args?: unknown };
        try {
          payload = JSON.parse(await readBody(req));
        } catch {
          sendJson(res, 400, { ok: false, error: "Invalid JSON body" });
          return;
        }
        const actionName = typeof payload.action === "string" ? payload.action : "";
        const action = (Actions as Record<string, (typeof Actions)[keyof typeof Actions]>)[actionName];
        if (!action) {
          sendJson(res, 404, { ok: false, error: `Unknown action: ${actionName}` });
          return;
        }
        let args: unknown = payload.args ?? {};
        if (action.request) {
          const parsed = action.request.safeParse(args);
          if (!parsed.success) {
            sendJson(res, 400, {
              ok: false,
              error: `Invalid args for ${actionName}: ${parsed.error.issues
                .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
                .join("; ")}`,
            });
            return;
          }
          args = parsed.data;
        }
        const result = await action.handler(ctx as never, args as never);
        sendJson(res, 200, result);
        return;
      }

      // Static client + SPA fallback.
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendJson(res, 405, { ok: false, error: "Method not allowed" });
        return;
      }
      const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
      const filePath = path.resolve(distDir, rel);
      const safe = filePath === distDir || filePath.startsWith(distDir + path.sep);
      const target = safe && fs.existsSync(filePath) && fs.statSync(filePath).isFile()
        ? filePath
        : path.join(distDir, "index.html");
      if (!fs.existsSync(target)) {
        res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
        res.end("Stragis client build not found. Run: npm run build");
        return;
      }
      const ext = path.extname(target).toLowerCase();
      res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream" });
      if (req.method === "HEAD") res.end();
      else fs.createReadStream(target).pipe(res);
    } catch (e) {
      sendJson(res, 500, { ok: false, error: String((e as Error)?.message || e) });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      const actualPort = typeof addr === "object" && addr ? addr.port : port;
      resolve({
        server,
        port: actualPort,
        close: () =>
          new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  startServer()
    .then(({ port }) => {
      console.log(`Stragis server listening on http://127.0.0.1:${port}`);
      console.log(`Database: ${process.env.STRAGIS_DB_PATH ?? "./data/stragis.db"}`);
    })
    .catch((e) => {
      console.error("Failed to start Stragis server:", e);
      process.exit(1);
    });
}
