import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect, test, vi } from 'vitest';
import { setupReviewFixture } from './helpers/setup-review-fixture.js';
import { registerVariant } from '../src/comparison.js';
import { createLocalWebDomain, LocalWebProfileSchema } from '../src/local-web-domain.js';
import { createLocalWebServer } from '../src/local-web-server.js';
import * as harnessConfig from '../src/harness-config.js';
import { Lifecycle } from '../src/lifecycle.js';
import type { SetupSaveResult } from '../src/local-web-setup-review.js';

test('path-only transport review inspects registered comparison references without registrations or a save token', async () => {
  const f = setupReviewFixture(); const origin = 'http://127.0.0.1:4329';
  const app = createLocalWebServer({ origin, domain: f.domain, metadataFile: f.metadataFile });
  try {
    const csrf = (await app.inject({ url: '/api/bootstrap', headers: { host: '127.0.0.1:4329' } })).json<{ csrf: string }>().csrf;
    const input = { comparison_path: f.input.comparison_path, project_id: 'project-1' };
    const response = await app.inject({ method: 'POST', url: '/api/setup-review',
      headers: { host: '127.0.0.1:4329', origin, 'x-harness-csrf': csrf }, payload: input });
    expect(response.statusCode).toBe(200);
    const review = await f.domain.reviewSetup!(input);
    expect(response.json()).toEqual(review);
    expect(review.ready).toBe(false);
    if (review.ready || !('comparison' in review) || !review.comparison) throw new Error('inspection_missing');
    const pair = harnessConfig.readComparison(f.project, 'harness-config/comparisons/synthetic-review.json');
    expect(review.comparison).toMatchObject({
      project_id: 'project-1', comparison_id: pair.descriptor.id,
      descriptor_path: 'harness-config/comparisons/synthetic-review.json', settings_hash: pair.descriptor.settings_hash,
      arm_a: { ...pair.descriptor.arm_a, policy_version: pair.bundles[0].policy_version, instruction_manifest_hash: pair.bundles[0].instruction_manifest_hash },
      arm_b: { ...pair.descriptor.arm_b, policy_version: pair.bundles[1].policy_version, instruction_manifest_hash: pair.bundles[1].instruction_manifest_hash },
    });
    expect(review.comparison.arm_a.proposed_variant_id).toMatch(/^variant-[a-f0-9]{64}$/);
    expect(review.comparison.arm_b.proposed_variant_id).toMatch(/^variant-[a-f0-9]{64}$/);
    expect(review.comparison.proposed_profile_id).toMatch(/^setup-[a-f0-9]{64}$/);
    const repeated = await f.domain.reviewSetup!(input);
    if (repeated.ready || !('comparison' in repeated) || !repeated.comparison) throw new Error('inspection_missing');
    expect(repeated.comparison.proposed_profile_id).toBe(review.comparison.proposed_profile_id);
    expect(repeated.comparison.arm_a.proposed_variant_id).toBe(review.comparison.arm_a.proposed_variant_id);
    expect(repeated.comparison.arm_b.proposed_variant_id).toBe(review.comparison.arm_b.proposed_variant_id);
    expect(review.comparison.arm_a.proposed_variant_id).not.toBe(review.comparison.arm_b.proposed_variant_id);
    expect(LocalWebProfileSchema.safeParse({ ...f.profile, id: review.comparison.proposed_profile_id }).success).toBe(true);
    for (const issue of [
      { field: 'profile', code: 'shared_registration_required' },
      { field: 'protocol', code: 'unknown_protocol' },
      { field: 'variants', code: 'unknown_variant' },
      { field: 'price_table', code: 'unknown_price_table' },
      ...['profile.setup.workflow.assignment.metadata.criterion_ids', 'profile.execution', 'variants.policy_status',
        'protocol.recruitment_start', 'protocol.recruitment_end', 'protocol.sample_plan', 'protocol.source_profiles']
        .map(field => ({ field, code: 'decision_required' })),
    ]) expect(review.issues).toContainEqual(issue);
    expect(review).not.toHaveProperty('token');
    expect(review).not.toHaveProperty('registrations');
    expect(f.store.all('SELECT * FROM comparison_variants')).toHaveLength(0);
    expect(f.store.all('SELECT * FROM comparison_protocols')).toHaveLength(0);
    expect(f.store.all('SELECT * FROM price_tables')).toHaveLength(0);
    const privateDb = new Database(f.metadataFile);
    try {
      expect(privateDb.prepare('SELECT * FROM web_profiles').all()).toHaveLength(0);
      expect(privateDb.prepare('SELECT * FROM web_shared_versions').all()).toHaveLength(0);
    } finally { privateDb.close(); }
  } finally { await app.close(); f.cleanup(); }
});

