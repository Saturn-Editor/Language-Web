/**
 * Joins several stdio LSP servers into one, since a Saturn module declares a single languageServer.
 * A document can belong to more than one server (e.g. HTML plus Tailwind): its notifications go to all of
 * them, requests that can be combined (completion, hover, code actions, colors) go to all and get one merged
 * reply, and anything else goes to the first. Lifecycle messages go to every server, and initialize and
 * shutdown get one merged reply. Requests the servers send to the client get a tagged id so the client's
 * response finds its way back, and items that come back for a later …/resolve request get a tagged `data`
 * so the resolve reaches the server that made them. Diagnostics are kept per server and published together.
 */

/** Calls `onMessage` for each Content-Length framed JSON message read from `stream`. */
export function readMessages(stream, onMessage) {
  let buffer = Buffer.alloc(0);
  stream.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const length = Number(/content-length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString('ascii'))?.[1]);
      const start = headerEnd + 4;
      if (!Number.isFinite(length)) {
        buffer = buffer.subarray(start); // malformed header: skip it
        continue;
      }
      if (buffer.length < start + length) return;
      const body = buffer.subarray(start, start + length).toString('utf8');
      buffer = buffer.subarray(start + length);
      try {
        onMessage(JSON.parse(body));
      } catch (e) {
        process.stderr.write(`[web] Dropped unreadable LSP message: ${e.message}\n`);
      }
    }
  });
}

export function writeMessage(stream, message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  stream.write(`Content-Length: ${body.length}\r\n\r\n`);
  stream.write(body);
}

/** Arrays are unioned and objects merged; for anything else the first defined value wins. */
export function mergeCapabilities(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) return [...new Set([...a, ...b])];
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const out = { ...b };
    for (const [k, v] of Object.entries(a)) out[k] = k in b ? mergeCapabilities(v, b[k]) : v;
    return out;
  }
  if (a === undefined || a === null || a === false) return b ?? a;
  return a;
}

const BROADCAST = new Set(['initialize', 'shutdown']);

/** Document requests sent to every server that owns the document, and how their replies combine (in owner order). */
const FAN_OUT = {
  'textDocument/completion': (results) => {
    const lists = results.filter(Boolean).map((r) => (Array.isArray(r) ? { isIncomplete: false, items: r } : r));
    if (!lists.length) return null;
    return { isIncomplete: lists.some((l) => l.isIncomplete), items: lists.flatMap((l) => l.items ?? []) };
  },
  'textDocument/hover': (results) => results.find(Boolean) ?? null,
  'textDocument/codeAction': (results) => results.flatMap((r) => r ?? []),
  'textDocument/documentColor': (results) => results.flatMap((r) => r ?? []),
};

/** Requests whose reply items carry `data` the server needs back in a later resolve request. */
const RESOLVABLE = {
  'textDocument/completion': (result, tagItem) => (Array.isArray(result) ? result.map(tagItem) : result && { ...result, items: result.items?.map(tagItem) }),
  'completionItem/resolve': (result, tagItem) => result && tagItem(result),
  'textDocument/codeAction': (result, tagItem) => result?.map(tagItem),
  'codeAction/resolve': (result, tagItem) => result && tagItem(result),
  'textDocument/codeLens': (result, tagItem) => result?.map(tagItem),
  'codeLens/resolve': (result, tagItem) => result && tagItem(result),
  'textDocument/documentLink': (result, tagItem) => result?.map(tagItem),
  'documentLink/resolve': (result, tagItem) => result && tagItem(result),
  'textDocument/inlayHint': (result, tagItem) => result?.map(tagItem),
  'inlayHint/resolve': (result, tagItem) => result && tagItem(result),
};

const RESOLVE = new Set(Object.keys(RESOLVABLE).filter((m) => m.endsWith('/resolve')));

/**
 * @param {{ write(message): void }} client
 * @param {Record<string, { write(message): void }>} servers keyed by tag, e.g. { html, css, ts }
 * @param {(uri: string) => string | string[]} route the tags of the servers that own a document, main one first
 * @param {string} fallback the tag that gets requests without a document, e.g. workspace/symbol
 * @param {Record<string, object>} initializationOptions per tag
 * @returns handlers to call with messages from the client and from each server
 */
