const LANGUAGES = ['javascript', 'typescript', 'typescriptreact'];
const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'return', 'function', 'new', 'typeof', 'await']);
const MODIFIERS = '(?:(?:export|default|declare|public|private|protected|static|readonly|abstract|override|async|get|set|accessor)\\s+)*';

const FUNCTION = new RegExp(`^${MODIFIERS}function\\s*\\*?\\s*[\\w$]*\\s*(?:<[^(]*>)?\\s*\\(`);
const ARROW = new RegExp(`^${MODIFIERS}(?:const|let|var)\\s+[\\w$]+\\s*(?::[^=]+)?=\\s*(?:async\\s+)?(?:function\\b[^(]*\\(|(?:<[^(]*>)?\\s*\\(|[\\w$]+\\s*=>)`);
const METHOD = new RegExp(`^${MODIFIERS}\\*?\\s*(#?[\\w$]+)\\s*\\??\\s*(?:<[^(]*>)?\\s*\\(`);
const DECLARATION = new RegExp(`^${MODIFIERS}(?:class|interface|type|enum|namespace|module|const|let|var)\\b`);

function matching(text, start, open, close) {
  let depth = 0;
  let quote = null;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '/' && text[i + 1] === '/') i = text.indexOf('\n', i) === -1 ? text.length : text.indexOf('\n', i);
    else if (c === '/' && text[i + 1] === '*') i = text.indexOf('*/', i) === -1 ? text.length : text.indexOf('*/', i) + 1;
    else if (open.includes(c)) depth++;
    else if (close.includes(c) && --depth === 0) return i;
  }
  return -1;
}

function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const c of text) {
    if ('([{<'.includes(c)) depth++;
    else if (')]}>'.includes(c)) depth--;
    if (c === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else current += c;
  }
  if (current.trim()) parts.push(current);
  return parts.map((p) => p.trim()).filter(Boolean);
}

function paramName(param, index) {
  const bare = param.replace(/^(?:public|private|protected|readonly|override)\s+/g, '').replace(/^\.\.\./, '');
  const match = /^([\w$]+)/.exec(bare);
  if (match) return match[1] === 'this' ? null : match[1];
  return index === 0 ? 'options' : `arg${index}`;
}

function stripNested(body) {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const rest = body.slice(i);
    const nested = /^(?:function\b[^{]*|=>\s*)\{/.exec(rest);
    if (nested && i > 0) {
      const brace = i + nested[0].length - 1;
      const end = matching(body, brace, '{', '}');
      if (end === -1) break;
      i = end;
      continue;
    }
    out += body[i];
  }
  return out;
}

function returnsValue(source, afterParams, ts) {
  const tail = source.slice(afterParams);
  const annotation = /^\s*:\s*([^{=]+?)\s*(?:=>|\{)/.exec(tail);
  if (ts && annotation) return !/^(?:void|never|Promise<void>|undefined)$/.test(annotation[1].trim());
  const arrow = /^\s*(?::[^=]+)?=>\s*(\{)?/.exec(tail);
  if (arrow && !arrow[1]) return true;
  const brace = source.indexOf('{', afterParams);
  if (brace === -1) return ts && Boolean(annotation);
  const end = matching(source, brace, '{', '}');
  const body = source.slice(brace + 1, end === -1 ? source.length : end);
  return /\breturn\s*[^\s;}]/.test(stripNested(body));
}

function functionDoc(source, ts) {
  const open = source.search(/\(|[\w$]+\s*=>/);
  let params;
  let afterParams;
  if (source[open] === '(') {
    const close = matching(source, open, '(', ')');
    if (close === -1) return null;
    params = splitTopLevel(source.slice(open + 1, close));
    afterParams = close + 1;
  } else {
    const single = /^([\w$]+)\s*/.exec(source.slice(open));
    params = [single[1]];
    afterParams = open + single[0].length;
  }
  let stop = 2;
  const lines = ['/**', ' * $1'];
  params.forEach((param, i) => {
    const name = paramName(param, i);
    if (!name) return;
    lines.push(ts ? ` * @param ${name} $${stop++}` : ` * @param {\${${stop++}:*}} ${name}`);
  });
  if (returnsValue(source, afterParams, ts)) lines.push(ts ? ` * @returns $${stop++}` : ` * @returns {\${${stop++}:*}}`);
  lines.push(' */');
  return lines.join('\n');
}

export function docCommentFor(text, line, ts) {
  const lines = text.split(/\r?\n/);
  let start = line + 1;
  while (start < lines.length && (!lines[start].trim() || lines[start].trim().startsWith('@'))) start++;
  if (start >= lines.length) return null;
  const first = lines[start].trim();
  const source = lines.slice(start).join('\n').trimStart();
  const method = METHOD.exec(first);
  if (FUNCTION.test(first) || ARROW.test(first) || (method && !KEYWORDS.has(method[1]))) {
    const head = ARROW.test(first) ? source.slice(source.indexOf('=') + 1) : source;
    return functionDoc(head, ts);
  }
  if (DECLARATION.test(first) || /^[\w$#]+\s*[?!]?\s*[:=;]/.test(first)) return '/**\n * $1\n */';
  return null;
}

export function registerDocComments(saturn) {
  if (!saturn.languages?.registerDocComment) return;
  for (const id of LANGUAGES) {
    const ts = id.startsWith('typescript');
    saturn.languages.registerDocComment(id, ({ text, line }) => docCommentFor(text, line, ts));
  }
}