test('explicit eligibility generates ordered variant records from verified manifests without changing the decision', async () => {
  const f = setupReviewFixture();
  try {
    const discovered = await f.domain.reviewSetup!({ comparison_path: f.input.comparison_path, project_id: 'project-1',
      policy_status: { arm_a: 'eligible', arm_b: 'eligible' } });
    if (discovered.ready || !('comparison' in discovered) || !discovered.comparison) throw new Error('inspection_missing');
    expect(discovered.issues).not.toContainEqual({ field: 'variants.policy_status', code: 'decision_required' });
    const ids = [discovered.comparison.arm_a.proposed_variant_id, discovered.comparison.arm_b.proposed_variant_id];
    const { variants: ignored, ...input } = f.input;
    void ignored;
    const profile = { ...f.profile, setup: { ...f.profile.setup, workflow: { ...f.profile.setup.workflow,
      artifacts: f.profile.setup.workflow.artifacts.map((row, index) => ({ ...row, variant_id: ids[index]! })) } } };
    const protocol = { ...f.input.protocol, variant_ids: ids };
    const review = await f.domain.reviewSetup!({ ...input, project_id: 'project-1', profile, protocol,
      policy_status: { arm_a: 'eligible', arm_b: 'eligible' } });
    expect(review.ready).toBe(true);
    if (!review.ready) throw new Error('review_failed');
    expect(review.registrations.variants?.map(row => row.id)).toEqual(ids);
    expect(review.registrations.variants?.map(row => row.policy_status)).toEqual(['eligible', 'eligible']);
    expect(f.store.all('SELECT id FROM comparison_variants')).toHaveLength(0);
    await f.domain.saveReviewedSetup!(review.token);
    expect(f.store.all('SELECT id FROM comparison_variants')).toHaveLength(2);
  } finally { await f.domain.close?.(); f.cleanup(); }
});

test('a path outside the explicitly selected project is rejected before reading comparison contents', async () => {
  const f = setupReviewFixture();
  const read = vi.spyOn(harnessConfig, 'readComparison');
  try {
    const review = await f.domain.reviewSetup!({ comparison_path: join(f.root, 'unavailable.json'), project_id: 'project-1' });
    expect(review).toEqual({ ready: false, issues: [{ field: 'registrations', code: 'shared_path_invalid' }] });
    expect(read).not.toHaveBeenCalled();
    const accepted = await f.domain.reviewSetup!({ comparison_path: f.input.comparison_path, project_id: 'project-1' });
    expect(accepted).toHaveProperty('comparison');
    expect(read).toHaveBeenCalled();
  } finally { read.mockRestore(); await f.domain.close?.(); f.cleanup(); }
});

