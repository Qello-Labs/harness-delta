import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import { localWebFixture } from './helpers/local-web-fixture.js';
import { ExternalTaskSetupSchema, prepareExternalTask } from '../src/external-session-service.js';
import { registerHarness } from '../src/harness/harness-config.js';
import { hashBytes } from '../src/core/repository-files.js';
import { ApplicationCoordinator, requireApplication } from '../src/harness-application.js';
import { CodexSessionBindingProvider } from '../src/session-binding-codex.js';
import { codexHumanPilotProfileId, codexRootHumanPilotProfileId, issueCodexHumanPilotScope } from '../src/session-binding-human-pilot.js';
import { createSessionBindingService } from '../src/session-binding-service.js';
import { SourceCompatibilitySchema } from '../src/contracts.js';
import { effectiveSourceCompatibility } from '../src/source-compatibility.js';

test.each([
  { version: '0.160.0', boundary: 'unsupported' },
  { version: '0.162.0', boundary: 'drift' },
  { version: '0.162.0', boundary: 'contract' },
  { version: '0.162.0', boundary: 'header' },
  { version: '0.162.0', boundary: 'replacement' },
  { version: '0.162.1', boundary: 'drift' },
  { version: '0.162.1', boundary: 'contract' },
  { version: '0.162.1', boundary: 'header' },
  { version: '0.162.1', boundary: 'replacement' }
])(
  'application pilot %j preserves source authority and lifecycle fences',
  async ({ version, boundary }) => {
    const f = localWebFixture(version === '0.160.0' ? codexHumanPilotProfileId : codexRootHumanPilotProfileId, { product: 'codex', productVersion: version });
    try {
      const setup = ExternalTaskSetupSchema.parse({
        workflow: f.input,
        runtime: { model: null, effort: null },
        preparation: { schema_version: 1, common_artifacts: [], common_manifest_hash: null, allowed_preimage_hashes: [] }
      });
      prepareExternalTask(f.store, setup, true);
      writeFileSync(join(f.project, 'procedure.md'), 'Synthetic application procedure');
      writeFileSync(join(f.project, 'README.md'), 'Synthetic application prerequisites');
      const bundle = registerHarness(f.project, {
        schema_version: 1,
        harness_id: 'synthetic',
        version: 'pilot',
        policy_version: 'synthetic',
        readme_path: 'README.md',
        artifacts: [{ artifact_id: 'instruction', role: 'instruction', source_path: 'procedure.md', target_path: 'harness.md' }]
      }).manifest;
      const taskId = f.input.assignment.task_id;
      requireApplication(f.store, taskId, {
        origin: f.project,
        bundlePath: 'harness-config/pilot/manifest.json',
        bundleHash: bundle.bundle_hash
      });
      const applications = new ApplicationCoordinator(f.store);
      const context = applications.prepareHandoff(taskId, {
        workspace: f.project,
        workspaceDigest: applications.workspace(taskId, f.project).digest,
        product: 'codex'
      });
      const journal = join(f.root, 'application-pilot-receipts');
      mkdirSync(journal, { mode: 0o700 });
      let now = new Date().toISOString();
      const provider = new CodexSessionBindingProvider({
        receiptDirectory: journal,
        sourceRoots: [join(f.home, 'sessions')],
        projectRoot: f.project,
        maxDepth: 1,
        maxFamilyMembers: version === '0.160.0' ? 3 : 1,
        clock: () => now,
        productVersion: version,
        ...(version === '0.160.0' ? {} : { ordinaryRootPilot: true })
      });
      const scope = issueCodexHumanPilotScope(f.store, taskId, provider);
      const receiptFor = (root: ReturnType<typeof f.newRoot>) => {
        writeFileSync(
          root.path,
          JSON.stringify({ type: 'session_meta', payload: { id: root.id, session_id: root.id, cwd: f.project, cli_version: version, source: 'exec' } }) + '\n'
        );
        const output: unknown = JSON.parse(
          execFileSync(
            process.execPath,
            [
              resolve('scripts/session-binding-codex-hook.mjs'),
              '--receipt-directory',
              journal,
              '--source-root',
              join(f.home, 'sessions'),
              '--product-version',
              version
            ],
            {
              input: JSON.stringify({
                hook_event_name: 'SessionStart',
                session_id: root.id,
                source: 'startup',
                cwd: f.project,
                transcript_path: root.path
              }),
              encoding: 'utf8'
            }
          )
        );
        if (!output || typeof output !== 'object' || !('hookSpecificOutput' in output)) throw new Error('invalid_fixture_receipt');
        const specific = output.hookSpecificOutput;
        if (!specific || typeof specific !== 'object' || !('additionalContext' in specific) || typeof specific.additionalContext !== 'string')
          throw new Error('invalid_fixture_receipt');
        const receipt = /[a-f0-9-]{36}/.exec(specific.additionalContext)?.[0];
        if (!receipt) throw new Error('invalid_fixture_receipt');
        return receipt;
      };
      const applying = f.newRoot();
      const applyingReceipt = receiptFor(applying);
      applications.registerIdentity(taskId, context.attempt_id, await provider.resolveApplicationIdentity({ receipt: applyingReceipt }));
      now = new Date().toISOString();
      let service = createSessionBindingService({ store: f.store, providers: [provider], setupFor: () => setup, humanPilot: scope, clock: () => now });
      if (boundary === 'unsupported') {
        const read = vi.spyOn(provider, 'readUsage');
        await expect(service.connect(taskId, 'codex', { receipt: applyingReceipt })).rejects.toThrow('application_source_unqualified');
        expect(read).not.toHaveBeenCalled();
        return;
      }
      await expect(service.connect(taskId, 'codex', { receipt: applyingReceipt })).rejects.toThrow('application_required');
      const checkpoint = applications.checkpoint(taskId, { attempt_id: context.attempt_id, paths: ['AGENTS.md'] })[0];
      if (!checkpoint) throw new Error('invalid_fixture_checkpoint');
      writeFileSync(join(f.project, 'AGENTS.md'), 'Synthetic applied rules');
      applications.report(taskId, {
        attempt_id: context.attempt_id,
        bundle_hash: bundle.bundle_hash,
        outputs: [{ path: 'AGENTS.md', checkpoint_id: checkpoint.checkpoint_id, sha256: hashBytes('Synthetic applied rules') }],
        checks: [{ check_id: 'synthetic_application_check', outcome: 'passed' }]
      });
      f.store.execute("UPDATE harness_application_attempts SET completed_at='2000-01-01T00:00:00.000Z' WHERE id=?", [context.attempt_id]);
      await expect(service.connect(taskId, 'codex', { receipt: applyingReceipt })).rejects.toThrow('application_setup_session_excluded');
      const working = f.newRoot();
      const workingReceipt = receiptFor(working);
      now = new Date().toISOString();
      const ordinary = createSessionBindingService({ store: f.store, providers: [provider], setupFor: () => setup });
      await expect(ordinary.connect(taskId, 'codex', { receipt: workingReceipt })).rejects.toThrow('application_source_unqualified');
      await service.connect(taskId, 'codex', { receipt: workingReceipt });
      now = new Date(Date.parse(now) + 1000).toISOString();
      const turn = 'synthetic-working-turn';
      const rows = [
        { type: 'event_msg', payload: { type: 'task_started', turn_id: turn } },
        { type: 'turn_context', payload: { cwd: f.project, turn_id: turn, model: 'synthetic-pilot-model', effort: null, multi_agent_version: 'disabled' } },
        {
          type: 'token_usage_record',
          payload: {
            session_id: working.id,
            thread_id: working.id,
            turn_id: turn,
            root_turn_id: turn,
            response_id: 'synthetic-working-response',
            usage: { input_tokens: 30, cached_input_tokens: 5, output_tokens: 3, reasoning_output_tokens: 0, total_tokens: 33 }
          }
        },
        { type: 'event_msg', payload: { type: 'task_complete', turn_id: turn } }
      ];
      appendFileSync(working.path, rows.map(row => JSON.stringify({ timestamp: now, ...row }) + '\n').join(''));
      await service.tick(taskId);
      expect(service.status(taskId)).toMatchObject({ state: 'observing', roots: 1, children: 0, requests: 1, complete_cost: null, inference: false });
      expect(f.store.all('SELECT * FROM comparison_assignments')).toHaveLength(1);
      if (version !== '0.160.0') {
        const pin = f.store.get<{ payload: string }>('SELECT payload FROM session_source_compatibility WHERE session_id=?', [working.id]);
        if (!pin) throw new Error('missing_fixture_compatibility');
        expect(JSON.parse(pin.payload)).toMatchObject({
          state: 'compatibility_unverified',
          product_version: version,
          parser_version: '0.160.0',
          source: 'codex_workflow'
        });
        const payloads = f.store.all<{ payload: string }>('SELECT payload FROM events').map<unknown>(row => JSON.parse(row.payload));
        const compatibility = z.object({
          source_compatibility: z.object({ state: z.literal('compatibility_unverified'), product_version: z.literal(version) })
        });
        expect(payloads.some(payload => compatibility.safeParse(payload).success)).toBe(true);
      }
      service.pause(taskId);
      now = new Date(Date.parse(now) + 1000).toISOString();
      appendFileSync(
        working.path,
        rows
          .map(
            row =>
              JSON.stringify({
                timestamp: now,
                ...row,
                payload: row.type === 'token_usage_record' ? { ...row.payload, response_id: 'synthetic-paused-response' } : row.payload
              }) + '\n'
          )
          .join('')
      );
      const resumedScope = issueCodexHumanPilotScope(f.store, taskId, provider);
      service = createSessionBindingService({ store: f.store, providers: [provider], setupFor: () => setup, humanPilot: resumedScope, clock: () => now });
      await service.resume(taskId);
      expect(service.status(taskId).requests).toBe(1);
      if (boundary !== 'drift') {
        if (boundary === 'contract') appendFileSync(working.path, JSON.stringify({ type: 'token_usage_record', timestamp: now, payload: {} }) + '\n');
        else if (boundary === 'header')
          writeFileSync(
            working.path,
            JSON.stringify({ type: 'session_meta', payload: { id: working.id, session_id: working.id, cwd: f.root, cli_version: version, source: 'exec' } }) +
              '\n'
          );
        else {
          renameSync(working.path, working.path + '.original');
          writeFileSync(working.path, 'PRIVATE_SYNTHETIC_REPLACED_SOURCE\n');
        }
        const read = vi.spyOn(provider, 'readUsage');
        await expect(service.tick(taskId)).rejects.toThrow(
          boundary === 'contract' ? 'candidate_invalid_metadata' : boundary === 'header' ? 'binding_scope_mismatch' : 'binding_source_changed'
        );
        expect(
          f.store.get('SELECT 1 FROM source_compatibility_blocks WHERE product=? AND product_version=? AND source=?', ['codex', version, 'codex_workflow'])
        ).toBeDefined();
        const pin = f.store.get<{ payload: string }>('SELECT payload FROM session_source_compatibility WHERE session_id=?', [working.id]);
        if (!pin) throw new Error('missing_fixture_compatibility');
        expect(effectiveSourceCompatibility(f.store, SourceCompatibilitySchema.parse(JSON.parse(pin.payload))).state).toBe('invalidated');
        await expect(service.tick(taskId)).rejects.toThrow('compatibility_invalidated');
        expect(read).toHaveBeenCalledTimes(boundary === 'replacement' ? 0 : 1);
        read.mockClear();
        const discover = vi.spyOn(provider, 'discoverChildren');
        const restartScope = issueCodexHumanPilotScope(f.store, taskId, provider);
        const restarted = createSessionBindingService({
          store: f.store,
          providers: [provider],
          setupFor: () => setup,
          humanPilot: restartScope,
          clock: () => now
        });
        await expect(restarted.connect(taskId, 'codex', { receipt: workingReceipt })).rejects.toThrow('compatibility_invalidated');
        expect(discover).not.toHaveBeenCalled();
        expect(read).not.toHaveBeenCalled();
      } else {
        writeFileSync(join(f.project, 'AGENTS.md'), 'Synthetic concurrent drift');
        await expect(service.tick(taskId)).rejects.toThrow('application_output_changed');
      }
      expect(service.status(taskId).requests).toBe(1);
    } finally {
      f.cleanup();
    }
  },
  30000
);
