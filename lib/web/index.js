import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join } from 'node:path';
import { renderHtml } from '../preview.js';
import { install as installServers, isInstalled as serversInstalled } from '../servers.js';

const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** "my-site" → "My Site". */
const titleFrom = (name) => name.replace(/[-_.]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim() || 'Untitled';

const withExtension = (ext) => ({ name }) => (/\.[^.]+$/.test(name) ? name : `${name}${ext}`);

const BOOTSTRAP_VERSION = '5.3.8';
const BOOTSTRAP_CDN = `https://cdn.jsdelivr.net/npm/bootstrap@${BOOTSTRAP_VERSION}/dist`;

function page({ title, stylesheet, bootstrap = false }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escape(title)}</title>${bootstrap ? `\n  <link rel="stylesheet" href="${BOOTSTRAP_CDN}/css/bootstrap.min.css">` : ''}${stylesheet ? `\n  <link rel="stylesheet" href="${escape(stylesheet)}">` : ''}
</head>
<body>${
    bootstrap
      ? `
  <main class="container py-5">
    <h1 class="display-5">${escape(title)}</h1>
    <p class="lead">Built with Bootstrap ${BOOTSTRAP_VERSION}.</p>
    <button type="button" class="btn btn-primary">Get started</button>
  </main>
  <script src="${BOOTSTRAP_CDN}/js/bootstrap.bundle.min.js"></script>`
      : `
  <h1>${escape(title)}</h1>`
  }
</body>
</html>
`;
}

const STYLESHEET = `*,
*::before,
*::after {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: system-ui, sans-serif;
  line-height: 1.5;
}
`;

const GITIGNORE = '.DS_Store\nnode_modules/\ndist/\n';

function writeIfMissing(path, content) {
  if (!existsSync(path)) writeFileSync(path, content);
}

export function activate(saturn) {
  saturn.previews?.registerRenderer('web.htmlPreview', (text, ctx) => renderHtml(text, ctx));
  registerLanguageServerSetup(saturn);

  saturn.files.registerTemplate('web.page', {
    fileName: withExtension('.html'),
    content: ({ name }) => page({ title: titleFrom(basename(name, extname(name))) }),
  });
  saturn.files.registerTemplate('web.stylesheet', {
    fileName: withExtension('.css'),
    content: () => STYLESHEET,
  });
}

/** Scaffolds a plain HTML page or a Bootstrap page: index.html, style.css and .gitignore. */
export function createPage({ projectPath, fields }) {
  const title = String(fields.title ?? '').trim() || titleFrom(basename(projectPath));
  const stylesheet = fields.stylesheet !== false;
  const bootstrap = fields.template === 'bootstrap';
  writeIfMissing(join(projectPath, 'index.html'), page({ title, stylesheet: stylesheet && 'style.css', bootstrap }));
  if (stylesheet) writeIfMissing(join(projectPath, 'style.css'), bootstrap ? '/* Your styles, loaded after Bootstrap. */\n' : STYLESHEET);
  if (fields.gitignore !== false) writeIfMissing(join(projectPath, '.gitignore'), GITIGNORE);
}

/** Scaffolds HTML5 Boilerplate: the dist/ folder of the html5-boilerplate npm package, which is the starter site. */
export async function createBoilerplate({ projectPath, progress }) {
  progress('Downloading HTML5 Boilerplate…');
  const meta = await fetch('https://registry.npmjs.org/html5-boilerplate/latest');
  if (!meta.ok) throw new Error(`Downloading HTML5 Boilerplate failed: HTTP ${meta.status}`);
  const { dist } = await meta.json();
  const res = await fetch(dist.tarball);
  if (!res.ok) throw new Error(`Downloading HTML5 Boilerplate failed: HTTP ${res.status}`);
  const temp = mkdtempSync(join(tmpdir(), 'saturn-h5bp-'));
  try {
    const archive = join(temp, 'h5bp.tgz');
    writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
    // npm tarballs wrap everything in package/; keep only package/dist/.
    await tar(['-xzf', archive, '-C', projectPath, '--strip-components=2', 'package/dist']);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function tar(args) {
  return new Promise((resolve, reject) => {
    let output = '';
    const child = spawn('tar', args);
    child.stderr.on('data', (c) => (output += c));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Unpacking failed.\n${output}`))));
  });
}

/**
 * Downloads the language servers into module storage in the background when a web project first opens, so
 * they're ready before the server starts, and registers web.installLanguageServer to install or update on demand.
 */
function registerLanguageServerSetup(saturn) {
  const storage = saturn.storagePath;
  const notify = (n) => (saturn.window?.notify ? saturn.window.notify(n) : saturn.window?.showMessage?.(n.message ?? n.title, { kind: n.kind }));

  async function setup({ update = false } = {}) {
    if (!storage) return;
    notify({ title: 'Setting up HTML & CSS', message: update ? 'Updating the language servers…' : 'Downloading the language servers…' });
    const result = await installServers(storage, { update });
    if (result.ok) {
      saturn.languageServer?.restart?.();
      return notify({ title: 'HTML & CSS are ready', message: 'The language servers are installed.' });
    }
    if (result.missingNpm) {
      return notify({
        title: 'HTML & CSS needs npm',
        message: 'Install Node.js (which includes npm), then restart Saturn.',
        kind: 'error',
        actions: [{ label: 'Download', url: 'https://nodejs.org/en/download' }],
      });
    }
    notify({
      title: 'Could not install the HTML & CSS language servers',
      message: result.output.trim().split(/\r?\n/).slice(-3).join('\n'),
      kind: 'error',
      actions: [
        { label: 'Retry', command: 'web.installLanguageServer' },
        { label: 'Open settings', openSettings: true },
      ],
    });
  }

  saturn.commands.register('web.installLanguageServer', () => setup({ update: true }));
  // Saturn activates every module at startup, so download on the first web project instead. Without an
  // open event, the server launcher downloads on first use.
  let started = false;
  saturn.projects.onDidOpen?.(async ({ projectPath }) => {
    const custom = String(saturn.settings?.get?.('web.serverPath') ?? '').trim();
    if (started || !storage || custom || serversInstalled(storage)) return;
    for (const glob of ['**/*.html', '**/*.htm', '**/*.css']) {
      if ((await saturn.workspace.findFiles(projectPath, glob)).length) {
        if (started) return;
        started = true;
        return setup();
      }
    }
  });
}