test('a comparison in another registered project cannot be inspected through the wrong selected project', async () => {
  const f = setupReviewFixture();
  const other = join(f.root, 'other-project'); mkdirSync(other);
  new Lifecycle(f.store).registerProject('project-2', other);
  const read = vi.spyOn(harnessConfig, 'readComparison');
  try {
    expect(await f.domain.reviewSetup!({ comparison_path: f.input.comparison_path, project_id: 'project-2' }))
      .toEqual({ ready: false, issues: [{ field: 'registrations', code: 'shared_path_invalid' }] });
    expect(await f.domain.reviewSetup!({ ...f.input, project_id: 'project-2' }))
      .toEqual({ ready: false, issues: [{ field: 'registrations', code: 'shared_registration_mismatch' }] });
    expect(read).not.toHaveBeenCalled();
  } finally { read.mockRestore(); await f.domain.close?.(); f.cleanup(); }
});

test('path-only review requires an explicit registered project before reading comparison contents', async () => {
  const f = setupReviewFixture();
  const read = vi.spyOn(harnessConfig, 'readComparison');
  try {
    expect(await f.domain.reviewSetup!({ comparison_path: f.input.comparison_path }))
      .toEqual({ ready: false, issues: [{ field: 'project_id', code: 'shared_project_required' }] });
    expect(await f.domain.reviewSetup!({ comparison_path: f.input.comparison_path, project_id: 'unknown-project' }))
      .toEqual({ ready: false, issues: [{ field: 'registrations', code: 'unknown_project' }] });
    expect(read).not.toHaveBeenCalled();
  } finally { read.mockRestore(); await f.domain.close?.(); f.cleanup(); }
});

test('path-only inspection verifies actual manifest contents rather than trusting descriptor references', async () => {
  const f = setupReviewFixture();
  try {
    writeFileSync(join(f.project, 'harness-config/baseline/harness.md'), 'Synthetic tampered instruction\n');
    const review = await f.domain.reviewSetup!({ comparison_path: f.input.comparison_path, project_id: 'project-1' });
    expect(review).toEqual({ ready: false, issues: [{ field: 'registrations', code: 'shared_content_mismatch' }] });
    expect(f.store.all('SELECT * FROM comparison_variants')).toHaveLength(0);
  } finally { await f.domain.close?.(); f.cleanup(); }
});

test('an explicit full profile can review and save without a redundant template id', async () => {
  const f = setupReviewFixture();
  try {
    const { template_id: ignored, ...input } = f.input; void ignored;
    const review = await f.domain.reviewSetup!({ ...input, project_id: 'project-1' });
    expect(review.ready).toBe(true); if (!review.ready) throw new Error('review_failed');
    expect(f.store.all('SELECT * FROM comparison_protocols')).toHaveLength(0);
    const bound = await f.domain.saveReviewedSetup!(review.token);
    expect(bound).toMatchObject({ imported: true, already_connected: false });
    const repeat = await f.domain.reviewSetup!({ comparison_path: f.input.comparison_path, project_id: 'project-1', template_id: f.profile.id });
    expect(repeat.ready).toBe(true); if (!repeat.ready) throw new Error('review_failed');
    expect(repeat.profile).toEqual(f.profile);
    expect(repeat.protocol).toEqual(f.input.protocol);
    expect(f.store.all('SELECT * FROM comparison_protocols')).toHaveLength(1);
  } finally { await f.domain.close?.(); f.cleanup(); }
});

test('review lists missing registrations and incomplete input fields without writing', async () => {
  const f = setupReviewFixture(false);
  try {
    const { variants: ignoredVariants, price_table: ignoredPrice, freeze_at: ignoredFreeze, ...input } = f.input;
    void ignoredVariants; void ignoredPrice; void ignoredFreeze;
    const review = await f.domain.reviewSetup!(input);
    expect(review.ready).toBe(false); if (review.ready) throw new Error('unexpected_review');
    for (const issue of [
      { field: 'project:project-1', code: 'unknown_project' },
      { field: `variant:${f.input.protocol.variant_ids[0]}`, code: 'unknown_variant' },
      { field: `variant:${f.input.protocol.variant_ids[1]}`, code: 'unknown_variant' },
      { field: `price_table:${f.input.protocol.price_table_id}`, code: 'unknown_price_table' },
    ]) expect(review.issues).toContainEqual(issue);
    const incomplete = await f.domain.reviewSetup!({ ...f.input, protocol: { schema_version: 2 } });
    expect(incomplete.ready).toBe(false);
    if (!incomplete.ready) expect(incomplete.issues.some(issue => issue.field === 'protocol.sample_plan')).toBe(true);
    expect(f.store.all('SELECT * FROM comparison_variants')).toHaveLength(0);
    expect(f.store.all('SELECT * FROM comparison_protocols')).toHaveLength(0);
    expect(f.store.all('SELECT * FROM price_tables')).toHaveLength(0);
  } finally { await f.domain.close?.(); f.cleanup(); }
});

