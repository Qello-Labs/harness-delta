import { createServer } from 'node:http';
import { EventEmitter, once } from 'node:events';
import { closeListener, ConformanceError, requireCondition } from './fixtures.mjs';

export const usage = Object.freeze({ input_tokens: 101, output_tokens: 111, cache_read_input_tokens: 23,
  cache_creation_input_tokens: 11, cache_creation: Object.freeze({ ephemeral_5m_input_tokens: 7, ephemeral_1h_input_tokens: 4 }) });

/** The wire fixture retains only an independent numeric request ledger. */
export async function startStub(command, interrupted, callbacks = {}) {
  const events = new EventEmitter(), ledger = [], sockets = new Set();
  let rootStep = 0, serial = 0, failed = false;
  const fail = () => { failed = true; events.emit('contract_failure'); };
  const server = createServer(async (req, res) => {
    try {
      requireCondition(req.method === 'POST' && /^\/v1\/messages(?:\?beta=true)?$/.test(req.url), 'stub_contract');
      let size = 0, chunks = [];
      for await (const bytes of req) {
        size += bytes.length; requireCondition(size <= 8 * 1048576, 'stub_contract'); chunks.push(bytes);
      }
      const body = JSON.parse(Buffer.concat(chunks)); chunks = [];
      const texts = (body.messages ?? []).filter(m => m.role === 'user').flatMap(m =>
        typeof m.content === 'string' ? [m.content] : (m.content ?? []).filter(c => c.type === 'text').map(c => c.text));
      const owners = ['CONFORMANCE_CHILD_A', 'CONFORMANCE_CHILD_B'].flatMap((marker, index) =>
        texts.some(text => typeof text === 'string' && text.includes(marker)) ? [`child-${index + 1}`] : []);
      requireCondition(owners.length <= 1, 'stub_contract');
      const owner = owners[0] ?? 'root', step = owner === 'root' ? ++rootStep : 0;
      requireCondition(++serial <= 6 && step <= 4 &&
        (owner === 'root' || !ledger.some(r => r.owner === owner)), 'stub_contract');
      const requestId = `req_conformance_${serial}`, messageId = `msg_conformance_${serial}`;
      const partial = interrupted && step === 4;
      ledger.push({ requestId, owner, status: partial ? 'partial' : 'terminal',
        counters: partial ? { ...usage, output_tokens: 16 } : usage });
      if (step === 2) { events.emit('baseline'); await callbacks.baseline?.(); }
      if (owner !== 'root') { events.emit('member'); await callbacks.member?.(); }
      let tool;
      if (step === 1) tool = { name: 'Bash', input: { command, description: 'Connect synthetic task' } };
      if (step === 2 || step === 3) tool = { name: 'Agent', input: {
        subagent_type: 'qualification-child', model: 'sonnet', description: 'Synthetic acknowledgment',
        run_in_background: false, prompt: step === 2
          ? 'CONFORMANCE_CHILD_A Acknowledge only, do not read files or call tools.'
          : 'CONFORMANCE_CHILD_B Acknowledge only, do not read files or call tools.' } };
      res.writeHead(200, { 'content-type': 'text/event-stream', 'request-id': requestId, 'cache-control': 'no-cache' });
      const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      send('message_start', { message: { id: messageId, type: 'message', role: 'assistant', content: [],
        model: body.model, stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 0 } } });
      send('content_block_start', { index: 0, content_block: tool
        ? { type: 'tool_use', id: `toolu_conformance_${serial}`, name: tool.name, input: {} } : { type: 'text', text: '' } });
      send('content_block_delta', { index: 0, delta: tool
        ? { type: 'input_json_delta', partial_json: JSON.stringify(tool.input) }
        : { type: 'text_delta', text: 'Synthetic acknowledgment.' } });
      if (partial) {
        send('message_delta', { delta: { stop_reason: null, stop_sequence: null }, usage: { ...usage, output_tokens: 16 } });
        events.emit('partial'); await callbacks.partial?.(); return;
      }
      send('content_block_stop', { index: 0 });
      send('message_delta', { delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage });
      send('message_stop', {}); res.end();
    } catch { res.destroy(); fail(); }
  });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.on('connect', (_req, socket) => { socket.destroy(); fail(); });
  server.on('clientError', (_error, socket) => { socket.destroy(); fail(); });
  callbacks.subscribe?.(events);
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await listening;
  return { endpoint: `http://127.0.0.1:${server.address().port}`, events, ledger,
    assertHealthy: () => { if (failed) throw new ConformanceError('stub_contract'); },
    close: () => closeListener(server, sockets) };
}