export function createMux({ client, servers, route, fallback, initializationOptions = {} }) {
  const tags = Object.keys(servers);
  const owners = (uri) => [route(uri)].flat().filter((tag) => servers[tag]);
  const merging = new Map(); // client request id (JSON) → { tags, results: Map(tag → result), answered: Set(tag), error, combine }
  const methods = new Map(); // `${tag}|${client request id (JSON)}` → method, for requests whose replies get tagged
  const diagnostics = new Map(); // uri → Map(tag → diagnostics)
  const legends = new Map();
  const tokenRequests = new Map();
  let tokenMaps = null;

  const tagItem = (tag) => (item) => (item && item.data !== undefined ? { ...item, data: { $mux: tag, data: item.data } } : item);

  function send(tag, msg) {
    if (msg.id !== undefined && msg.method?.startsWith('textDocument/semanticTokens/')) tokenRequests.set(`${tag}|${JSON.stringify(msg.id)}`, true);
    if (msg.id !== undefined && RESOLVABLE[msg.method]) methods.set(`${tag}|${JSON.stringify(msg.id)}`, msg.method);
    servers[tag].write(msg);
  }

  function fromClient(msg) {
    const isResponse = msg.id !== undefined && msg.method === undefined;
    if (isResponse) {
      // A response to a server's request: the id carries the server tag.
      const [tag, original] = typeof msg.id === 'string' ? splitId(msg.id) : [];
      if (tag && servers[tag]) servers[tag].write({ ...msg, id: original });
      return;
    }
    if (msg.id !== undefined && BROADCAST.has(msg.method)) {
      merging.set(JSON.stringify(msg.id), { tags, results: new Map(), answered: new Set(), error: null, combine: (results) => results.reduce((a, b) => mergeCapabilities(a, b)) });
      for (const tag of tags) {
        const params =
          msg.method === 'initialize'
            ? { ...msg.params, initializationOptions: { ...initializationOptions[tag], ...msg.params?.initializationOptions } }
            : msg.params;
        servers[tag].write({ ...msg, params });
      }
      return;
    }
    if (msg.id !== undefined && RESOLVE.has(msg.method)) {
      const { $mux: tag, data } = msg.params?.data ?? {};
      if (tag && servers[tag]) return send(tag, { ...msg, params: { ...msg.params, data } });
    }
    const uri = msg.params?.textDocument?.uri;
    if (uri) {
      const [main, ...rest] = owners(uri);
      if (!main) return msg.id !== undefined && client.write({ jsonrpc: '2.0', id: msg.id, result: null });
      if (msg.id === undefined) return [main, ...rest].forEach((tag) => servers[tag].write(msg)); // didOpen, didChange…
      if (rest.length && FAN_OUT[msg.method]) {
        merging.set(JSON.stringify(msg.id), { tags: [main, ...rest], results: new Map(), answered: new Set(), error: null, combine: FAN_OUT[msg.method] });
        for (const tag of [main, ...rest]) send(tag, msg);
        return;
      }
      return send(main, msg);
    }
    if (msg.id !== undefined) return send(fallback, msg); // e.g. workspace/symbol
    for (const tag of tags) servers[tag].write(msg); // notifications: initialized, exit, $/cancelRequest, config changes
  }

  function fromServer(tag, msg) {
    const isResponse = msg.id !== undefined && msg.method === undefined;
    if (isResponse) {
      const key = JSON.stringify(msg.id);
      const method = methods.get(`${tag}|${key}`);
      if (method) {
        methods.delete(`${tag}|${key}`);
        if (!msg.error) msg = { ...msg, result: RESOLVABLE[method](msg.result, tagItem(tag)) };
      }
      if (tokenRequests.delete(`${tag}|${key}`) && msg.result?.data) msg = { ...msg, result: { ...msg.result, data: remapTokens(tag, msg.result.data) } };
      const pending = merging.get(key);
      if (!pending) return client.write(msg);
      pending.answered.add(tag);
      if (msg.error) pending.error ??= msg.error;
      else pending.results.set(tag, msg.result);
      const legend = msg.result?.capabilities?.semanticTokensProvider?.legend;
      if (legend) legends.set(tag, legend);
      if (pending.answered.size < pending.tags.length) return;
      merging.delete(key);
      const results = pending.tags.filter((t) => pending.results.has(t)).map((t) => pending.results.get(t));
      if (pending.error && results.length === 0) return client.write({ jsonrpc: '2.0', id: msg.id, error: pending.error });
      const combined = pending.combine(results) ?? null;
      const merged = combined?.capabilities?.semanticTokensProvider?.legend;
      if (merged) tokenMaps = buildTokenMaps(legends, merged);
      return client.write({ jsonrpc: '2.0', id: msg.id, result: combined });
    }
    if (msg.id !== undefined) return client.write({ ...msg, id: `${tag}|${JSON.stringify(msg.id)}` });
    if (msg.method === 'textDocument/publishDiagnostics' && msg.params?.uri) {
      // Each server publishes the full set for a document, which would replace the others' on the client.
      const byTag = diagnostics.get(msg.params.uri) ?? new Map();
      byTag.set(tag, msg.params.diagnostics ?? []);
      diagnostics.set(msg.params.uri, byTag);
      return client.write({ ...msg, params: { ...msg.params, diagnostics: [...byTag.values()].flat() } });
    }
    client.write(msg);
  }

  function remapTokens(tag, data) {
    const map = tokenMaps?.get(tag);
    if (!map) return data;
    const out = data.slice();
    for (let i = 0; i + 4 < out.length; i += 5) {
      out[i + 3] = map.types[out[i + 3]] ?? out[i + 3];
      let bits = 0;
      for (let b = 0, m = out[i + 4]; m; b++, m >>>= 1) if (m & 1) bits |= 1 << (map.modifiers[b] ?? b);
      out[i + 4] = bits;
    }
    return out;
  }

  return { fromClient, fromServer };
}

function buildTokenMaps(legends, merged) {
  const maps = new Map();
  for (const [tag, legend] of legends) {
    maps.set(tag, {
      types: (legend.tokenTypes ?? []).map((t) => merged.tokenTypes.indexOf(t)),
      modifiers: (legend.tokenModifiers ?? []).map((m) => merged.tokenModifiers.indexOf(m)),
    });
  }
  return maps;
}

function splitId(id) {
  const bar = id.indexOf('|');
  if (bar < 0) return [];
  try {
    return [id.slice(0, bar), JSON.parse(id.slice(bar + 1))];
  } catch {
    return [];
  }
}
