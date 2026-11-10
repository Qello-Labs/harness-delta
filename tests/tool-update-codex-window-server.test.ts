import { channel } from 'node:diagnostics_channel';
import { once } from 'node:events';
import { Socket } from 'node:net';
import { afterEach, expect, test } from 'vitest';
import { createWindowOracleBatch, createWindowOracleServer } from '../scripts/tool-update/codex-window-oracle.mjs';

const servers: ReturnType<typeof createWindowOracleServer>[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
});
function fixture() {
  const server = createWindowOracleServer(
    [
      {
        input: 40,
        output: 10,
        cached: 12,
        reasoning: 3
      }
    ],
    { port: 0, timeoutMs: 5000 }
  );
  servers.push(server);
  return server;
}
async function client(port: number) {
  const socket = new Socket();
  const connected = once(socket, 'connect', {
    signal: AbortSignal.timeout(3000)
  });
  let body = '';
  const closed = new Promise<string>(resolve => {
    socket.on('data', (bytes: Buffer) => {
      body += bytes.toString('utf8');
    });
    socket.on('error', () => {
      /* The peer may reset rejected traffic. */
    });
    socket.once('close', () => resolve(body));
  });
  socket.connect(port, '127.0.0.1');
  await connected;
  return { socket, closed };
}
function request(extraHeaders = '') {
  const body = JSON.stringify({
    model: 'gpt-6.1-sol',
    reasoning: { effort: 'high' },
    stream: true,
    input: []
  });
  return `POST /v1/responses HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: ${Buffer.byteLength(body)}\r\n${extraHeaders}\r\n${body}`;
}

