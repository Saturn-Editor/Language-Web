import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative, sep } from 'node:path';
import { runOrThrow } from '../generators.js';
import { install as installServer, isInstalled as serverInstalled } from '../tsls.js';
import { registerDocComments } from './doc-comments.js';
import { registerNodeVersions } from './node-versions.js';
import { registerTests } from './tests.js';

/** Turns a file name into a valid identifier: `my-thing` → `MyThing`. */
function identifier(name) {
  const id = name.replace(/[^\w$]+(.)?/g, (_, c) => (c ? c.toUpperCase() : '')).replace(/^./, (c) => c.toUpperCase());
  return /^[A-Za-z_$]/.test(id) ? id : `_${id}`;
}

const fileNameFor = (extension) => ({ name }) => (/\.[^.]+$/.test(name) ? name : `${name}${extension}`);
const typeName = ({ name }) => identifier(basename(name, extname(name)));

const TEMPLATES = {
  'javascript.module': { extension: '.js', content: () => 'export {};\n' },
  'typescript.module': { extension: '.ts', content: () => 'export {};\n' },
  'typescript.class': { extension: '.ts', content: (ctx) => `export class ${typeName(ctx)} {\n}\n` },
  'typescript.interface': { extension: '.ts', content: (ctx) => `export interface ${typeName(ctx)} {\n}\n` },
};

const LOCKFILES = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['package-lock.json', 'npm'],
];