test('review rolls back production registrations until explicit save and reuses exact reviewed inputs', async () => {
  const f = setupReviewFixture();
  let restarted: ReturnType<typeof createLocalWebDomain> | undefined;
  try {
    const reviewed = await f.domain.reviewSetup!(f.input);
    expect(reviewed.ready).toBe(true); if (!reviewed.ready) throw new Error('review_failed');
    expect(reviewed.profile.setup.workflow.assignment.metadata.criterion_ids).toEqual(f.profile.setup.workflow.assignment.metadata.criterion_ids);
    expect(reviewed.protocol.variant_ids).toEqual(f.input.protocol.variant_ids);
    expect(f.store.all('SELECT * FROM comparison_variants')).toHaveLength(0);
    expect(f.store.all('SELECT * FROM comparison_protocols')).toHaveLength(0);
    expect(f.store.all('SELECT * FROM price_tables')).toHaveLength(0);
    const privateDb = new Database(f.metadataFile);
    expect(privateDb.prepare('SELECT * FROM web_profiles').all()).toHaveLength(0); privateDb.close();
    const bound = await f.domain.saveReviewedSetup!(reviewed.token);
    expect(bound).toMatchObject({ imported: true, already_connected: false });
    expect(f.store.get('SELECT frozen_at FROM comparison_protocols WHERE id=?', [f.input.protocol.id]))
      .toEqual({ frozen_at: f.input.freeze_at });
    const bytes = readFileSync(join(f.project, bound.local_setup_path));
    const repeat = await f.domain.reviewSetup!({ comparison_path: f.input.comparison_path, template_id: f.profile.id });
    expect(repeat.ready).toBe(true); if (!repeat.ready) throw new Error('review_failed');
    expect(repeat.profile).toEqual(reviewed.profile);
    const again = await f.domain.saveReviewedSetup!(repeat.token);
    expect(again).toMatchObject({ already_connected: true, profile_id: bound.profile_id });
    expect(readFileSync(join(f.project, bound.local_setup_path))).toEqual(bytes);
    expect(f.store.all('SELECT * FROM comparison_protocols')).toHaveLength(1);
    expect(f.store.all('SELECT * FROM comparison_variants')).toHaveLength(2);
    await f.domain.close?.();
    restarted = createLocalWebDomain({ store: f.store, metadataFile: f.metadataFile });
    const task = await restarted.createTask({ name: 'Synthetic prepared task', project_id: 'project-1', setup_id: bound.profile_id }) as { id: string };
    await restarted.taskAction(task.id, 'apply', {});
    expect(restarted.task(task.id).status).toBe('validation_ready');
    expect(f.store.all('SELECT * FROM comparison_assignments')).toHaveLength(1);
    expect(f.store.all('SELECT * FROM sessions')).toHaveLength(0);
    expect(f.store.eventCount()).toBe(0);
    expect(f.store.all('SELECT * FROM active_intervals')).toHaveLength(0);
  } finally { await restarted?.close?.(); if (!restarted) await f.domain.close?.(); f.cleanup(); }
});