test('a bind failure stops the existing batch listener instead of leaving it available', async () => {
  const batch = createWindowOracleBatch();
  const vectors = [{ input: 1, output: 1, cached: 0, reasoning: 0 }];
  const first = batch.createServer(vectors, { port: 0, timeoutMs: 5000 });
  const port = await first.listen();
  const conflicting = batch.createServer(vectors, { port, timeoutMs: 5000 });
  servers.push(first, conflicting);
  await expect(conflicting.listen()).rejects.toThrow('oracle_bind_failed');
  await expect(client(port)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  expect(first.summary().stopped).toBe(true);
  expect(() => batch.createCase(vectors)).toThrow('oracle_stopped');
});

test('an abort during pending bind cannot leave a newly bound listener outside terminal cleanup', async () => {
  const batch = createWindowOracleBatch();
  const controller = new AbortController();
  const vectors = [{ input: 1, output: 1, cached: 0, reasoning: 0 }];
  const server = batch.createServer(vectors, {
    port: 0,
    timeoutMs: 5000,
    signal: controller.signal
  });
  servers.push(server);
  const listening = server.listen();
  controller.abort();
  await expect(listening).rejects.toThrow('oracle_stopped');
  await server.close();
  expect(server.summary()).toMatchObject({
    stopped: true,
    listener_closed: true
  });
  expect(() => batch.createCase(vectors)).toThrow('oracle_stopped');
});

test.each(['deadline', 'protocol'])('a %s failure stops sibling listeners, accepted sockets and future batch work', async fault => {
  const batch = createWindowOracleBatch();
  const controller = new AbortController();
  const vectors = [{ input: 1, output: 1, cached: 0, reasoning: 0 }];
  const first = batch.createServer(vectors, {
    port: 0,
    timeoutMs: 5000,
    signal: controller.signal
  });
  const second = batch.createServer(vectors, {
    port: 0,
    timeoutMs: 5000
  });
  servers.push(first, second);
  const firstPort = await first.listen();
  const secondPort = await second.listen();
  const target = fault === 'deadline' ? second : first;
  const peer = await client(fault === 'deadline' ? secondPort : firstPort);
  const peerClosed = once(peer.socket, 'close', {
    signal: AbortSignal.timeout(1000)
  });
  const refused = once(first.events, 'refused', {
    signal: AbortSignal.timeout(1000)
  });
  if (fault === 'deadline') {
    const received = once(target.events, 'request', {
      signal: AbortSignal.timeout(1000)
    });
    peer.socket.write(request());
    await received;
    controller.abort();
  } else peer.socket.write(request('Content-Encoding: gzip\r\n'));
  await refused;
  await peerClosed;
  expect(first.summary().stopped).toBe(true);
  expect(second.summary().stopped).toBe(true);
  await expect(client(secondPort)).rejects.toMatchObject({
    code: 'ECONNREFUSED'
  });
  expect(() => batch.createServer(vectors, { port: 0, timeoutMs: 5000 })).toThrow('oracle_stopped');
  expect(() => batch.createCase(vectors)).toThrow('oracle_stopped');
  await expect(second.start()).rejects.toThrow();
});

test('ordinary successful case closure does not stop the remaining batch cases', async ({ onTestFinished }) => {
  const batch = createWindowOracleBatch();
  const vectors = [{ input: 1, output: 1, cached: 0, reasoning: 0 }];
  for (let index = 0; index < 2; index += 1) {
    const server = batch.createServer(vectors, {
      port: 0,
      timeoutMs: 5000
    });
    servers.push(server);
    const port = await server.listen();
    const connections = channel('net.server.socket');
    const accepted = new Promise<Socket>(resolve => {
      const observe = (message: unknown) => {
        if (typeof message === 'object' && message !== null && 'socket' in message && message.socket instanceof Socket && message.socket.localPort === port) {
          resolve(message.socket);
        }
      };
      connections.subscribe(observe);
      onTestFinished(() => connections.unsubscribe(observe));
    });
    const peer = await client(port);
    const socket = await accepted;
    const received = once(server.events, 'request', {
      signal: AbortSignal.timeout(1000)
    });
    peer.socket.write(request());
    await received;
    await server.start();
    const closed = once(socket, 'close', {
      signal: AbortSignal.timeout(1000)
    });
    await server.complete();
    await peer.closed;
    await server.close();
    // Listener closure can precede the socket's batch-admission release.
    await closed;
    expect(server.summary()).toMatchObject({
      completed: 1,
      stopped: false,
      listener_closed: true
    });
  }
});

test('separate case listeners share batch connection admission instead of resetting the batch', async () => {
  const batch = createWindowOracleBatch();
  const first = batch.createServer(
    [
      {
        input: 1,
        output: 1,
        cached: 0,
        reasoning: 0
      }
    ],
    { port: 0, timeoutMs: 5000 }
  );
  const second = batch.createServer(
    [
      {
        input: 1,
        output: 1,
        cached: 0,
        reasoning: 0
      }
    ],
    { port: 0, timeoutMs: 5000 }
  );
  servers.push(first, second);
  const firstPort = await first.listen();
  const secondPort = await second.listen();
  const requestObserved = once(first.events, 'request', {
    signal: AbortSignal.timeout(3000)
  });
  const one = await client(firstPort);
  one.socket.write(request());
  await requestObserved;
  const refused = once(second.events, 'refused', {
    signal: AbortSignal.timeout(3000)
  });
  const two = await client(secondPort);
  expect(await refused).toEqual(['connection_limit']);
  await two.closed;
  await first.close();
  await one.closed;
});

test('real IPv4 loopback sockets receive independently released SSE phases and close cleanly', async () => {
  const server = fixture();
  const port = await server.listen();
  const started = once(server.events, 'request', {
    signal: AbortSignal.timeout(3000)
  });
  const peer = await client(port);
  peer.socket.write(request());
  await started;
  await server.start();
  await server.complete();
  const wire = await peer.closed;
  expect(wire).toContain('HTTP/1.1 200 OK');
  expect(wire).toContain('event: response.created');
  expect(wire).toContain('"input_tokens":40');
  expect(wire).toContain('"output_tokens":10');
  await server.close();
  expect(server.summary()).toMatchObject({
    completed: 1,
    input_tokens: 40,
    output_tokens: 10,
    listener_closed: true
  });
});

test.each([
  ['Upgrade: websocket\r\nConnection: Upgrade\r\n', 'protocol_refused'],
  ['Content-Encoding: gzip\r\n', 'compression_refused'],
  ['Content-Encoding: br\r\n', 'compression_refused'],
  ['Transfer-Encoding: chunked\r\n', 'framing_refused']
])('the real listener refuses %s without body buffering', async (headers, code) => {
  const server = fixture();
  const port = await server.listen();
  const refused = once(server.events, 'refused', {
    signal: AbortSignal.timeout(3000)
  });
  const peer = await client(port);
  peer.socket.write(request(headers));
  expect(await refused).toEqual([code]);
  expect(await peer.closed).toBe('');
  await server.close();
  expect(server.summary()).toMatchObject({
    stopped: true,
    buffered_body_bytes: 0,
    listener_closed: true
  });
});

test.each(['CONNECT example.invalid:443 HTTP/1.1\r\n\r\n', 'PRI * HTTP/2.0\r\n\r\n', 'x'.repeat(16385)])(
  'the real listener refuses tunnels, HTTP2 and oversized framing %#',
  async wire => {
    const server = fixture();
    const port = await server.listen();
    const refused = once(server.events, 'refused', {
      signal: AbortSignal.timeout(3000)
    });
    const peer = await client(port);
    peer.socket.write(wire);
    await refused;
    expect(await peer.closed).toBe('');
    await server.close();
    expect(server.summary()).toMatchObject({
      completed: 0,
      buffered_body_bytes: 0,
      listener_closed: true
    });
  }
);

test('a frozen-port conflict refuses without selecting a replacement endpoint', async () => {
  const first = fixture();
  const port = await first.listen();
  const second = createWindowOracleServer(
    [
      {
        input: 1,
        output: 1,
        cached: 0,
        reasoning: 0
      }
    ],
    { port, timeoutMs: 5000 }
  );
  servers.push(second);
  await expect(second.listen()).rejects.toThrow('oracle_bind_failed');
});

test('a prearmed deadline abort closes the listener and every accepted socket', async () => {
  const controller = new AbortController();
  const server = createWindowOracleServer(
    [
      {
        input: 1,
        output: 1,
        cached: 0,
        reasoning: 0
      }
    ],
    { port: 0, timeoutMs: 5000, signal: controller.signal }
  );
  servers.push(server);
  const port = await server.listen();
  const peer = await client(port);
  const refused = once(server.events, 'refused', {
    signal: AbortSignal.timeout(3000)
  });
  controller.abort();
  expect(await refused).toEqual(['deadline_exceeded']);
  await peer.closed;
  await server.close();
  expect(server.summary().listener_closed).toBe(true);
});
