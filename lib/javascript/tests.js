import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { envFor, nodeFor } from './node-versions.js';

const NODE_REPORTER = join(dirname(fileURLToPath(import.meta.url)), 'node-reporter.mjs');

const SKIP_DIRS = /(^|\/)(node_modules|dist|build|coverage|\.next|out)\//;

/** Each runner's default test file patterns. */
const RUNNERS = {
  vitest: {
    label: 'Vitest',
    globs: ['**/*.{test,spec}.{js,mjs,cjs,jsx,ts,mts,cts,tsx}'],
  },
  jest: {
    label: 'Jest',
    globs: ['**/*.{test,spec}.{js,jsx,ts,tsx}', '**/__tests__/**/*.{js,jsx,ts,tsx}'],
  },
  node: {
    label: 'Node test runner',
    globs: ['**/*{.,-,_}test.{js,mjs,cjs}', '**/test.{js,mjs,cjs}', '**/test/**/*.{js,mjs,cjs}'],
  },
};

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/** vitest or jest when the project depends on it or its test script calls it, otherwise node --test. */
export function detectRunner(projectPath) {
  const pkg = readJson(join(projectPath, 'package.json'));
  if (!pkg) return null;
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const script = pkg.scripts?.test ?? '';
  if ('vitest' in deps || /\bvitest\b/.test(script)) return 'vitest';
  if ('jest' in deps || /\bjest\b/.test(script)) return 'jest';
  return 'node';
}

const toPosix = (p) => p.split(sep).join('/');

async function testFiles(saturn, projectPath, runner) {
  const found = new Set();
  for (const glob of RUNNERS[runner].globs) {
    for (const file of await saturn.workspace.findFiles(projectPath, glob)) {
      if (!SKIP_DIRS.test(toPosix(relative(projectPath, file)))) found.add(file);
    }
  }
  return [...found].sort();
}

export const testId = (rel, names) => `${rel}::${names.join(' > ')}`;

