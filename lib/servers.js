/**
 * vscode-langservers-extracted lives in the module's storage folder, installed with
 * `npm install --prefix` (no global install, PATH changes or admin rights).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const PACKAGE = 'vscode-langservers-extracted';

/** The installed package folder: under a custom location if given, otherwise module storage. */
export function packageDir(storagePath, custom = '') {
  if (custom) return existsSync(join(custom, 'bin')) ? custom : join(custom, 'node_modules', PACKAGE);
  return join(storagePath, 'tools', 'node_modules', PACKAGE);
}

export const serverScript = (dir, name) => join(dir, 'bin', `vscode-${name}-language-server`);

export const isInstalled = (storagePath) => existsSync(serverScript(packageDir(storagePath), 'html'));

const pending = new Map(); // storagePath → install promise

const STALE_LOCK_MS = 5 * 60 * 1000;
const lockPath = (storagePath) => join(storagePath, 'tools.installing');

/** Takes the cross-process install lock (an atomic mkdir), waiting while another process holds it. */
async function acquireLock(storagePath) {
  const lock = lockPath(storagePath);
  mkdirSync(storagePath, { recursive: true });
  for (;;) {
    try {
      mkdirSync(lock);
      return () => rmSync(lock, { recursive: true, force: true });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let age = 0;
      try {
        age = Date.now() - statSync(lock).mtimeMs;
      } catch {
        continue; // released between mkdir and stat
      }
      if (age > STALE_LOCK_MS) rmSync(lock, { recursive: true, force: true });
      else await new Promise((r) => setTimeout(r, 500));
    }
  }
}

/**
 * Installs the language servers into storage, or updates them when `update` is set. Concurrent calls share one run.
 * @returns {Promise<{ ok: boolean, output: string, missingNpm?: boolean }>}
 */
export function install(storagePath, { update = false, onOutput } = {}) {
  if (pending.has(storagePath)) return pending.get(storagePath);
  const run = (async () => {
    const release = await acquireLock(storagePath);
    try {
      // Another process may have installed it while we waited.
      if (!update && isInstalled(storagePath)) return { ok: true, output: '' };
      return await runNpm(storagePath, onOutput);
    } finally {
      release();
    }
  })().finally(() => pending.delete(storagePath));
  pending.set(storagePath, run);
  return run;
}

function runNpm(storagePath, onOutput) {
  const prefix = join(storagePath, 'tools');
  mkdirSync(prefix, { recursive: true });
  return new Promise((resolve) => {
    let output = '';
    // npm is npm.cmd on Windows, which needs a shell to run.
    const child = spawn('npm', ['install', '--prefix', prefix, '--no-audit', '--no-fund', '--omit=dev', `${PACKAGE}@latest`], {
      shell: process.platform === 'win32',
    });
    const collect = (chunk) => {
      output += chunk;
      onOutput?.(chunk.toString());
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (e) => resolve({ ok: false, output: String(e.message), missingNpm: e.code === 'ENOENT' }));
    child.on('close', (code) => resolve({ ok: code === 0 && isInstalled(storagePath), output }));
  });
}
