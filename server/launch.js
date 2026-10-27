/**
 * Starts the HTML, CSS and TypeScript language servers for Saturn behind one stdio connection: the user's configured
 * vscode-langservers-extracted if set (argv[2]), otherwise the copy in module storage, plus typescript-language-server
 * from module storage, downloading either first when missing. If the TypeScript server can't be installed, HTML and
 * CSS still start and JS/TS requests get empty replies. stdout belongs to LSP, so progress goes to stderr.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createMux, readMessages, writeMessage } from '../lib/mux.js';
import { install, isInstalled, packageDir, serverScript } from '../lib/servers.js';
import * as tsls from '../lib/tsls.js';

const configured = (process.argv[2] ?? '').trim();
const storage = process.env.SATURN_MODULE_STORAGE;

async function resolvePackage() {
  if (configured && !configured.startsWith('${')) return packageDir(storage, configured);
  if (!storage) throw new Error('SATURN_MODULE_STORAGE is not set; set "vscode-langservers-extracted location" in the HTML & CSS settings.');
  if (!isInstalled(storage)) {
    process.stderr.write('[web] Downloading vscode-langservers-extracted…\n');
    const result = await install(storage, { onOutput: (text) => process.stderr.write(text) });
    if (!result.ok) {
      throw new Error(result.missingNpm ? 'npm was not found. Install Node.js from https://nodejs.org/en/download' : `Installing the language servers failed.\n${result.output}`);
    }
  }
  return packageDir(storage);
}

/** typescript-language-server's cli.mjs, or null when it isn't installed and can't be downloaded. */
async function resolveTypeScript() {
  if (!storage) return null;
  if (!tsls.isInstalled(storage)) {
    process.stderr.write('[web] Downloading the TypeScript language server…\n');
    const result = await tsls.install(storage, { onOutput: (text) => process.stderr.write(text) });
    if (!result.ok) {
      process.stderr.write(`[web] Installing the TypeScript language server failed; JavaScript/TypeScript features are off.\n${result.output}\n`);
      return null;
    }
  }
  return tsls.serverPath(storage);
}

const CSS_FILE = /\.css$/i;
const SCRIPT_FILE = /\.[cm]?[jt]sx?$/i;

try {
  const dir = await resolvePackage();
  const children = {};
  for (const name of ['html', 'css']) {
    const script = serverScript(dir, name);
    if (!existsSync(script)) throw new Error(`${script} not found.`);
    // Saturn runs this launcher on its bundled node, so the servers use the same runtime.
    children[name] = spawn(process.execPath, [script, '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });
  }
  const tsServer = await resolveTypeScript();
  if (tsServer) children.ts = spawn(process.execPath, [tsServer, '--stdio'], { stdio: ['pipe', 'pipe', 'inherit'] });

  const client = { write: (msg) => writeMessage(process.stdout, msg) };
  const servers = Object.fromEntries(Object.entries(children).map(([tag, child]) => [tag, { write: (msg) => writeMessage(child.stdin, msg) }]));
  // Without the TypeScript server, answer its requests with null so the client isn't left waiting.
  servers.ts ??= { write: (msg) => msg.id !== undefined && msg.method && client.write({ jsonrpc: '2.0', id: msg.id, result: null }) };
  const mux = createMux({
    client,
    servers,
    route: (uri) => (CSS_FILE.test(uri) ? 'css' : SCRIPT_FILE.test(uri) ? 'ts' : 'html'),
    fallback: 'html',
    initializationOptions: {
      html: { provideFormatter: true, embeddedLanguages: { css: true, javascript: true } },
      css: { provideFormatter: true },
    },
  });

  readMessages(process.stdin, mux.fromClient);
  for (const [tag, child] of Object.entries(children)) {
    readMessages(child.stdout, (msg) => mux.fromServer(tag, msg));
    child.stdin.on('error', () => {}); // a server exiting first; its exit handler reports it
    child.on('error', (e) => {
      process.stderr.write(`[web] Could not start the ${tag} language server: ${e.message}\n`);
      process.exit(1);
    });
    // Any server stopping ends the session, so Saturn can restart them all.
    child.on('exit', (code, signal) => {
      for (const other of Object.values(children)) if (other !== child) other.kill();
      process.exit(code ?? (signal ? 1 : 0));
    });
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => Object.values(children).forEach((c) => c.kill(signal)));
} catch (e) {
  process.stderr.write(`[web] ${e.message}\n`);
  process.exit(1);
}
