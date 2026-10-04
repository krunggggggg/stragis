// Stragis — Electron main process (CommonJS).
//
// On app ready:
//   1. Point STRAGIS_DB_PATH at <userData>/stragis.db so the user's
//      watchlist / alerts / recorded gold ticks persist between launches.
//   2. Start the bundled local server (server/dist/server.mjs) as a child
//      process running under Electron's own Node runtime
//      (ELECTRON_RUN_AS_NODE=1), on a free localhost port.
//   3. Wait until the server answers /health, then open the main window
//      at http://127.0.0.1:<port>.

"use strict";

const { app, BrowserWindow } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

let serverChild = null;
let mainWindow = null;

const APP_ROOT = path.join(__dirname, "..");
const SERVER_ENTRY = path.join(APP_ROOT, "server", "dist", "server.mjs");
const DRIZZLE_DIR = path.join(APP_ROOT, "drizzle");

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function waitForHealth(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(
        { host: "127.0.0.1", port, path: "/health", timeout: 2000 },
        (res) => {
          res.resume();
          if (res.statusCode === 200) resolve();
          else retry();
        },
      );
      req.on("error", retry);
      req.on("timeout", () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() > deadline) reject(new Error("Stragis server did not start in time"));
      else setTimeout(attempt, 250);
    };
    attempt();
  });
}

async function startServer() {
  const port = await getFreePort();
  const dbPath = path.join(app.getPath("userData"), "stragis.db");
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    PORT: String(port),
    STRAGIS_DB_PATH: dbPath,
  };
  serverChild = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: APP_ROOT,
    env,
    stdio: process.platform === "win32" ? "ignore" : "inherit",
    windowsHide: true,
  });
  serverChild.on("exit", (code) => {
    if (code !== null && code !== 0 && !app.isQuitting) {
      console.error(`Stragis server exited with code ${code}`);
    }
  });
  await waitForHealth(port);
  return port;
}

async function createWindow() {
  // Sanity check with a clear error instead of a blank window.
  if (!fs.existsSync(SERVER_ENTRY)) {
    const { dialog } = require("electron");
    dialog.showErrorBox(
      "Stragis",
      "Server bundle not found (server/dist/server.mjs). Please reinstall Stragis.",
    );
    app.quit();
    return;
  }
  void DRIZZLE_DIR; // migrations are located by the server itself
  const port = await startServer();
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0a0e14",
    title: "Stragis",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  await mainWindow.loadURL(`http://127.0.0.1:${port}`);
}

app.whenReady().then(createWindow).catch((e) => {
  console.error("Failed to start Stragis:", e);
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow().catch((e) => console.error(e));
  }
});

app.on("will-quit", () => {
  app.isQuitting = true;
  if (serverChild && !serverChild.killed) {
    serverChild.kill();
    serverChild = null;
  }
});
