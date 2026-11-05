import { request } from 'node:http';
import { expect, test } from 'vitest';
import { ClaudeTraceCandidateReceiver } from '../../src/qualification/claude-trace-candidate-receiver.js';
import { Store } from '../../src/store.js';
import { receivedAt, seedTraceScope, startedAt, traceScope, traces } from '../helpers/claude-trace-fixture.js';

async function fixture(maxBodyBytes?: number) {
  const store = new Store(':memory:');
  seedTraceScope(store);
  let now = startedAt;
  const receiver = await ClaudeTraceCandidateReceiver.start(store, traceScope, { clock: () => now, ...(maxBodyBytes ? { maxBodyBytes } : {}) });
  now = receivedAt;
  const post = (body: string = JSON.stringify(traces()), headers = receiver.exporterHeaders(), path = '/v1/traces') =>
    fetch(receiver.endpoint + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  return {
    store,
    receiver,
    post,
    cleanup: async () => {
      await receiver.close();
      store.close();
    }
  };
}
test('isolated synthetic loopback receiver feeds trace parser once and acknowledges only committed batch', async () => {
  const f = await fixture();
  try {
    expect(f.receiver.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect((await f.post()).status).toBe(200);
    expect((await f.post()).status).toBe(200);
    expect(f.store.eventCount()).toBe(2);
    expect(f.store.all('SELECT * FROM otel_processes')).toEqual([]);
    expect(f.store.all('SELECT * FROM observation_runs')).toEqual([]);
  } finally {
    await f.cleanup();
  }
});
test('missing/wrong process token rejects undecodable bodies before parser and stores no rejection', async () => {
  const f = await fixture();
  try {
    expect((await f.post('PRIVATE_SENTINEL invalid-json', {})).status).toBe(401);
    expect((await f.post('PRIVATE_SENTINEL invalid-json', { 'x-harness-delta-token': 'foreign' })).status).toBe(401);
    expect(f.store.eventCount()).toBe(0);
    expect(f.store.all('SELECT * FROM observation_gaps')).toEqual([]);
  } finally {
    await f.cleanup();
  }
});
test.each(['paused', 'finalized', 'deleted', 'generation', 'child-tombstone'] as const)(
  'revoked %s scope rejects before decoding even malformed JSON',
  async reason => {
    const f = await fixture();
    try {
      if (reason === 'deleted') f.store.execute("DELETE FROM tasks WHERE id='task-1'", []);
      else if (reason === 'generation') f.store.execute("UPDATE tasks SET generation=1 WHERE id='task-1'", []);
      else if (reason === 'child-tombstone') f.store.execute("INSERT INTO tombstones(kind,id,deleted_at) VALUES ('session','child',?)", [receivedAt]);
      else f.store.execute('UPDATE tasks SET state=? WHERE id=?', [reason, 'task-1']);
      expect((await f.post('PRIVATE_SENTINEL invalid-json')).status).toBe(403);
      expect(f.store.eventCount()).toBe(0);
    } finally {
      await f.cleanup();
    }
  }
);
test('protocol/size/malformed rejection creates no usage; log route cannot double count', async () => {
  const f = await fixture(1024);
  try {
    expect((await f.post('invalid-json')).status).toBe(400);
    expect((await f.post('x'.repeat(1025))).status).toBe(413);
    expect((await f.post('{}', undefined, '/v1/logs')).status).toBe(404);
    const response = await fetch(f.receiver.endpoint + '/v1/traces', {
      method: 'POST',
      headers: { ...f.receiver.exporterHeaders(), 'content-type': 'application/x-protobuf' },
      body: 'bytes'
    });
    expect(response.status).toBe(415);
    expect(f.store.eventCount()).toBe(0);
  } finally {
    await f.cleanup();
  }
});
test('mapping/production channel disagreement prevents listening', async () => {
  const store = new Store(':memory:');
  seedTraceScope(store);
  try {
    store.execute(
      "INSERT INTO otel_processes(id,run_id,project_id,task_id,launch_session_id,product,product_version,profile_id,generation,state,ordering,started_at,updated_at) VALUES ('p','r','project-1','task-1','root','claude_code','2.1.288','synthetic-profile',0,'listening','pending',?,?)",
      [startedAt, startedAt]
    );
    await expect(ClaudeTraceCandidateReceiver.start(store, traceScope, { clock: () => startedAt })).rejects.toThrow('candidate_mixed_sources');
    expect(store.eventCount()).toBe(0);
  } finally {
    store.close();
  }
});

test('scope revoked while body uploads is checked again before JSON decode', async () => {
  const f = await fixture();
  try {
    const response = new Promise<number>((resolve, reject) => {
      const req = request(
        f.receiver.endpoint + '/v1/traces',
        {
          method: 'POST',
          headers: {
            ...f.receiver.exporterHeaders(),
            'content-type': 'application/json',
            expect: '100-continue'
          }
        },
        res => {
          res.resume();
          res.on('end', () => resolve(res.statusCode!));
        }
      );
      req.on('error', reject);
      req.on('continue', () => {
        f.store.execute("UPDATE tasks SET state='paused',generation=1 WHERE id='task-1'", []);
        req.end('PRIVATE_SENTINEL malformed-json');
      });
      req.flushHeaders();
    });
    expect(await response).toBe(403);
    expect(f.store.eventCount()).toBe(0);
    expect(f.store.all('SELECT * FROM observation_gaps')).toEqual([]);
  } finally {
    await f.cleanup();
  }
});
test('each local process receiver has its own noninterchangeable token', async () => {
  const first = await fixture();
  const second = await fixture();
  try {
    expect((await second.post('PRIVATE_SENTINEL malformed-json', first.receiver.exporterHeaders())).status).toBe(401);
    expect((await second.post()).status).toBe(200);
    expect(first.store.eventCount()).toBe(0);
    expect(second.store.eventCount()).toBe(2);
  } finally {
    await first.cleanup();
    await second.cleanup();
  }
});