test('production conflicts roll back a reviewed batch and never replace existing variants', async () => {
  const f = setupReviewFixture();
  try {
    const reviewed = await f.domain.reviewSetup!(f.input); if (!reviewed.ready) throw new Error('review_failed');
    const second = f.input.variants[1]; if (!second) throw new Error('synthetic_fixture_invalid');
    const conflicting = { ...second, policy_version: 'conflicting-policy' };
    registerVariant(f.store, conflicting);
    expect(() => f.domain.saveReviewedSetup!(reviewed.token)).toThrow('configuration_conflict');
    expect(f.store.all('SELECT id FROM comparison_variants')).toEqual([{ id: conflicting.id }]);
    expect(f.store.all('SELECT * FROM comparison_protocols')).toHaveLength(0);
    expect(f.store.all('SELECT * FROM price_tables')).toHaveLength(0);
    const privateDb = new Database(f.metadataFile);
    expect(privateDb.prepare('SELECT * FROM web_profiles').all()).toHaveLength(0); privateDb.close();
  } finally { await f.domain.close?.(); f.cleanup(); }
});

test('a changed portable descriptor invalidates review before any registrations are committed', async () => {
  const f = setupReviewFixture();
  try {
    const reviewed = await f.domain.reviewSetup!(f.input); if (!reviewed.ready) throw new Error('review_failed');
    const descriptor = JSON.parse(readFileSync(f.input.comparison_path, 'utf8')) as Record<string, unknown>;
    descriptor.name = 'Synthetic changed pair';
    // Keep the test descriptor valid by updating its canonical hash through the production hash function.
    const { settings_hash: ignored, ...fields } = descriptor; void ignored;
    const { canonicalJson, hashBytes } = await import('../src/harness-config.js');
    writeFileSync(f.input.comparison_path, JSON.stringify({ ...fields, settings_hash: hashBytes(`harness-delta:comparison:v1\n${canonicalJson(fields)}`) }));
    expect(() => f.domain.saveReviewedSetup!(reviewed.token)).toThrow('shared_preview_changed');
    expect(f.store.all('SELECT * FROM comparison_variants')).toHaveLength(0);
    expect(f.store.all('SELECT * FROM comparison_protocols')).toHaveLength(0);
  } finally { await f.domain.close?.(); f.cleanup(); }
});

test('review and save transport enforce authorization and exact idempotent replay', async () => {
  const f = setupReviewFixture(); const origin = 'http://127.0.0.1:4329';
  const app = createLocalWebServer({ origin, domain: f.domain, metadataFile: f.metadataFile });
  try {
    const headers = { host: '127.0.0.1:4329', origin, 'content-type': 'application/json' };
    expect((await app.inject({ method: 'POST', url: '/api/setup-review', headers, payload: f.input })).statusCode).toBe(403);
    const csrf = (await app.inject({ url: '/api/bootstrap', headers: { host: headers.host } })).json<{ csrf: string }>().csrf;
    const authorized = { ...headers, 'x-harness-csrf': csrf, 'idempotency-key': randomUUID() };
    const review = (await app.inject({ method: 'POST', url: '/api/setup-review', headers: authorized, payload: f.input })).json<{ token: string; ready: boolean }>();
    expect(review.ready).toBe(true);
    const payload = { token: review.token };
    const saved = await app.inject({ method: 'POST', url: '/api/setup-save-reviewed', headers: authorized, payload });
    expect(saved.statusCode).toBe(200);
    const bound = saved.json<SetupSaveResult>();
    expect(bound).toMatchObject({ imported: true, already_connected: false });
    expect(bound.profile_id).toMatch(/^shared-[a-f0-9]{64}$/);
    expect(existsSync(join(f.project, bound.local_setup_path))).toBe(true);
    expect((await app.inject({ method: 'POST', url: '/api/setup-save-reviewed', headers: authorized, payload })).body).toBe(saved.body);
    expect((await app.inject({ method: 'POST', url: '/api/setup-save-reviewed', headers: authorized, payload: { token: randomUUID() } })).statusCode).toBe(400);
    expect(f.store.all('SELECT * FROM tasks')).toHaveLength(0);
  } finally { await app.close(); f.cleanup(); }
});

