/**
 * New Project templates that hand off to a framework's own generator (create-vite, create-next-app, ng new…),
 * run non-interactively inside the already-created project folder. Saturn deletes the folder and shows the
 * error if one throws.
 */
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Runs a command in `cwd` with stdin closed, so a generator that would prompt fails fast instead of hanging. */
export function run(command, args, cwd) {
  return new Promise((resolve) => {
    let output = '';
    // npx/npm are .cmd files on Windows, which need a shell to run.
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env: { ...process.env, CI: '1', NG_CLI_ANALYTICS: 'false', NEXT_TELEMETRY_DISABLED: '1', NUXT_TELEMETRY_DISABLED: '1' },
    });
    child.stdout.on('data', (c) => (output += c));
    child.stderr.on('data', (c) => (output += c));
    child.on('error', (e) => resolve({ code: null, output: e.message, missing: e.code === 'ENOENT' }));
    child.on('close', (code) => resolve({ code, output }));
  });
}

/** Runs a command and throws a short, readable error when it fails. */
export async function runOrThrow(command, args, cwd) {
  const result = await run(command, args, cwd);
  if (result.missing) throw new Error(`${command} was not found. Install Node.js (which includes npm) from https://nodejs.org/en/download`);
  if (result.code !== 0) {
    const lines = result.output.replace(/\x1b\[[0-9;]*m/g, '').trim().split(/\r?\n/).filter((l) => l.trim() && !/^npm warn/i.test(l));
    throw new Error(lines.slice(-8).join('\n') || `${command} ${args[0] ?? ''} failed.`);
  }
}

const npx = (projectPath, pkg, ...args) => runOrThrow('npx', ['--yes', pkg, ...args], projectPath);

/** A folder name as a valid npm package name: "My Site" → "my-site". */
const packageName = (name) => name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[._-]+|-+$/g, '') || 'app';

const VITE_TEMPLATES = { vite: 'vanilla', react: 'react', preact: 'preact' };

/** Template id → generator. `ts` is whether the TypeScript variant was picked, for templates that offer both. */
export const GENERATORS = {
  angular: ({ projectPath, name, progress }) => {
    progress('Running Angular CLI (ng new)…');
    return npx(projectPath, '@angular/cli@latest', 'new', name, '--directory', '.', '--defaults', '--skip-git', '--interactive=false', '--ssr=false');
  },
  next: ({ projectPath, ts, progress }) => {
    progress('Running create-next-app…');
    return npx(projectPath, 'create-next-app@latest', '.', ts ? '--ts' : '--js', '--app', '--eslint', '--tailwind', '--src-dir', '--import-alias', '@/*', '--use-npm', '--disable-git', '--yes');
  },
  nuxt: ({ projectPath, progress }) => {
    progress('Running nuxi init…');
    return npx(projectPath, 'nuxi@latest', 'init', '.', '--force', '--template', 'minimal', '--packageManager', 'npm', '--no-gitInit', '--modules', '');
  },
  vue: async ({ projectPath, name, ts, progress }) => {
    progress('Running create-vue…');
    // create-vue only runs non-interactively when the target is a valid package name, which "." isn't, so
    // generate into a temporary folder named after the project and copy it over.
    const temp = mkdtempSync(join(tmpdir(), 'saturn-vue-'));
    try {
      const app = packageName(name);
      await npx(temp, 'create-vue@latest', ...(ts ? ['--ts'] : ['--default']), '--router', app);
      cpSync(join(temp, app), projectPath, { recursive: true });
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
    progress('Installing dependencies…');
    await runOrThrow('npm', ['install', '--no-audit', '--no-fund'], projectPath);
  },
  'react-native': ({ projectPath, ts, progress }) => {
    progress('Running create-expo-app and installing dependencies…');
    return npx(projectPath, 'create-expo-app@latest', '.', '--template', ts ? 'blank-typescript' : 'blank', '--yes', '--no-agents-md');
  },
  ...Object.fromEntries(
    Object.entries(VITE_TEMPLATES).map(([id, template]) => [
      id,
      async ({ projectPath, ts, progress }) => {
        progress('Running create-vite…');
        await npx(projectPath, 'create-vite@latest', '.', '--template', ts ? `${template}-ts` : template, '--no-interactive', '--no-immediate', '--overwrite');
        progress('Installing dependencies…');
        await runOrThrow('npm', ['install', '--no-audit', '--no-fund'], projectPath);
      },
    ]),
  ),
};
