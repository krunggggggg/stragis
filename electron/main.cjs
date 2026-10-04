// Stragis — Electron main process (CommonJS).
//
// On app ready:
//   1. Point STRAGIS_DB_PATH at <userData>/stragis.db so the user's
//      watchlist / alerts / recorded gold ticks persist between launches.
//   2. Start the bundled local server (server/dist/server.mjs) IN-PROCESS
//      by dynamically importing it and calling its startServer(0).
//      (The previous design spawned process.execPath with
//      ELECTRON_RUN_AS_NODE=1; with electron-builder's portable target the
//      extracted temp .exe path does not exist for the child process,
//      which crashed with "spawn ...\Temp\<random>\Stragis.exe ENOENT".
//      Running in-process removes the child process entirely.)
//   3. Open the main window at http://127.0.0.1:<actualPort>.

"use strict";

const { app, BrowserWindow, dialog } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

let startedServer = null;
let mainWindow = null;

const APP_ROOT = path.join(__dirname, "..");
const SERVER_ENTRY = path.join(APP_ROOT, "server", "dist", "server.mjs");

async function startServerInProcess() {
  const dbPath = path.join(app.getPath("userData"), "stragis.db");
  process.env.STRAGIS_DB_PATH = dbPath;
  const mod = await import(pathToFileURL(SERVER_ENTRY).href);
  // Port 0 = let the OS pick a free port; startServer resolves with it.
  startedServer = await mod.startServer(0);
  return startedServer.port;
}

async function createWindow() {
  if (!fs.existsSync(SERVER_ENTRY)) {
    dialog.showErrorBox(
      "Stragis",
      "Server bundle not found (server/dist/server.mjs). Please reinstall Stragis.",
    );
    app.quit();
    return;
  }
  const port = await startServerInProcess();
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
  dialog.showErrorBox("Stragis failed to start", String((e && e.message) || e));
  app.quit();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow().catch((e) => {
      console.error(e);
      dialog.showErrorBox("Stragis failed to start", String((e && e.message) || e));
    });
  }
});

app.on("will-quit", () => {
  if (startedServer) {
    const s = startedServer;
    startedServer = null;
    s.close().catch(() => {});
  }
});
