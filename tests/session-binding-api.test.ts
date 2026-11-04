import { randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { createLocalWebDomain } from '../src/web/local-web-domain.js';
import { createLocalWebServer } from '../src/web/local-web-server.js';
import { CodexSessionBindingProvider } from '../src/session-binding-codex.js';
import { localWebFixture } from './helpers/local-web-fixture.js';
import type { SessionBindingProvider } from '../src/session-binding-contract.js';

test('ordinary configured task exposes explicit-stop authority and HTTP revocation persists across reload', async () => {
  const f = localWebFixture();
  const journal = join(f.root, 'receipts');
  mkdirSync(journal, { mode: 0o700 });
  f.profile.session_binding = { product: 'codex', receipt_directory: journal, source_roots: [join(f.home, 'sessions')], project_root: f.project };
  const domain = f.create();
  const origin = 'http://127.0.0.1:4321';
  const app = createLocalWebServer({ origin, domain, metadataFile: f.metadataFile });
  try {
    const created = (await domain.createTask({ name: 'Synthetic explicit stop', project_id: 'project-1', setup_id: f.profile.id })) as { id: string };
    expect(domain.task(created.id)).toMatchObject({ measurement: { end_condition: 'explicit_stop', window: { ends_at: null } } });
    const bootstrap = (await app.inject({ url: '/api/bootstrap', headers: { host: '127.0.0.1:4321' } })).json<{ csrf: string }>();
    const revoked = await app.inject({
      method: 'POST',
      url: `/api/tasks/${created.id}/revoke-collection`,
      payload: '{}',
      headers: {
        host: '127.0.0.1:4321',
        origin,
        'content-type': 'application/json',
        'x-harness-csrf': bootstrap.csrf,
        'idempotency-key': randomUUID(),
        'if-match': domain.task(created.id).version
      }
    });
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect(revoked.json<{ actions: { code: string; enabled: boolean; reason: string | null }[] }>().actions).toContainEqual({
      code: 'session-connect',
      enabled: false,
      reason: 'binding_source_unqualified'
    });
    expect(f.store.eventCount()).toBe(0);
    await app.close();
    const restarted = f.create();
    try {
      expect(restarted.task(created.id)).toMatchObject({ measurement: { end_condition: 'explicit_stop' } });
      expect(restarted.task(created.id).actions).toContainEqual({ code: 'revoke-collection', enabled: false, reason: 'binding_scope_revoked' });
    } finally {
      await restarted.close?.();
    }
  } finally {
    await app.close();
    f.cleanup();
  }
});

test('domain close finishes cleanup even when pause cannot record a valid gap', async () => {
  const f = localWebFixture();
  const source = f.newRoot();
  const provider: SessionBindingProvider = {
    product: 'codex',
    capabilities: () => ({
      currentIdentity: 'native_hook',
      ancestry: 'verified_relations',
      usage: 'own_requests',
      productionSupported: false,
      maxDepth: 1,
      reasons: []
    }),
    resolveCurrent: () =>
      Promise.resolve({
        product: 'codex',
        productVersion: '0.160.0',
        sessionId: source.id,
        sourceRef: source.path,
        sourceIdentity: randomUUID(),
        cwd: f.project,
        identityEvidenceId: randomUUID(),
        parentSessionId: null,
        createdAt: new Date().toISOString()
      }),
    discoverChildren: () => Promise.resolve({ children: [], gaps: [] }),
    readUsage: () => Promise.resolve({ records: [], cursor: '0', gaps: [] })
  };
  const domain = createLocalWebDomain({ store: f.store, metadataFile: f.metadataFile, profiles: [f.profile], bindingProviders: [provider] });
  try {
    const created = (await domain.createTask({ name: 'Synthetic failed pause', project_id: 'project-1', setup_id: f.profile.id })) as { id: string };
    await domain.taskAction(created.id, 'apply', {});
    await domain.taskAction(created.id, 'session-connect', { product: 'codex', receipt: randomUUID() });
    f.store.execute('UPDATE session_bindings SET observed_since=?', [new Date(Date.now() + 10000).toISOString()]);
    await expect(domain.close?.()).rejects.toThrow('invalid_gap');
    expect(f.store.all('SELECT state,cursor FROM session_bindings')).toEqual([{ state: 'stopped', cursor: null }]);
    await expect(domain.bootstrap()).rejects.toThrow('not open');
  } finally {
    f.cleanup();
  }
});

// Production APIs, domain, Store and Codex parser with synthetic native hook
// payloads. No product binary, native session or personal database is opened.
test('one native receipt connects and observes automatically; early child usage survives discovery; repeat, restart and human finish retain state', async () => {
  const f = localWebFixture();
  const journal = join(f.root, 'binding-receipts');
  mkdirSync(journal);
  chmodSync(journal, 0o700);
  const provider = () => new CodexSessionBindingProvider({ receiptDirectory: journal, sourceRoots: [join(f.home, 'sessions')], projectRoot: f.project });
  const makeDomain = () => createLocalWebDomain({ store: f.store, metadataFile: f.metadataFile, profiles: [f.profile], bindingProviders: [provider()] });
  let domain = makeDomain();
  const origin = 'http://127.0.0.1:4321';
  let app = createLocalWebServer({ origin, domain, metadataFile: f.metadataFile });
  try {
    const created = (await domain.createTask({ name: 'Synthetic ordinary family', project_id: 'project-1', setup_id: f.profile.id })) as { id: string };
    const id = created.id;
    await domain.taskAction(id, 'apply', {});
    const root = f.newRoot();
    const receipt = (sessionId: string, path: string, parent?: string) => {
      const payload = {
        hook_event_name: parent ? 'SubagentStart' : 'SessionStart',
        session_id: parent ?? sessionId,
        agent_id: parent ? sessionId : undefined,
        turn_id: parent ? 'turn' : undefined,
        source: parent ? undefined : 'startup',
        cwd: f.project,
        transcript_path: path
      };
      const result = JSON.parse(
        execFileSync(
          process.execPath,
          [resolve('scripts/session-binding-codex-hook.mjs'), '--receipt-directory', journal, '--source-root', join(f.home, 'sessions')],
          { input: JSON.stringify(payload), encoding: 'utf8' }
        )
      ) as { hookSpecificOutput: { additionalContext: string } };
      return /[a-f0-9-]{36}/.exec(result.hookSpecificOutput.additionalContext)![0];
    };
    const rootReceipt = receipt(root.id, root.path);
    const post = async (action: string, body: unknown = {}) => {
      const bootstrap = (await app.inject({ url: '/api/bootstrap', headers: { host: '127.0.0.1:4321' } })).json<{ csrf: string }>();
      return app.inject({
        method: 'POST',
        url: `/api/tasks/${id}/${action}`,
        payload: JSON.stringify(body),
        headers: {
          host: '127.0.0.1:4321',
          origin,
          'content-type': 'application/json',
          'x-harness-csrf': bootstrap.csrf,
          'idempotency-key': randomUUID(),
          'if-match': domain.task(id).version
        }
      });
    };
    const connected = await post('session-connect', { product: 'codex', receipt: rootReceipt });
    expect(connected.statusCode, connected.body).toBe(200);
    expect(connected.json()).toMatchObject({ connection: { status: 'connected', collection_active: true, automatic_children: true }, binding: { roots: 1 } });
    expect((await post('session-connect', { product: 'codex', receipt: rootReceipt })).json()).toMatchObject({ connection: { status: 'already_connected' } });
    const child = f.newRoot();
    writeFileSync(
      child.path,
      JSON.stringify({
        type: 'session_meta',
        payload: {
          id: child.id,
          session_id: root.id,
          parent_thread_id: root.id,
          cli_version: '0.160.0',
          agent_nickname: 'Cedar',
          agent_role: 'reviewer',
          cwd: f.project,
          source: { subagent: { thread_spawn: { parent_thread_id: root.id, depth: 1 } } }
        }
      }) + '\n'
    );
    receipt(child.id, child.path, root.id);
    const at = new Date().toISOString();
    appendFileSync(
      child.path,
      JSON.stringify({
        type: 'turn_context',
        timestamp: at,
        payload: { cwd: f.project, turn_id: 'child-turn', root_turn_id: 'root-turn', model: 'model-a', effort: 'high' }
      }) +
        '\n' +
        JSON.stringify({
          type: 'token_usage_record',
          timestamp: at,
          payload: {
            thread_id: child.id,
            session_id: root.id,
            turn_id: 'child-turn',
            root_turn_id: 'root-turn',
            response_id: 'first-child-request',
            usage: { input_tokens: 10, cached_input_tokens: 2, cache_write_input_tokens: 0, output_tokens: 3, reasoning_output_tokens: 1, total_tokens: 13 }
          }
        }) +
        '\n'
    );
    await expect.poll(() => f.store.eventCount(), { timeout: 3000 }).toBe(1);
    expect(domain.task(id)).toMatchObject({
      binding: {
        roots: 1,
        children: 1,
        requests: 1,
        sessions: expect.arrayContaining([
          expect.objectContaining({
            session_id: child.id,
            agent_metadata: { source: 'codex_session_meta', nickname: 'Cedar', role: 'reviewer' },
            models: ['model-a']
          })
        ]) as unknown
      },
      measurement: { state: 'active' }
    });
    expect(f.store.get<{ identity: string }>('SELECT identity FROM session_bindings WHERE session_id=?', [child.id])?.identity).toContain('Cedar');
    // Rejected replacement identity preserves the existing authorized observer.
    expect((await post('session-connect', { product: 'codex', receipt: randomUUID() })).json()).toMatchObject({ error: 'binding_identity_unavailable' });
    // A child can continue the same native context after the discovery poll.
    // Discovery time is not a new observation baseline for an already owned child.
    appendFileSync(
      child.path,
      JSON.stringify({
        type: 'token_usage_record',
        timestamp: new Date().toISOString(),
        payload: {
          thread_id: child.id,
          session_id: root.id,
          turn_id: 'child-turn',
          root_turn_id: 'root-turn',
          response_id: 'continued-child-request',
          usage: { input_tokens: 12, cached_input_tokens: 2, cache_write_input_tokens: 0, output_tokens: 4, reasoning_output_tokens: 1, total_tokens: 16 }
        }
      }) + '\n'
    );
    await expect.poll(() => f.store.eventCount(), { timeout: 3000 }).toBe(2);
    expect((await post('finish-success')).json()).toMatchObject({ error: 'workflow_run_active' });
    await post('pause');
    expect(domain.task(id).actions).toEqual(expect.arrayContaining([{ code: 'resume-binding', enabled: true, reason: null }]));
    const assignment = f.store.get('SELECT * FROM comparison_assignments WHERE task_id=?', [id]);
    await app.close();
    domain = makeDomain();
    app = createLocalWebServer({ origin, domain, metadataFile: f.metadataFile });
    expect(domain.task(id)).toMatchObject({
      binding: {
        state: 'stopped',
        sessions: expect.arrayContaining([
          expect.objectContaining({
            session_id: child.id,
            agent_metadata: { source: 'codex_session_meta', nickname: 'Cedar', role: 'reviewer' },
            models: ['model-a']
          })
        ]) as unknown
      }
    });
    expect((await post('resume-binding')).statusCode).toBe(200);
    expect(f.store.eventCount()).toBe(2);
    expect(f.store.get('SELECT * FROM comparison_assignments WHERE task_id=?', [id])).toEqual(assignment);
    await post('pause');
    expect((await post('finish-success')).statusCode).toBe(200);
    expect(domain.task(id)).toMatchObject({ status: 'success' });
    expect(readFileSync(join(journal, `${rootReceipt}.json`), 'utf8')).not.toContain('first-child-request');
  } finally {
    await app.close();
    f.cleanup();
  }
}, 10000);
