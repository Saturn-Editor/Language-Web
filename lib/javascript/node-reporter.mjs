import { inspect } from 'node:util';

/** node --test reporter: one JSON line per test start/pass/fail, read back by lib/tests.js. */
export default async function* reporter(source) {
  for await (const { type, data } of source) {
    if (type !== 'test:start' && type !== 'test:pass' && type !== 'test:fail') continue;
    const error = data.details?.error;
    yield `${JSON.stringify({
      type,
      name: data.name,
      nesting: data.nesting,
      file: data.file,
      line: data.line,
      suite: data.details?.type === 'suite',
      skip: data.skip !== undefined,
      todo: data.todo !== undefined,
      durationMs: data.details?.duration_ms,
      error: error && inspect(error.cause ?? error, { colors: false }),
    })}\n`;
  }
}