function packageManager(saturn, dir) {
  const configured = saturn.settings?.get?.('javascript.packageManager');
  if (configured && configured !== 'auto') return configured;
  return LOCKFILES.find(([file]) => existsSync(join(dir, file)))?.[1] ?? 'npm';
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** Shallowest match first, so the root package.json wins over nested ones. */
const byDepth = (projectPath) => (a, b) =>
  relative(projectPath, a).split(sep).length - relative(projectPath, b).split(sep).length ||
  relative(projectPath, a).localeCompare(relative(projectPath, b));

async function rootPackageJson(saturn, projectPath) {
  if (existsSync(join(projectPath, 'package.json'))) return join(projectPath, 'package.json');
  const files = (await saturn.workspace.findFiles(projectPath, '**/package.json')).filter((f) => !f.includes('node_modules'));
  return files.sort(byDepth(projectPath))[0] ?? null;
}

function writeIfMissing(path, content) {
  if (!existsSync(path)) writeFileSync(path, content);
}

const GITIGNORE = 'node_modules/\ndist/\n*.log\n.env\n';

const TSCONFIG = {
  compilerOptions: {
    target: 'ES2022',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    outDir: 'dist',
    rootDir: 'src',
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
  },
  include: ['src'],
};

export function activate(saturn) {
  for (const [id, { extension, content }] of Object.entries(TEMPLATES)) {
    saturn.files.registerTemplate(id, { fileName: fileNameFor(extension), content });
  }

  saturn.commands.register('javascript.openPackageJson', async ({ projectPath }) => {
    const file = await rootPackageJson(saturn, projectPath);
    if (file) return saturn.workspace.openFile(projectPath, file);
    saturn.window?.showMessage?.('No package.json found in this project.', { kind: 'warning', projectPath });
  });

  saturn.commands.register('javascript.npmInstall', ({ projectPath }) => {
    const pm = packageManager(saturn, projectPath);
    saturn.terminal.run(projectPath, { name: `${pm} install`, command: `${pm} install` });
  });

  // One run configuration per package.json script.
  saturn.run?.registerProvider((ctx) => {
    const projectPath = ctx.projectPath;
    const scripts = readJson(join(projectPath, 'package.json'))?.scripts ?? {};
    const pm = packageManager(saturn, projectPath);
    return Object.keys(scripts).map((name) => ({ name: `${pm} run ${name}`, command: `${pm} run ${name}` }));
  });

  registerTests(saturn);
  registerNodeVersions(saturn);
  registerDocComments(saturn);
  registerLanguageServerSetup(saturn);
}

const EXPRESS_APP = `import express from 'express';

const app = express();
const port = Number(process.env.PORT) || 3000;

app.use(express.json());

app.get('/', (req, res) => {
  res.json({ message: 'Hello, World!' });
});

app.listen(port, () => {
  console.log(\`Listening on http://localhost:\${port}\`);
});
`;

/**
 * Scaffolds a Node project (template "node") or an Express server ("express"): package.json, src/index,
 * tsconfig.json for TypeScript and .gitignore. Express projects also get their dependencies installed.
 */
export async function createProject({ projectPath, fields, progress }) {
  const ts = fields.language !== 'javascript';
  const express = fields.template === 'express';
  const name = basename(projectPath).toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  const devDependencies = {
    ...(ts && { typescript: '^5.9.3', '@types/node': '^22.0.0' }),
    ...(ts && express && { '@types/express': '^5.0.0', tsx: '^4.20.0' }),
  };
  const scripts = ts
    ? { build: 'tsc', start: 'node dist/index.js', ...(express && { dev: 'tsx watch src/index.ts' }) }
    : { start: 'node src/index.js', ...(express && { dev: 'node --watch src/index.js' }) };
  const pkg = {
    name,
    version: '0.1.0',
    private: true,
    type: 'module',
    scripts,
    ...(express && { dependencies: { express: '^5.1.0' } }),
    ...(Object.keys(devDependencies).length && { devDependencies }),
  };
  mkdirSync(join(projectPath, 'src'), { recursive: true });
  writeIfMissing(join(projectPath, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  writeIfMissing(join(projectPath, 'src', ts ? 'index.ts' : 'index.js'), express ? EXPRESS_APP : "console.log('Hello, World!');\n");
  if (ts) writeIfMissing(join(projectPath, 'tsconfig.json'), `${JSON.stringify(TSCONFIG, null, 2)}\n`);
  if (fields.gitignore !== false) writeIfMissing(join(projectPath, '.gitignore'), GITIGNORE);
  if (express) {
    progress?.('Installing dependencies…');
    await runOrThrow('npm', ['install', '--no-audit', '--no-fund'], projectPath);
  }
}

/**
 * Downloads the language server into module storage in the background when a JS/TS project first opens, so
 * it's ready before the server starts, and registers javascript.installLanguageServer to reinstall it.
 */
function registerLanguageServerSetup(saturn) {
  const storage = saturn.storagePath;
  const notify = (n) => (saturn.window?.notify ? saturn.window.notify(n) : saturn.window?.showMessage?.(n.message ?? n.title, { kind: n.kind }));

  async function setup({ update = false } = {}) {
    if (!storage) return;
    notify({ title: 'Setting up JavaScript', message: 'Downloading the TypeScript language server…' });
    const result = await installServer(storage, { update });
    if (result.ok) {
      saturn.languageServer?.restart?.();
      return notify({ title: 'JavaScript is ready', message: 'The TypeScript language server is installed.' });
    }
    notify({
      title: 'Could not install the TypeScript language server',
      message: result.output.trim().split(/\r?\n/).slice(-3).join('\n'),
      kind: 'error',
      actions: [{ label: 'Retry', command: 'javascript.installLanguageServer' }],
    });
  }

  saturn.commands.register('javascript.installLanguageServer', () => setup({ update: true }));
  // Saturn activates every module at startup, so download on the first JS/TS project instead. Without an
  // open event, the server launcher downloads on first use.
  let started = false;
  saturn.projects.onDidOpen?.(async ({ projectPath }) => {
    if (started || !storage || serverInstalled(storage)) return;
    for (const glob of ['**/package.json', '**/tsconfig.json', '**/*.ts', '**/*.js']) {
      if ((await saturn.workspace.findFiles(projectPath, glob)).length) {
        if (started) return;
        started = true;
        return setup();
      }
    }
  });
}
