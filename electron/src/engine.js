'use strict';
// Starts the Louie engine as a child process. Electron ships Node, so the
// engine runs with ELECTRON_RUN_AS_NODE=1 and needs no system Node install.
const { spawn } = require('child_process');
const path = require('path');

const READY = 'CHARLES_CLONE_READY ';

/**
 * Resolves once the engine prints its ready line. The handshake carries the
 * ephemeral control port, which the UI server forwards to.
 */
function startEngine({ engineDir, configFile, proxyPort, token, onExit }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        path.join(engineDir, 'bin', 'charles-clone.js'),
        '--headless',
        '--proxy', String(proxyPort),
        '--config', configFile,
        '--token', token,
        '--exit-on-stdin-close',
      ],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    let stdout = '';
    let stderr = '';
    let ready = false;

    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      let i;
      while ((i = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, i);
        stdout = stdout.slice(i + 1);
        if (!ready && line.startsWith(READY)) {
          ready = true;
          const info = JSON.parse(line.slice(READY.length));
          resolve({
            pid: info.pid,
            proxyPort: info.proxyPort,
            controlPort: info.controlPort,
            caCertPath: info.caCertPath,
            stop: () => stop(),
          });
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-4000);
    });

    child.on('error', (err) => {
      if (!ready) reject(err);
    });

    child.on('exit', (code, signal) => {
      if (!ready) {
        reject(new Error(`engine exited before it was ready (code ${code}, signal ${signal}).\n${stderr.trim()}`));
      } else if (onExit) {
        onExit({ code, signal, stderr: stderr.trim() });
      }
    });

    function stop() {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    }
  });
}

module.exports = { startEngine };
