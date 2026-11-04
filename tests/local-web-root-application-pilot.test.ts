import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { localWebFixture } from './helpers/local-web-fixture.js';
import { createLocalWebDomain, LocalWebProfileSchema } from '../src/local-web-domain.js';
import { registerHarness, generateComparison } from '../src/harness/harness-config.js';
import { comparisonVariant } from '../src/core/protocol-store.js';
import { codexRootHumanPilotProfileId } from '../src/session-binding-human-pilot.js';
import { createHash } from 'node:crypto';

test.each(['0.162.0', '0.162.1'])(
  'reviewed %s root pilot uses the selected application checkout and metadata-only versioned identity',
  async productVersion => {
    const f = localWebFixture(codexRootHumanPilotProfileId, { product: 'codex', productVersion });
    const journal = join(f.root, 'root-pilot-receipts');
    mkdirSync(journal, { mode: 0o700 });
    writeFileSync(join(f.project, 'README.md'), 'Synthetic application prerequisites');
    for (const [index, version] of ['v1', 'v2'].entries()) {
      const artifact = f.input.artifacts[index]?.selected_artifacts[0];
      if (!artifact) throw new Error('invalid_fixture_artifact');
      writeFileSync(join(f.project, 'procedure.md'), readFileSync(artifact.path));
      registerHarness(f.project, {
        schema_version: 1,
        harness_id: 'synthetic',
        version,
        policy_version: comparisonVariant(f.store, f.input.artifacts[index]!.variant_id).policy_version,
        readme_path: 'README.md',
        artifacts: [{ artifact_id: 'instruction', role: 'instruction', source_path: 'procedure.md', target_path: 'harness.md' }]
      });
    }
    generateComparison(f.project, { schema_version: 2, id: 'root-pilot', name: 'Synthetic', arm_a: 'v1', arm_b: 'v2', application: 'agent_applied' });
    const profile = LocalWebProfileSchema.parse({
      ...f.profile,
      session_binding: { product: 'codex', receipt_directory: journal, source_roots: [join(f.home, 'sessions')], project_root: f.project }
    });
    const domain = createLocalWebDomain({
      store: f.store,
      metadataFile: f.metadataFile,
      profiles: [profile],
      picker: () => Promise.resolve(join(f.project, 'harness-config/comparisons/root-pilot.json'))
    });
    try {
      const preview = z.object({ token: z.string() }).parse(await domain.importSetup!());
      const bound = z
        .object({ profile_id: z.string() })
        .parse(await domain.bindSetup!({ token: preview.token, project_id: 'project-1', template_id: profile.id }));
      const task = z
        .object({ id: z.string(), support_details: z.unknown() })
        .parse(await domain.createTask({ name: 'Synthetic root pilot', project_id: 'project-1', setup_id: bound.profile_id }));
      expect(task.support_details).toMatchObject({
        family: 'candidate_root_pilot',
        family_parser_compatibility: { state: 'compatibility_unverified', product_version: productVersion, parser_version: '0.160.0' }
      });
      const workspace = join(f.root, 'selected-checkout');
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
      execFileSync('git', ['-C', f.project, 'worktree', 'add', '--detach', workspace, 'HEAD'], { env, stdio: 'ignore' });
      const selection = z.object({ digest: z.string() }).parse(domain.applicationWorkspace!(task.id, workspace));
      await domain.taskAction(task.id, 'application-prepare', { workspace, workspaceDigest: selection.digest, product: 'codex' });
      const attempt = z.object({ application: z.object({ jobId: z.string() }) }).parse(domain.task(task.id)).application.jobId;
      const receiptFor = (cwd: string) => {
        const source = f.newRoot();
        writeFileSync(source.path, 'PRIVATE_SYNTHETIC_HEADER_MUST_NOT_BE_OPENED\n');
        const raw: unknown = JSON.parse(
          execFileSync(
            process.execPath,
            [
              resolve('scripts/session-binding-codex-hook.mjs'),
              '--receipt-directory',
              journal,
              '--source-root',
              join(f.home, 'sessions'),
              '--product-version',
              productVersion
            ],
            {
              input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: source.id, source: 'startup', cwd, transcript_path: source.path }),
              encoding: 'utf8'
            }
          )
        );
        if (!raw || typeof raw !== 'object' || !('hookSpecificOutput' in raw)) throw new Error('invalid_fixture_receipt');
        const value = raw.hookSpecificOutput;
        if (!value || typeof value !== 'object' || !('additionalContext' in value) || typeof value.additionalContext !== 'string')
          throw new Error('invalid_fixture_receipt');
        const receipt = /[a-f0-9-]{36}/.exec(value.additionalContext)?.[0];
        if (!receipt) throw new Error('invalid_fixture_receipt');
        return receipt;
      };
      await expect(
        domain.taskAction(task.id, 'application-identity', {
          attempt_id: attempt,
          product: 'codex',
          receipt: receiptFor(f.project)
        })
      ).rejects.toThrow('binding_qualification_live_root_required');
      const identity = await domain.taskAction(task.id, 'application-identity', {
        attempt_id: attempt,
        product: 'codex',
        receipt: receiptFor(workspace)
      });
      expect(identity).toEqual({ identity: 'verified_metadata', measurement: false });
      expect(domain.task(task.id)).toMatchObject({ application: { state: 'awaiting_session' } });
      expect(f.store.all('SELECT * FROM harness_application_roles WHERE attempt_id=?', [attempt])).toHaveLength(1);
      expect(f.store.eventCount()).toBe(0);
      expect(f.store.all('SELECT * FROM comparison_assignments')).toHaveLength(1);
      const checkpoint = z.array(z.object({ checkpoint_id: z.string() })).parse(
        await domain.taskAction(task.id, 'application-checkpoint', {
          attempt_id: attempt,
          paths: ['AGENTS.md']
        })
      )[0];
      if (!checkpoint) throw new Error('invalid_fixture_checkpoint');
      const output = 'Synthetic verified rules';
      writeFileSync(join(workspace, 'AGENTS.md'), output);
      await domain.taskAction(task.id, 'application-report', {
        attempt_id: attempt,
        bundle_hash: z.object({ bundle_hash: z.string() }).parse(domain.applicationContext!(task.id, attempt)).bundle_hash,
        outputs: [{ path: 'AGENTS.md', checkpoint_id: checkpoint.checkpoint_id, sha256: createHash('sha256').update(output).digest('hex') }],
        checks: [{ check_id: 'synthetic_application_check', outcome: 'passed' }]
      });
      const pilot = createLocalWebDomain({
        store: f.store,
        metadataFile: f.metadataFile,
        profiles: [profile],
        nativePilot: { taskId: task.id, observe: true }
      });
      try {
        expect(pilot.task(task.id).actions).toContainEqual({ code: 'session-connect', enabled: true, reason: null });
        writeFileSync(join(workspace, 'AGENTS.md'), 'Synthetic drift');
        expect(pilot.task(task.id).actions).toContainEqual({ code: 'session-connect', enabled: false, reason: 'external_preparation_required' });
        expect(f.store.eventCount()).toBe(0);
      } finally {
        await pilot.close?.();
      }
    } finally {
      await domain.close?.();
      f.cleanup();
    }
  },
  30000
);
