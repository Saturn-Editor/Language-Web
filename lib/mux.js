/**
 * Joins several stdio LSP servers into one, since a Saturn module declares a single languageServer.
 * Document requests go to the server for the document's language; lifecycle messages go to all,
 * and requests sent to all (initialize, shutdown) get one merged reply. Requests the servers send to
 * the client get a tagged id so the client's response finds its way back.
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

/**
 * @param {{ write(message): void }} client
 * @param {Record<string, { write(message): void }>} servers keyed by tag, e.g. { html, css, ts }
 * @param {(uri: string) => string} route the tag of the server that owns a document
 * @param {Record<string, object>} initializationOptions per tag
 * @returns handlers to call with messages from the client and from each server
 */
export function createMux({ client, servers, route, fallback, initializationOptions = {} }) {
  const tags = Object.keys(servers);
  const merging = new Map(); // client request id (JSON) → { remaining, results, error }

  function fromClient(msg) {
    const isResponse = msg.id !== undefined && msg.method === undefined;
    if (isResponse) {
      // A response to a server's request: the id carries the server tag.
      const [tag, original] = typeof msg.id === 'string' ? splitId(msg.id) : [];
      if (tag && servers[tag]) servers[tag].write({ ...msg, id: original });
      return;
    }
    if (msg.id !== undefined && BROADCAST.has(msg.method)) {
      merging.set(JSON.stringify(msg.id), { remaining: tags.length, results: [], error: null });
      for (const tag of tags) {
        const params =
          msg.method === 'initialize'
            ? { ...msg.params, initializationOptions: { ...initializationOptions[tag], ...msg.params?.initializationOptions } }
            : msg.params;
        servers[tag].write({ ...msg, params });
      }
      return;
    }
    const uri = msg.params?.textDocument?.uri;
    if (uri) return servers[route(uri)].write(msg);
    if (msg.id !== undefined) return servers[fallback].write(msg); // e.g. workspace/symbol
    for (const tag of tags) servers[tag].write(msg); // notifications: initialized, exit, $/cancelRequest, config changes
  }

  function fromServer(tag, msg) {
    const isResponse = msg.id !== undefined && msg.method === undefined;
    if (isResponse) {
      const key = JSON.stringify(msg.id);
      const pending = merging.get(key);
      if (!pending) return client.write(msg);
      pending.remaining--;
      if (msg.error) pending.error ??= msg.error;
      else pending.results.push(msg.result);
      if (pending.remaining > 0) return;
      merging.delete(key);
      if (pending.error && pending.results.length === 0) return client.write({ jsonrpc: '2.0', id: msg.id, error: pending.error });
      return client.write({ jsonrpc: '2.0', id: msg.id, result: pending.results.reduce((a, b) => mergeCapabilities(a, b)) ?? null });
    }
    if (msg.id !== undefined) return client.write({ ...msg, id: `${tag}|${JSON.stringify(msg.id)}` });
    client.write(msg);
  }

  return { fromClient, fromServer };
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
