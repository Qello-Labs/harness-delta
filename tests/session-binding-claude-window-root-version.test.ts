import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { aggregateOrdinaryWindowMetrics } from '../src/pricing/metrics-ordinary-window.js';
import { createClaudeWindowFixture } from './helpers/claude-window-fixture.js';

vi.mock('node:child_process', { spy: true });

type Fixture = ReturnType<typeof createClaudeWindowFixture>;
const fixtures: Fixture[] = [];

beforeEach(() => {
  vi.mocked(execFileSync).mockImplementation(() => {
    throw new Error('real_process_access_forbidden');
  });
  vi.mocked(spawnSync).mockImplementation(() => {
    throw new Error('real_process_access_forbidden');
  });
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw new Error('real_process_access_forbidden');
  });
});

afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

function fixture() {
  const f = createClaudeWindowFixture();
  fixtures.push(f);
  f.activate();
  f.life.start(f.taskId);
  return f;
}

function transcriptRows(f: Fixture, requestId: string): Record<string, unknown>[] {
  const root = { sessionId: f.nativeSessionId };
  const versioned = { ...root, version: f.selection.declaredVersion };
  const rows: Record<string, unknown>[] = Array.from({ length: 41 }, (_, index) => ({
    type: 'attachment',
    ...versioned,
    ...(index % 2 === 0 ? { session_id: f.nativeSessionId } : {})
  }));
  for (const start of [0, 26, 35]) {
    rows[start] = {
      type: 'last-prompt',
      leafUuid: 'synthetic-leaf',
      ...root,
      ...(start === 0 ? {} : { lastPrompt: null })
    };
    rows[start + 1] = { type: 'mode', mode: null, ...root };
    rows[start + 2] = { type: 'permission-mode', permissionMode: null, ...root };
    rows[start + 3] = { type: 'session-owner', accountUuid: null, organizationUuid: null, ...root };
    rows[start + 4] = { type: 'atis-latch', atis: null, ...root };
  }
  rows[7] = { type: 'file-history-snapshot', isSnapshotUpdate: false, messageId: 'synthetic-history', snapshot: {} };
  rows[8] = f.user();
  for (const index of [21, 31]) rows[index] = { type: 'data-flow-records', records: [], ...root, v: 1 };
  rows[22] = { type: 'api-request-shape', ...versioned, shape: {}, shapeHash: 'synthetic-shape', timestamp: f.clock() };
  for (const index of [23, 24]) rows[index] = { type: 'api-request-blob', hash: 'synthetic-blob', message: {}, ...root };
  rows[25] = {
    type: 'api-request',
    ...versioned,
    cacheControl: [],
    id: 'synthetic-api-request',
    keep: false,
    params: {},
    querySource: null,
    requestDigest: 'synthetic-request',
    shapeHash: 'synthetic-shape',
    tail: false,
    timestamp: f.clock()
  };
  rows[32] = f.assistant(requestId);
  rows[34] = { type: 'system', subtype: 'turn_duration', ...versioned };
  rows[40] = { type: 'ai-title', aiTitle: null, ...root };
  return rows;
}

test('connects past versionless metadata and reports only post-baseline assistant usage from the indexed transcript sequence', async () => {
  const f = fixture();
  f.replace(transcriptRows(f, 'baseline-request'));

  await f.connect();
  expect(f.payloads()).toEqual([]);
  f.advance();
  f.append(transcriptRows(f, 'measured-request'));
  await f.collect();

  expect(f.payloads()).toEqual([
    expect.objectContaining({
      input_total: { status: 'observed', value: 21, reason: null },
      cached_input: { status: 'observed', value: 7, reason: null },
      output_total: { status: 'observed', value: 5, reason: null }
    })
  ]);
  f.advance();
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse(f.clock()));
  expect(aggregateOrdinaryWindowMetrics(f.store, f.taskId, f.clock())).toMatchObject({
    automatic_children: false,
    inference: false,
    usage: {
      event_count: 1,
      complete_tokens: null,
      compatibility_unverified: { event_count: 1, partial_tokens: 26, complete_tokens: null }
    }
  });
});

test.each(['attachment', 'last-prompt'])('rejects a later %s root row with a different version', async type => {
  const f = fixture();
  f.replace([f.user(), { type, sessionId: f.nativeSessionId, version: '2.1.317' }]);

  await expect(f.connect()).rejects.toThrow('binding_source_version_mismatch');
  expect(f.payloads()).toEqual([]);
});

test('refuses root identity when every root row is versionless', async () => {
  const f = fixture();
  f.replace(transcriptRows(f, 'unused-request').filter(row => !Object.hasOwn(row, 'version')));

  await expect(f.connect()).rejects.toThrow('binding_identity_unavailable');
  expect(f.payloads()).toEqual([]);
});

test.each([
  { label: 'null', version: null },
  { label: 'boolean', version: true },
  { label: 'number', version: 7 },
  { label: 'object', version: {} },
  { label: 'array', version: [] },
  { label: 'empty string', version: '' },
  { label: 'malformed string', version: 'malformed-version' }
])('refuses a present invalid root version: $label', async ({ version }) => {
  const f = fixture();
  f.replace([f.user({ version })]);

  await expect(f.connect()).rejects.toThrow('binding_source_version_mismatch');
  expect(f.payloads()).toEqual([]);
});
