import { randomUUID } from 'node:crypto';
import { appendFileSync, truncateSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, test, vi } from 'vitest';
import * as binding from '../src/ordinary-session-binding.js';
import { ordinaryWindowSelectionHash } from '../src/core/ordinary-window-store.js';
import { createLocalWebDomain } from '../src/web/local-web-domain.js';
import { createLocalWebServer } from '../src/web/local-web-server.js';
import type { ClaudeWindowTaskDto } from '../src/web/local-web-claude-window-control.js';
import { createClaudeWindowFixture } from './helpers/claude-window-fixture.js';

vi.mock('../src/ordinary-session-binding.js', { spy: true });
vi.mock('node:child_process', () => {
  const forbidden = () => {
    throw new Error('fixture_process_forbidden');
  };
  return { spawn: forbidden, spawnSync: forbidden, exec: forbidden, execSync: forbidden, execFile: forbidden, execFileSync: forbidden };
});

const fixtures: {
  readonly app: ReturnType<typeof createLocalWebServer>;
  readonly metadata: Database.Database;
  cleanup(): void;
}[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const f of fixtures.splice(0)) {
    await f.app.close();
    f.metadata.close();
    f.cleanup();
  }
  vi.useRealTimers();
});

async function fixture() {
  const f = createClaudeWindowFixture();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(f.clock()));
  const metadataFile = join(f.directory, 'metadata.sqlite');
  const domain = createLocalWebDomain({ store: f.store, metadataFile, claudeWindowBinaryAdapters: f.binary.adapters });
  const metadata = new Database(metadataFile);
  const setup = {
    schema_version: 1,
    kind: 'claude_window_setup',
    selection_hash: ordinaryWindowSelectionHash(f.selection),
    configuration: {
      product_version: f.selection.declaredVersion,
      project_root: f.projectRoot,
      receipt_directory: f.receiptDirectory,
      claude_projects_directory: f.claudeProjectsDirectory
    }
  };
  metadata
    .prepare('INSERT INTO web_tasks(id,name,profile_id,setup,project_id) VALUES (?,?,?,?,?)')
    .run(f.taskId, 'Synthetic binding errors', 'ordinary-claude-window-v1', JSON.stringify(setup), 'project');
  const origin = 'http://127.0.0.1:4327';
  const app = createLocalWebServer({ domain, origin, metadataFile: join(f.directory, 'transport.sqlite') });
  fixtures.push({ app, metadata, cleanup: f.cleanup });
  const path = `/api/tasks/${f.taskId}/claude-window`;
  await app.ready();
  f.activate();
  f.life.start(f.taskId);
  const post = async (operation: 'connect' | 'collect') => {
    const view = (await app.inject({ url: `${path}-v1`, headers: { host: '127.0.0.1:4327' } })).json<{
      csrf: string;
      task: ClaudeWindowTaskDto;
    }>();
    return app.inject({
      method: 'POST',
      url: `${path}-${operation === 'connect' ? 'connect' : 'action'}-v1`,
      payload:
        operation === 'connect'
          ? { project_id: 'project', product: 'claude_code', receipt: f.receipt.receipt }
          : { project_id: 'project', operation: 'collect' },
      headers: {
        host: '127.0.0.1:4327',
        origin,
        'x-harness-csrf': view.csrf,
        'idempotency-key': randomUUID(),
        'if-match': view.task.version
      }
    });
  };
  return { ...f, metadata, setup, post };
}

const sourceFailures = [
  ['contract', 'binding_contract_failed'],
  ['version', 'binding_source_version_mismatch'],
  ['ownership', 'binding_ownership_unverified'],
  ['limit', 'binding_source_limit'],
  ['usage', 'binding_usage_invalid']
] as const;

for (const operation of ['connect', 'collect'] as const) {
  test(`surfaces unverified executable identity through HTTP ${operation}`, async () => {
    const f = await fixture();
    if (operation === 'collect') expect((await f.post('connect')).statusCode).toBe(200);
    const before = f.payloads();
    vi.spyOn(f.binary.adapters, 'readImage').mockReturnValue(null);
    const response = await f.post(operation);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'binding_executable_identity_unverified' });
    expect(f.payloads()).toEqual(before);
  });

  test.each(sourceFailures)(`surfaces %s source failure through HTTP ${operation}`, async (kind, error) => {
    const f = await fixture();
    if (operation === 'collect') expect((await f.post('connect')).statusCode).toBe(200);
    switch (kind) {
      case 'contract':
        appendFileSync(f.sourcePath, 'SYNTHETIC_INVALID_JSON\n');
        break;
      case 'version':
        f.replace([f.user({ version: '2.1.317' })]);
        break;
      case 'ownership':
        f.append([{ ...f.assistant('foreign-owner'), sessionId: randomUUID() }]);
        break;
      case 'limit':
        truncateSync(f.sourcePath, 8 * 1048576 + 1);
        break;
      case 'usage':
        f.append([f.assistant('invalid-usage', { input_tokens: -1 })]);
        break;
      default:
        throw new Error('unreachable source failure', { cause: kind satisfies never });
    }
    const response = await f.post(operation);
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error });
    expect(f.payloads()).toEqual([]);
  });
}

test('surfaces changed executable after connection through HTTP collect', async () => {
  const f = await fixture();
  expect((await f.post('connect')).statusCode).toBe(200);
  f.binary.state.inode += 1;
  const response = await f.post('collect');
  expect(response.statusCode).toBe(400);
  expect(response.json()).toEqual({ error: 'binding_executable_changed' });
  expect(f.payloads()).toEqual([]);
});

test('surfaces invalid source cursor through HTTP collect', async () => {
  const f = await fixture();
  expect((await f.post('connect')).statusCode).toBe(200);
  f.store.execute('UPDATE session_bindings SET cursor=?', ['SYNTHETIC_INVALID_CURSOR']);
  const response = await f.post('collect');
  expect(response.statusCode).toBe(400);
  expect(response.json()).toEqual({ error: 'binding_cursor_invalid' });
  expect(f.payloads()).toEqual([]);
});

test('surfaces invalid provider configuration through HTTP connect', async () => {
  const f = await fixture();
  f.setup.configuration.claude_projects_directory = join(f.directory, 'claude-projects') + '/../claude-projects';
  f.metadata.prepare('UPDATE web_tasks SET setup=? WHERE id=?').run(JSON.stringify(f.setup), f.taskId);
  const response = await f.post('connect');
  expect(response.statusCode).toBe(400);
  expect(response.json()).toEqual({ error: 'binding_configuration_invalid' });
  expect(f.binary.operations).toEqual([]);
});

for (const operation of ['connect', 'collect'] as const) {
  test.each(['binding_future_code', 'binding_source_unavailable /SYNTHETIC_PRIVATE', '/SYNTHETIC_PRIVATE', 'binding_executable_changed\nSECRET'])(
    `masks unknown or private failure %s through HTTP ${operation}`,
    async message => {
      const f = await fixture();
      if (operation === 'collect') expect((await f.post('connect')).statusCode).toBe(200);
      const target = operation === 'connect' ? 'connectOrdinaryClaudeWindow' : 'collectOrdinaryClaudeWindow';
      vi.spyOn(binding, target).mockRejectedValueOnce(new Error(message));
      const response = await f.post(operation);
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: 'local_operation_failed' });
      expect(f.payloads()).toEqual([]);
    }
  );
}