test('failed and rolled-back reviews release shared previews across more than the bounded cache capacity', async () => {
  const f = setupReviewFixture();
  try {
    const invalid = { ...f.input, variants: f.input.variants.map(variant => ({ ...variant, instruction_manifest_hash: 'a'.repeat(64) })) };
    for (let index = 0; index < 70; index++) {
      expect(await f.domain.reviewSetup!(invalid)).toMatchObject({ ready: false, issues: [{ field: 'registrations', code: 'shared_registration_mismatch' }] });
    }
    const valid = await f.domain.reviewSetup!(f.input);
    expect(valid.ready).toBe(true); if (!valid.ready) throw new Error('review_failed');
    expect(await f.domain.saveReviewedSetup!(valid.token)).toMatchObject({ imported: true });
    expect(f.store.all('SELECT * FROM comparison_variants')).toHaveLength(2);
  } finally { await f.domain.close?.(); f.cleanup(); }
});

test('omitted freeze time reviews provisionally and freezes at actual confirmation without changing recruitment', async () => {
  const f = setupReviewFixture();
  const { freeze_at: ignored, ...input } = f.input; void ignored;
  const reviewedAt = new Date(Date.parse(input.protocol.recruitment_start) - 120000);
  const savedAt = new Date(reviewedAt.getTime() + 30000);
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(reviewedAt);
    const review = await f.domain.reviewSetup!(input);
    expect(review.ready).toBe(true); if (!review.ready) throw new Error('review_failed');
    expect(review.registrations).not.toHaveProperty('freeze_at');
    expect(f.store.all('SELECT * FROM comparison_protocols')).toHaveLength(0);
    const db = new Database(f.metadataFile);
    try { expect(db.prepare('SELECT * FROM web_profiles').all()).toHaveLength(0); } finally { db.close(); }
    expect(existsSync(join(f.project, '.harness-delta/setup'))).toBe(false);
    vi.setSystemTime(savedAt);
    const bound = await f.domain.saveReviewedSetup!(review.token);
    expect(bound.imported).toBe(true);
    expect(f.store.get('SELECT frozen_at,settings FROM comparison_protocols WHERE id=?', [input.protocol.id]))
      .toEqual({ frozen_at: savedAt.toISOString(), settings: JSON.stringify(input.protocol) });
    vi.setSystemTime(new Date(savedAt.getTime() + 10000));
    const reused = await f.domain.reviewSetup!({ comparison_path: input.comparison_path, template_id: f.profile.id });
    if (!reused.ready) throw new Error('review_failed');
    expect(await f.domain.saveReviewedSetup!(reused.token)).toMatchObject({ already_connected: true, profile_id: bound.profile_id });
    expect(f.store.get('SELECT frozen_at FROM comparison_protocols WHERE id=?', [input.protocol.id]))
      .toEqual({ frozen_at: savedAt.toISOString() });
  } finally { vi.useRealTimers(); await f.domain.close?.(); f.cleanup(); }
});

test('automatic confirmation at the recruitment boundary fails and rolls back the whole reviewed batch', async () => {
  const f = setupReviewFixture();
  const { freeze_at: ignored, ...input } = f.input; void ignored;
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    vi.setSystemTime(new Date(Date.parse(input.protocol.recruitment_start) - 30000));
    const review = await f.domain.reviewSetup!(input);
    if (!review.ready) throw new Error('review_failed');
    vi.setSystemTime(new Date(input.protocol.recruitment_start));
    expect(() => f.domain.saveReviewedSetup!(review.token)).toThrow('registration_too_late');
    expect(f.store.all('SELECT * FROM comparison_protocols')).toHaveLength(0);
    expect(f.store.all('SELECT * FROM comparison_variants')).toHaveLength(0);
    expect(f.store.all('SELECT * FROM price_tables')).toHaveLength(0);
    const db = new Database(f.metadataFile);
    try {
      expect(db.prepare('SELECT * FROM web_profiles').all()).toHaveLength(0);
      expect(db.prepare('SELECT * FROM web_shared_versions').all()).toHaveLength(0);
    } finally { db.close(); }
    expect(existsSync(join(f.project, '.harness-delta/setup'))).toBe(false);
    expect(await f.domain.reviewSetup!(input)).toMatchObject({ ready: false, issues: [{ code: 'registration_too_late' }] });
  } finally { vi.useRealTimers(); await f.domain.close?.(); f.cleanup(); }
});

