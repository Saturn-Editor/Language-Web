/**
 * typescript-language-server and typescript live in the module's storage folder, downloaded straight from the
 * npm registry and unpacked with the system `tar` (neither package has runtime dependencies, so npm isn't needed).
 * They get their own folder and lock, apart from the npm-managed HTML/CSS servers in tools/, which npm would prune.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PACKAGES = { 'typescript-language-server': '6.0.2', typescript: '5.9.3' }; // TypeScript 7 has no tsserver.js

export const toolsDir = (storagePath) => join(storagePath, 'typescript');
// node_modules layout, so the server's require.resolve('typescript') finds the bundled copy.
const packageDir = (storagePath, name) => join(toolsDir(storagePath), 'node_modules', name);

export const serverPath = (storagePath) => join(packageDir(storagePath, 'typescript-language-server'), 'lib', 'cli.mjs');

export const isInstalled = (storagePath) => existsSync(serverPath(storagePath)) && existsSync(join(packageDir(storagePath, 'typescript'), 'lib', 'tsserver.js'));

const pending = new Map(); // storagePath → install promise

const STALE_LOCK_MS = 5 * 60 * 1000;
const lockPath = (storagePath) => join(storagePath, 'typescript.installing');

/** Takes the cross-process install lock (an atomic mkdir), waiting while another process holds it. */
async function acquireLock(storagePath) {
  mkdirSync(storagePath, { recursive: true });
  const lock = lockPath(storagePath);
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
 * Installs both packages into storage, or reinstalls them when `update` is set. Concurrent calls share one run.
 * @returns {Promise<{ ok: boolean, output: string }>}
 */
export function install(storagePath, { update = false, onOutput } = {}) {
  if (pending.has(storagePath)) return pending.get(storagePath);
  const run = (async () => {
    const release = await acquireLock(storagePath);
    try {
      // Another process may have installed it while we waited.
      if (!update && isInstalled(storagePath)) return { ok: true, output: '' };
      let output = '';
      for (const [name, version] of Object.entries(PACKAGES)) {
        onOutput?.(`Downloading ${name}@${version}…\n`);
        output += await installPackage(storagePath, name, version);
      }
      return { ok: isInstalled(storagePath), output };
    } catch (e) {
      return { ok: false, output: String(e.message) };
    } finally {
      release();
    }
  })().finally(() => pending.delete(storagePath));
  pending.set(storagePath, run);
  return run;
}

async function installPackage(storagePath, name, version) {
  const res = await fetch(`https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`);
  if (!res.ok) throw new Error(`Downloading ${name}@${version} failed: HTTP ${res.status}`);
  const archive = join(toolsDir(storagePath), `${name}.tgz`);
  const dest = packageDir(storagePath, name);
  mkdirSync(toolsDir(storagePath), { recursive: true });
  writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  try {
    // npm tarballs wrap everything in a `package/` folder.
    return await exec('tar', ['-xzf', archive, '-C', dest, '--strip-components=1']);
  } finally {
    rmSync(archive, { force: true });
  }
}

function exec(command, args) {
  return new Promise((resolve, reject) => {
    let output = '';
    const child = spawn(command, args);
    child.stdout.on('data', (c) => (output += c));
    child.stderr.on('data', (c) => (output += c));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(output) : reject(new Error(`${command} exited with ${code}\n${output}`))));
  });
}