const CALL = /^(describe|suite|context|it|test)(?:\.(?:only|skip|todo|concurrent|sequential|fails))*\s*\(\s*(['"`])/;
const GROUPS = new Set(['describe', 'suite', 'context']);
const ANY_CALL = /(?<![\w$.])(?:describe|suite|context|it|test)(?:\.\w+)*\s*\(/;

/**
 * Finds describe/it/test calls whose name is a string literal, nested by brace depth. Skips comments and
 * strings so their braces don't count, and ignores `.each` tables and `t.test` subtests.
 */
export function parseTests(source, file, rel) {
  const root = [];
  const stack = [{ depth: -1, children: root, names: [] }];
  let depth = 0;
  let line = 1;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\n') line++;
    else if (ch === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      i--;
    } else if (ch === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end < 0 ? source.length : end + 2;
      for (; i < stop; i++) if (source[i] === '\n') line++;
      i--;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      i = skipString(source, i, (n) => (line += n));
    } else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      while (stack.length > 1 && depth <= stack.at(-1).depth) stack.pop();
    } else if (/[a-z]/.test(ch) && !/[\w$.]/.test(source[i - 1] ?? '')) {
      const m = CALL.exec(source.slice(i, i + 80));
      if (!m) continue;
      const quote = i + m[0].length - 1;
      const end = skipString(source, quote, () => {});
      const raw = source.slice(quote + 1, end);
      if (m[2] === '`' && raw.includes('${')) continue;
      const label = raw.replace(/\\(.)/g, '$1');
      const parent = stack.at(-1);
      const names = [...parent.names, label];
      const item = { id: testId(rel, names), label, path: file, line };
      parent.children.push(item);
      if (GROUPS.has(m[1])) {
        item.children = [];
        stack.push({ depth, children: item.children, names });
      }
      i = end;
    }
  }
  return root;
}

/** Index of the closing quote of the string starting at `start`, counting newlines and `${}` in templates. */
function skipString(source, start, newlines) {
  const quote = source[start];
  let nested = 0;
  for (let i = start + 1; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\\') i++;
    else if (ch === '\n') {
      if (quote !== '`') return i;
      newlines(1);
    } else if (quote === '`' && ch === '$' && source[i + 1] === '{') nested++, i++;
    else if (nested && ch === '}') nested--;
    else if (!nested && ch === quote) return i;
  }
  return source.length;
}

export async function discoverTests(saturn, projectPath) {
  const runner = detectRunner(projectPath);
  if (!runner) return [];
  const items = [];
  for (const file of await testFiles(saturn, projectPath, runner)) {
    const rel = toPosix(relative(projectPath, file));
    let source;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const children = parseTests(source, file, rel);
    // Keep files whose tests are all dynamic (.each, template names) so tests found during a run have a parent;
    // skip helpers in test/ folders that call no test functions.
    if (children.length || ANY_CALL.test(source)) items.push({ id: rel, label: rel, path: file, children });
  }
  return items;
}

/** The runner from node_modules/.bin, looking up from the project for hoisted monorepo installs. */
function localBin(projectPath, name) {
  const file = process.platform === 'win32' ? `${name}.cmd` : name;
  for (let dir = projectPath; ; dir = dirname(dir)) {
    const bin = join(dir, 'node_modules', '.bin', file);
    if (existsSync(bin)) return bin;
    if (dirname(dir) === dir) throw new Error(`${name} isn't installed. Install dependencies and try again.`);
  }
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Splits ids into files and a -t pattern of full names. */
function selection(ids) {
  const files = new Set();
  const names = new Set();
  for (const id of ids) {
    const at = id.indexOf('::');
    files.add(id.slice(0, at));
    // Jest and older Vitest join full names with a space, Vitest 5 with " > ".
    names.add(id.slice(at + 2).split(' > ').map(escapeRegExp).join('(?: > | )'));
  }
  return { files: [...files], pattern: [...names].join('|') };
}

/** Kills the process and its workers; on Windows the runner sits behind a shell, so kill the whole tree. */
function kill(child) {
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
  else child.kill('SIGTERM');
}

function exec(command, args, { cwd, signal, output, onStdout, node = process.execPath }) {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) return resolvePromise(null);
    const child = spawn(command, args, {
      cwd,
      env: { ...envFor(node), FORCE_COLOR: '0', CI: '1' },
      shell: process.platform === 'win32',
    });
    const abort = () => kill(child);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8').on('data', onStdout ?? output);
    child.stderr.setEncoding('utf8').on('data', output);
    child.on('error', reject);
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort);
      resolvePromise(code);
    });
  });
}

const STATES = { passed: 'passed', failed: 'failed', pending: 'skipped', skipped: 'skipped', todo: 'skipped', disabled: 'skipped' };

/** Maps vitest's or jest's JSON report back to ids. */
function reportJson(json, projectPath, report) {
  for (const file of json?.testResults ?? []) {
    const rel = toPosix(relative(projectPath, isAbsolute(file.name) ? file.name : resolve(projectPath, file.name)));
    const assertions = file.assertionResults ?? [];
    for (const a of assertions) {
      report({
        rel,
        names: [...(a.ancestorTitles ?? []), a.title],
        line: a.location?.line,
        state: STATES[a.status] ?? 'failed',
        message: a.failureMessages?.length ? a.failureMessages.join('\n\n') : undefined,
        durationMs: a.duration ?? undefined,
      });
    }
    // A file that fails to load has no assertions; fail its tests with the file's message instead.
    if (!assertions.length && file.status === 'failed' && file.message) report({ rel, state: 'failed', message: file.message, fileError: true });
  }
}

/** Line hits from istanbul's coverage-final.json, keyed by each statement's first line as istanbul does. */
export function istanbulCoverage(json) {
  return Object.values(json ?? {}).map(({ path, statementMap, s }) => {
    const hits = new Map();
    for (const [key, { start }] of Object.entries(statementMap)) hits.set(start.line, Math.max(hits.get(start.line) ?? 0, s[key]));
    return coverageEntry(path, hits);
  });
}