test('binding profile failure removes only its new snapshot and rolls back freeze for clean retry', async () => {
  const f = setupReviewFixture();
  const db = new Database(f.metadataFile);
  try {
    const review = await f.domain.reviewSetup!(f.input);
    if (!review.ready) throw new Error('review_failed');
    db.exec("CREATE TRIGGER synthetic_bind_failure BEFORE INSERT ON web_profiles WHEN NEW.id LIKE 'shared-%' BEGIN SELECT RAISE(ABORT,'synthetic_bind_failure'); END");
    expect(() => f.domain.saveReviewedSetup!(review.token)).toThrow('synthetic_bind_failure');
    expect(f.store.all('SELECT * FROM comparison_protocols')).toHaveLength(0);
    expect(f.store.all('SELECT * FROM comparison_variants')).toHaveLength(0);
    expect(f.store.all('SELECT * FROM price_tables')).toHaveLength(0);
    expect(db.prepare('SELECT * FROM web_profiles').all()).toHaveLength(0);
    expect(db.prepare('SELECT * FROM web_shared_versions').all()).toHaveLength(0);
    expect(readdirSync(join(f.project, '.harness-delta/setup'))).toEqual([]);
    db.exec('DROP TRIGGER synthetic_bind_failure');
    expect(await f.domain.saveReviewedSetup!(review.token)).toMatchObject({ imported: true, already_connected: false });
  } finally { db.close(); await f.domain.close?.(); f.cleanup(); }
});

test('snapshot write failure rolls back registrations and the provisional profile', async () => {
  const f = setupReviewFixture();
  try {
    const review = await f.domain.reviewSetup!(f.input);
    if (!review.ready) throw new Error('review_failed');
    const directory = vi.spyOn(harnessConfig, 'ensureRepositoryDirectory').mockImplementation(() => { throw new Error('synthetic_write_failure'); });
    try { expect(() => f.domain.saveReviewedSetup!(review.token)).toThrow('synthetic_write_failure'); }
    finally { directory.mockRestore(); }
    expect(f.store.all('SELECT * FROM comparison_protocols')).toHaveLength(0);
    expect(f.store.all('SELECT * FROM price_tables')).toHaveLength(0);
    const db = new Database(f.metadataFile);
    try { expect(db.prepare('SELECT * FROM web_profiles').all()).toHaveLength(0); } finally { db.close(); }
    expect(await f.domain.saveReviewedSetup!(review.token)).toMatchObject({ imported: true });
  } finally { await f.domain.close?.(); f.cleanup(); }
});

