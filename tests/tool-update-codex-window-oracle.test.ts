import { expect, test } from 'vitest';
import { createWindowOracle, createWindowOracleBatch } from '../scripts/tool-update/codex-window-oracle.mjs';

test('the single connection limit applies across cases in the same batch', () => {
  const batch = createWindowOracleBatch();
  batch.createCase([{ input: 1, output: 1, cached: 0, reasoning: 0 }]).connect();
  expect(() => batch.createCase([{ input: 2, output: 2, cached: 0, reasoning: 0 }]).connect()).toThrow('connection_limit');
});

test('the ninth completed response is refused across independently created cases', () => {
  const batch = createWindowOracleBatch();
  for (let index = 0; index < 8; index++) {
    const connection = batch
      .createCase([
        {
          input: 1,
          output: 1,
          cached: 0,
          reasoning: 0
        }
      ])
      .connect();
    connection.receive(request());
    connection.start();
    connection.complete();
    connection.close();
  }
  const ninth = batch
    .createCase([
      {
        input: 1,
        output: 1,
        cached: 0,
        reasoning: 0
      }
    ])
    .connect();
  expect(() => ninth.receive(request())).toThrow('response_limit');
  expect(() => ninth.start()).toThrow('oracle_stopped');
});

const request = (
  headers = '',
  body = JSON.stringify({
    model: 'gpt-6.1-sol',
    reasoning: { effort: 'high' },
    stream: true,
    input: []
  })
) => Buffer.from(`POST /v1/responses HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: ${Buffer.byteLength(body)}\r\n${headers}\r\n${body}`);
const vectors = [
  { input: 40, output: 10, cached: 12, reasoning: 3 },
  { input: 70, output: 20, cached: 0, reasoning: 8 }
];

test('incremental HTTP produces separately released SSE phases and independent per-response usage', () => {
  const oracle = createWindowOracle(vectors);
  const connection = oracle.connect();
  const wire = request();
  for (const byte of wire) connection.receive(Buffer.from([byte]));
  const created = connection.start();
  expect(created.toString()).toContain('event: response.created');
  expect(created.toString()).not.toContain('input_tokens');
  const completed = connection.complete();
  expect(completed.toString()).toContain('"input_tokens":40');
  expect(completed.toString()).toContain('"output_tokens":10');
  expect(() => connection.complete()).toThrow('response_state');
  connection.close();
  const second = oracle.connect();
  second.receive(request());
  second.start();
  second.complete();
  second.close();
  expect(oracle.summary()).toMatchObject({
    origin: 'synthetic',
    actual_qualification: false,
    requests: 2,
    completed: 2,
    input_tokens: 110,
    output_tokens: 30,
    cached_input_tokens: 12,
    reasoning_tokens: 11,
    stopped: false
  });
});

test.each([
  ['Upgrade: websocket\r\nConnection: Upgrade\r\n', 'protocol_refused'],
  ['Content-Encoding: gzip\r\n', 'compression_refused'],
  ['Content-Encoding: br\r\n', 'compression_refused'],
  ['Transfer-Encoding: chunked\r\n', 'framing_refused'],
  ['Content-Length: 1\r\n', 'framing_refused']
])('refuses %s before accepting body bytes', (headers, code) => {
  const oracle = createWindowOracle(vectors);
  const connection = oracle.connect();
  const header = request(headers).subarray(0, request(headers).indexOf('\r\n\r\n') + 4);
  expect(() => connection.receive(header)).toThrow(code);
  expect(oracle.summary()).toMatchObject({
    requests: 0,
    completed: 0,
    stopped: true,
    buffered_body_bytes: 0
  });
  expect(() => oracle.connect()).toThrow('oracle_stopped');
});

test.each(['CONNECT example.invalid:443 HTTP/1.1', 'PRI * HTTP/2.0'])('refuses tunnel or HTTP2 preface %s', line => {
  const oracle = createWindowOracle(vectors);
  const connection = oracle.connect();
  expect(() => connection.receive(Buffer.from(`${line}\r\n\r\n`))).toThrow('protocol_refused');
  expect(oracle.summary()).toMatchObject({
    buffered_body_bytes: 0,
    stopped: true
  });
});

test.each([Buffer.alloc(16385, 65), Buffer.from('POST /v1/responses HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 65537\r\n\r\n')])(
  'bounds headers and declared body before body allocation',
  wire => {
    const oracle = createWindowOracle(vectors);
    const connection = oracle.connect();
    expect(() => connection.receive(wire)).toThrow(/wire_limit|body_limit/);
    expect(oracle.summary()).toMatchObject({
      buffered_body_bytes: 0,
      stopped: true
    });
  }
);

test('refuses overlapping connections and permanently stops the case', () => {
  const oracle = createWindowOracle(vectors);
  oracle.connect();
  expect(() => oracle.connect()).toThrow('connection_limit');
  expect(oracle.summary().stopped).toBe(true);
});

test('counts incomplete attempts and refuses the seventeenth connection', () => {
  const oracle = createWindowOracle(vectors);
  for (let index = 0; index < 16; index++) oracle.connect().close();
  expect(() => oracle.connect()).toThrow('connection_limit');
  expect(oracle.summary()).toMatchObject({
    connections: 17,
    completed: 0,
    stopped: true
  });
});

test('an interrupted response retains missing terminal usage instead of a completed zero', () => {
  const oracle = createWindowOracle(vectors);
  const connection = oracle.connect();
  connection.receive(request());
  connection.start();
  connection.close();
  expect(oracle.summary()).toMatchObject({
    requests: 1,
    completed: 0,
    terminal_usage: 'missing',
    input_tokens: null,
    output_tokens: null
  });
});

test.each([
  { model: 'wrong', reasoning: { effort: 'high' }, stream: true, input: [] },
  {
    model: 'gpt-6.1-sol',
    reasoning: { effort: 'low' },
    stream: true,
    input: []
  },
  {
    model: 'gpt-6.1-sol',
    reasoning: { effort: 'high' },
    stream: true,
    input: [],
    tools: [{}]
  }
])('unexpected model, effort or tool receives no response', body => {
  const oracle = createWindowOracle(vectors);
  const connection = oracle.connect();
  expect(() => connection.receive(request('', JSON.stringify(body)))).toThrow('request_refused');
  expect(() => connection.start()).toThrow('oracle_stopped');
});

test('subset and usage limits are enforced without summing cache or reasoning twice', () => {
  expect(() => createWindowOracle([{ input: 1, output: 1, cached: 2, reasoning: 0 }])).toThrow('usage_invalid');
  expect(() =>
    createWindowOracle([
      {
        input: 4000,
        output: 1,
        cached: 0,
        reasoning: 0
      }
    ])
  ).toThrow('usage_invalid');
  expect(() => createWindowOracle([{ input: 1, output: 1, cached: 0, reasoning: -1 }])).toThrow('usage_invalid');
});