/** Line hits from an lcov file's SF/DA records. */
export function lcovCoverage(text) {
  const files = [];
  let path, hits;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('SF:')) (path = line.slice(3)), (hits = new Map());
    else if (line.startsWith('DA:') && hits) {
      const [n, count] = line.slice(3).split(',').map(Number);
      hits.set(n, Math.max(hits.get(n) ?? 0, count));
    } else if (line === 'end_of_record' && hits) files.push(coverageEntry(path, hits)), (hits = null);
  }
  return files;
}

function coverageEntry(path, hits) {
  const covered = [];
  const uncovered = [];
  for (const [line, count] of [...hits].sort((a, b) => a[0] - b[0])) (count > 0 ? covered : uncovered).push(line);
  return { path, covered, uncovered };
}

async function runWithJsonReport(runner, { projectPath, ids, signal, coverage, report, reportCoverage, output, node }) {
  const dir = mkdtempSync(join(tmpdir(), 'saturn-tests-'));
  const outputFile = join(dir, 'report.json');
  const args =
    runner === 'vitest'
      ? ['run', '--reporter=default', '--reporter=json', `--outputFile=${outputFile}`, '--includeTaskLocation']
      : ['--json', `--outputFile=${outputFile}`, '--testLocationInResults'];
  const coverageDir = join(dir, 'coverage');
  if (coverage && runner === 'vitest') args.push('--coverage.enabled', '--coverage.reportOnFailure', '--coverage.reporter=json', `--coverage.reportsDirectory=${coverageDir}`);
  if (coverage && runner === 'jest') args.push('--coverage', '--coverageReporters=json', `--coverageDirectory=${coverageDir}`);
  if (ids) {
    const { files, pattern } = selection(ids);
    if (runner === 'jest') args.push('--runTestsByPath');
    args.push(...files, '-t', pattern);
  }
  try {
    const code = await exec(localBin(projectPath, runner), args, { cwd: projectPath, signal, output, node });
    if (signal?.aborted) return;
    const json = readJson(outputFile);
    if (!json) throw new Error(`${RUNNERS[runner].label} exited with code ${code} without writing results.`);
    reportJson(json, projectPath, report);
    if (coverage) {
      const files = readJson(join(coverageDir, 'coverage-final.json'));
      if (files) reportCoverage(istanbulCoverage(files).map((f) => ({ ...f, path: resolve(projectPath, f.path) })));
      else output(`${RUNNERS[runner].label} didn't write coverage. Is its coverage provider installed?\n`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** node --test with our NDJSON reporter on stdout and the spec reporter's log on stderr. */
async function runNode({ projectPath, ids, signal, coverage, report, reportCoverage, output, node }) {
  const args = ['--test', `--test-reporter=${NODE_REPORTER}`, '--test-reporter-destination=stdout', '--test-reporter=spec', '--test-reporter-destination=stderr'];
  const dir = coverage && mkdtempSync(join(tmpdir(), 'saturn-tests-'));
  if (coverage) args.push('--experimental-test-coverage', '--test-reporter=lcov', `--test-reporter-destination=${join(dir, 'lcov.info')}`);
  if (ids) {
    const { files } = selection(ids);
    // Node matches patterns against each test's own name, so select by leaf name and filter the results.
    const names = new Set(ids.map((id) => id.slice(id.indexOf('::') + 2).split(' > ').at(-1)));
    args.push(`--test-name-pattern=^(?:${[...names].map(escapeRegExp).join('|')})$`, ...files);
  }
  const ancestors = new Map(); // file → names by nesting, from test:start
  let buffered = '';
  const onStdout = (chunk) => {
    const lines = (buffered + chunk).split('\n');
    buffered = lines.pop();
    for (const text of lines) {
      let e;
      try {
        e = JSON.parse(text);
      } catch {
        if (text.trim()) output(`${text}\n`);
        continue;
      }
      if (!e.file) continue;
      const rel = toPosix(relative(projectPath, e.file.startsWith('file:') ? fileURLToPath(e.file) : e.file));
      const stack = ancestors.get(rel) ?? [];
      ancestors.set(rel, stack);
      if (e.type === 'test:start') {
        stack.length = e.nesting;
        stack.push(e.name);
        continue;
      }
      if (e.suite) continue;
      const test = { rel, names: [...stack.slice(0, e.nesting), e.name], line: e.line, durationMs: e.durationMs };
      report(
        e.type === 'test:pass'
          ? { ...test, state: e.skip || e.todo ? 'skipped' : 'passed' }
          : { ...test, state: 'failed', message: e.error },
      );
    }
  };
  try {
    await exec(node, args, { cwd: projectPath, signal, output, onStdout, node });
    if (coverage && !signal?.aborted && existsSync(join(dir, 'lcov.info'))) {
      reportCoverage(lcovCoverage(readFileSync(join(dir, 'lcov.info'), 'utf8')).map((f) => ({ ...f, path: resolve(projectPath, f.path) })));
    }
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

export function registerTests(saturn) {
  if (!saturn.tests?.registerController) return;
  saturn.tests.registerController('javascript.tests', {
    label: 'JavaScript',
    supportsCoverage: true,
    discover: ({ projectPath }) => discoverTests(saturn, projectPath),
    async run(ctx) {
      const runner = detectRunner(ctx.projectPath);
      if (!runner) throw new Error('No package.json in this project.');
      const wanted = ctx.ids && new Set(ctx.ids);
      for (const id of ctx.ids ?? []) ctx.report({ id, state: 'running' });
      const known = new Set();
      const collect = (items) => items.forEach((item) => (known.add(item.id), item.children && collect(item.children)));
      collect(await discoverTests(saturn, ctx.projectPath));
      const seen = new Set();
      const fileErrors = new Map();
      const report = ({ rel, names, line, fileError, ...result }) => {
        if (fileError) return fileErrors.set(rel, result.message);
        const id = testId(rel, names);
        if (wanted && !wanted.has(id)) return;
        seen.add(id);
        if (known.has(id)) return ctx.report({ id, ...result });
        // Not found by discover (.each tables, template names): add it under its nearest discovered parent.
        let parentId;
        for (let n = names.length - 1; n > 0 && !parentId; n--) if (known.has(testId(rel, names.slice(0, n)))) parentId = testId(rel, names.slice(0, n));
        parentId ??= known.has(rel) ? rel : undefined;
        ctx.report({ id, ...result, label: names.at(-1), parentId, path: join(ctx.projectPath, rel), line });
      };
      // Node counts the test files themselves; leave them out so the percentage covers source files.
      const reportCoverage = (files) => ctx.reportCoverage?.(files.filter((f) => !known.has(toPosix(relative(ctx.projectPath, f.path)))));
      ctx.output(`Running ${RUNNERS[runner].label}…\n`);
      const run = { ...ctx, report, reportCoverage, node: nodeFor(saturn.storagePath, ctx.projectPath) };
      await (runner === 'node' ? runNode(run) : runWithJsonReport(runner, run));
      if (ctx.signal?.aborted) return;
      // Fail selected tests in files that didn't load; mark the rest, filtered out or renamed, as skipped.
      for (const id of ctx.ids ?? []) {
        if (seen.has(id)) continue;
        const message = fileErrors.get(id.slice(0, id.indexOf('::')));
        ctx.report(message ? { id, state: 'failed', message } : { id, state: 'skipped', message: 'The runner didn\'t report this test.' });
      }
      if (!ctx.ids) for (const [id, message] of fileErrors) ctx.output(`${id}: ${message}\n`);
    },
  });
}
