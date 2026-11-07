import type { PriceTable } from '../../src/flexible-contracts.js';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { codexWorkflowFixture } from './codex-workflow-fixture.js';
import { createSyntheticCodexWorkflowAdapter } from '../../src/codex-workflow-adapter.js';
import { externalInstructionFragment } from '../../src/workflow/external-session-context.js';
import { createLocalWebDomain, LocalWebProfileSchema } from '../../src/web/local-web-domain.js';
export function localWebFixture(nativeProfile?: string, native?: { product: 'codex' | 'claude_code'; productVersion: string; priceTable?: PriceTable }) {
  const f = codexWorkflowFixture(nativeProfile, 'functional_pilot', native);
  // A git hook (e.g. pre-commit in a linked worktree) exports GIT_DIR/GIT_INDEX_FILE; the
  // fixture repository must not inherit them.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  execFileSync('git', ['init', '-q', f.project], { env });
  execFileSync(
    'git',
    [
      '-C',
      f.project,
      '-c',
      'user.name=Synthetic',
      '-c',
      'user.email=synthetic@example.invalid',
      'commit',
      '--allow-empty',
      '-qm',
      'Synthetic fixture baseline'
    ],
    { env }
  );
  if (!f.store.get("SELECT 1 FROM sqlite_master WHERE name='external_task_contracts'")) {
    const db = new Database(f.database);
    try {
      db.exec(readFileSync(new URL('../../src/migrations/019_external_connection_contract.sql', import.meta.url), 'utf8'));
    } finally {
      db.close();
    }
  }
  const e = f.execution(randomUUID(), 'link', randomUUID(), f.prompt);
  const profile = LocalWebProfileSchema.parse({
    id: 'reviewed-setup',
    name: 'Synthetic reviewed setup',
    setup: {
      workflow: f.input,
      runtime: { model: null, effort: null },
      preparation: { schema_version: 1, common_artifacts: [], common_manifest_hash: null, allowed_preimage_hashes: [] }
    },
    execution: { binary: e.binary, codex_home: e.codex_home, hook_recorder: e.hook_recorder, sandbox: e.sandbox, timeout_ms: 10000, poll_ms: 10 }
  });
  let picked: string | null = null;
  const metadataFile = join(f.root, 'private-ui.sqlite');
  const create = () =>
    createLocalWebDomain({
      store: f.store,
      metadataFile,
      profiles: [profile],
      picker: () => Promise.resolve(picked),
      adapterFactory: (store, execution) => createSyntheticCodexWorkflowAdapter(store, execution, f.script)
    });
  const sourceFor = (ticketId: string) => {
    const source = f.newRoot();
    const at = new Date().toISOString();
    writeFileSync(
      source.path,
      JSON.stringify({
        timestamp: at,
        type: 'session_meta',
        payload: { id: source.id, session_id: source.id, cwd: f.project, cli_version: '0.160.0', source: 'cli' }
      }) + '\n'
    );
    const fragment = externalInstructionFragment(ticketId, readFileSync(join(f.project, '.harness-delta-managed/active-instructions.md'), 'utf8'));
    appendFileSync(
      source.path,
      JSON.stringify({
        timestamp: at,
        type: 'response_item',
        payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: fragment }] }
      }) + '\n'
    );
    return source;
  };
  return {
    ...f,
    profile,
    metadataFile,
    create,
    sourceFor,
    pick: (path: string | null) => {
      picked = path;
    }
  };
}