test('binding failure preserves an already connected snapshot and its frozen registrations', async () => {
  const f = setupReviewFixture();
  const db = new Database(f.metadataFile);
  try {
    const first = await f.domain.reviewSetup!(f.input);
    if (!first.ready) throw new Error('review_failed');
    const bound = await f.domain.saveReviewedSetup!(first.token);
    const bytes = readFileSync(join(f.project, bound.local_setup_path));
    const before = f.store.all('SELECT * FROM comparison_protocols');
    const review = await f.domain.reviewSetup!({ comparison_path: f.input.comparison_path, template_id: f.profile.id });
    if (!review.ready) throw new Error('review_failed');
    db.exec("CREATE TRIGGER synthetic_rebind_failure BEFORE INSERT ON web_profiles WHEN NEW.id LIKE 'shared-%' BEGIN SELECT RAISE(ABORT,'synthetic_rebind_failure'); END");
    expect(() => f.domain.saveReviewedSetup!(review.token)).toThrow('synthetic_rebind_failure');
    expect(readFileSync(join(f.project, bound.local_setup_path))).toEqual(bytes);
    expect(f.store.all('SELECT * FROM comparison_protocols')).toEqual(before);
    expect(db.prepare('SELECT * FROM web_profiles').all()).toHaveLength(2);
    expect(db.prepare('SELECT * FROM web_shared_versions').all()).toHaveLength(2);
    db.exec('DROP TRIGGER synthetic_rebind_failure');
    expect(await f.domain.saveReviewedSetup!(review.token)).toMatchObject({ already_connected: true, profile_id: bound.profile_id });
  } finally { db.close(); await f.domain.close?.(); f.cleanup(); }
});

test('a measurement transaction failure preserves committed private snapshots for retry', async () => {
  const f = setupReviewFixture();
  try {
    const review = await f.domain.reviewSetup!(f.input);
    if (!review.ready) throw new Error('review_failed');
    const transaction = f.store.immediateTransaction.bind(f.store);
    let first = true;
    const interrupted = vi.spyOn(f.store, 'immediateTransaction').mockImplementation(action => {
      const outer = first; first = false;
      return transaction(() => {
        const result = action();
        if (outer) throw new Error('synthetic_measurement_commit_failure');
        return result;
      });
    });
    try { expect(() => f.domain.saveReviewedSetup!(review.token)).toThrow('synthetic_measurement_commit_failure'); }
    finally { interrupted.mockRestore(); }
    expect(f.store.all('SELECT * FROM comparison_protocols')).toHaveLength(0);
    const db = new Database(f.metadataFile);
    try {
      expect(db.prepare('SELECT * FROM web_profiles').all()).toHaveLength(2);
      expect(db.prepare('SELECT * FROM web_shared_versions').all()).toHaveLength(2);
    } finally { db.close(); }
    const files = readdirSync(join(f.project, '.harness-delta/setup'));
    expect(files).toHaveLength(1);
    expect(await f.domain.saveReviewedSetup!(review.token)).toMatchObject({ imported: true, already_connected: true });
    expect(readdirSync(join(f.project, '.harness-delta/setup'))).toEqual(files);
    expect(f.store.all('SELECT * FROM comparison_protocols')).toHaveLength(1);
  } finally { await f.domain.close?.(); f.cleanup(); }
});

test('review reports the comparison application mode and rejects a different selection without writing', async () => {
  const f = setupReviewFixture();
  try {
    const inspected = await f.domain.reviewSetup!({ comparison_path: f.input.comparison_path, project_id: 'project-1', application_mode: 'agent_applied' });
    expect(inspected).toMatchObject({ ready: false, comparison: { application_mode: 'selected_markdown_only' } });
    if (inspected.ready) throw new Error('unexpected_review');
    expect(inspected.issues).toContainEqual({ field: 'application_mode', code: 'application_mode_mismatch' });
    expect(await f.domain.reviewSetup!({ ...f.input, application_mode: 'agent_applied' }))
      .toEqual({ ready: false, issues: [{ field: 'registrations', code: 'application_mode_mismatch' }] });
    expect(f.store.all('SELECT * FROM comparison_protocols')).toHaveLength(0);
    expect(f.store.all('SELECT * FROM comparison_variants')).toHaveLength(0);
    expect(await f.domain.reviewSetup!({ ...f.input, application_mode: 'selected_markdown_only' }))
      .toMatchObject({ ready: true, application_mode: 'selected_markdown_only' });
  } finally { await f.domain.close?.(); f.cleanup(); }
});
