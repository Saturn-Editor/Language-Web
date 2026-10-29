/**
 * Node.js versions for the status bar's version picker: Saturn's own node, `node` on PATH, and installs from nvm,
 * fnm and Volta. A version's id is its node binary's path. The choice is mirrored into module storage so the
 * language server launcher, which has no Saturn API, can start tsserver on it too.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

const WIN = process.platform === 'win32';
const NODE = WIN ? 'node.exe' : 'node';
const LANGUAGES = ['javascript', 'typescript', 'typescriptreact'];

const choicesFile = (storagePath) => join(storagePath, 'node-versions.json');

/** The node binary chosen for each project, as the launcher reads it. */
export function readChoices(storagePath) {
  try {
    return JSON.parse(readFileSync(choicesFile(storagePath), 'utf8'));
  } catch {
    return {};
  }
}

function writeChoice(storagePath, projectPath, node) {
  if (!storagePath) return;
  mkdirSync(storagePath, { recursive: true });
  writeFileSync(choicesFile(storagePath), JSON.stringify({ ...readChoices(storagePath), [projectPath]: node }, null, 2));
}

function versionOf(node) {
  try {
    return execFileSync(node, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim().replace(/^v/, '');
  } catch {
    return null;
  }
}

const subdirs = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
};

/** Version-manager installs, read from their folder names so listing doesn't start every node. */
function managed() {
  const home = homedir();
  const found = [];
  const add = (root, source, binOf) => {
    for (const name of subdirs(root)) {
      const node = binOf(join(root, name));
      if (existsSync(node)) found.push({ node, version: name.replace(/^v/, ''), source });
    }
  };
  const bin = (dir) => (WIN ? join(dir, NODE) : join(dir, 'bin', NODE));
  add(join(process.env.NVM_DIR ?? join(home, '.nvm'), 'versions', 'node'), 'nvm', bin);
  if (process.env.NVM_HOME) add(process.env.NVM_HOME, 'nvm', (dir) => join(dir, NODE));
  const fnmRoots = [process.env.FNM_DIR, join(home, '.local', 'share', 'fnm'), join(home, 'Library', 'Application Support', 'fnm'), join(home, '.fnm')];
  for (const root of new Set(fnmRoots.filter(Boolean))) add(join(root, 'node-versions'), 'fnm', (dir) => bin(join(dir, 'installation')));
  add(join(process.env.VOLTA_HOME ?? join(home, '.volta'), 'tools', 'image', 'node'), 'Volta', bin);
  return found;
}

function onPath() {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    const node = join(dir, NODE);
    // Version-manager shims on PATH resolve per directory, so they'd mislabel; their installs are listed directly.
    if (dir && existsSync(node) && !/[\\/](\.volta|fnm_multishells|\.nvm)[\\/]/.test(dir)) return node;
  }
  return null;
}

const entry = ({ node, version, source }) => ({ id: node, label: version.split('.')[0], detail: `${version} · ${source} · ${node}` });

export async function listVersions() {
  const versions = [{ node: process.execPath, version: process.versions.node, source: 'Saturn' }];
  const pathNode = onPath();
  if (pathNode) {
    const version = versionOf(pathNode);
    if (version) versions.push({ node: pathNode, version, source: 'PATH' });
  }
  versions.push(...managed());
  const seen = new Set();
  return versions.filter((v) => !seen.has(v.node) && seen.add(v.node)).map(entry);
}

/** The node binary to run project tools on: the version last chosen for the project, or Saturn's own. */
export function nodeFor(storagePath, projectPath) {
  const chosen = storagePath && readChoices(storagePath)[projectPath];
  return chosen && existsSync(chosen) ? chosen : process.execPath;
}

export function registerNodeVersions(saturn) {
  if (!saturn.languages?.registerVersions) return;
  const provider = {
    list: () => listVersions(),
    addLabel: 'Add Node…',
    async add({ folder }) {
      const node = [join(folder, NODE), join(folder, 'bin', NODE)].find(existsSync);
      const version = node && versionOf(node);
      if (!version) throw new Error(`No Node.js found in ${folder}.`);
      return entry({ node, version, source: 'added' });
    },
    async onChange({ projectPath, version }) {
      writeChoice(saturn.storagePath, projectPath, version?.id ?? null);
      saturn.languageServer?.restart?.();
    },
  };
  // JS and TS share one node, so the last choice from any of them wins; each opts in so the picker shows on all.
  for (const id of LANGUAGES) saturn.languages.registerVersions(id, provider);
}

/** PATH with the chosen node first, so runners' `#!/usr/bin/env node` shebangs use it too. */
export const envFor = (node) => ({ ...process.env, PATH: `${dirname(node)}${delimiter}${process.env.PATH ?? ''}` });
