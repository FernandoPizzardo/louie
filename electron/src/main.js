'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, dialog, shell } = require('electron');
const { startEngine } = require('./engine');
const { startUiServer } = require('./server');

const PROXY_PORT = Number(process.env.LOUIE_PROXY_PORT || 8888);
if (process.env.LOUIE_USER_DATA) app.setPath('userData', process.env.LOUIE_USER_DATA);

let engine = null;
let uiServer = null;
let quitting = false;

function locations() {
  if (app.isPackaged) {
    return {
      engineDir: path.join(process.resourcesPath, 'engine'),
      uiDir: path.join(process.resourcesPath, 'ui'),
    };
  }
  const repo = path.resolve(__dirname, '..', '..');
  return {
    engineDir: repo,
    uiDir: path.join(repo, 'web', 'dist'),
  };
}

function createWindow(url) {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Louie',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Only the local UI runs in the window; links to anything else open in the
  // system browser instead.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, target) => {
    if (!target.startsWith(url)) {
      event.preventDefault();
      shell.openExternal(target);
    }
  });

  win.loadURL(url);
}

async function boot() {
  const { engineDir, uiDir } = locations();
  const userData = app.getPath('userData');
  fs.mkdirSync(userData, { recursive: true });
  const configFile = path.join(userData, 'config.json');
  const token = crypto.randomUUID();

  try {
    engine = await startEngine({
      engineDir,
      configFile,
      proxyPort: PROXY_PORT,
      token,
      onExit: ({ code, signal, stderr }) => {
        if (quitting) return;
        dialog.showErrorBox(
          'Louie engine stopped',
          `The engine exited (code ${code}, signal ${signal}).\n\n${stderr.slice(-1500)}`,
        );
        app.quit();
      },
    });
  } catch (err) {
    dialog.showErrorBox('Louie could not start the engine', String(err.message || err));
    app.quit();
    return;
  }

  uiServer = await startUiServer({ uiDir, controlPort: engine.controlPort, token });
  const url = `http://127.0.0.1:${uiServer.port}/`;
  console.log(`Louie UI: ${url} (proxy :${engine.proxyPort}, control :${engine.controlPort})`);
  createWindow(url);
}

// One instance at a time: a second launch focuses the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(boot);

  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', () => {
    quitting = true;
    if (engine) engine.stop();
    if (uiServer) uiServer.close();
  });
}
