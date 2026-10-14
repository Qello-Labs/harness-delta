import type { ChildReadinessObservation } from './binding-child-readiness.js';
import { appendFamilyDiagnostic, takeFamilyDiagnostic } from './binding-family-diagnostics.js';
import {ApplicationSelectionSchema,ApplicationCheckpointSchema,ApplicationReportSchema,ApplicationIdentitySchema} from './harness-application-contract.js';
import {getApplicationLaunchCapability} from './harness-application-launch.js';
import { ApplicationCoordinator, applicationRequired, effectiveTaskWorkspace } from './harness-application.js';

import { SharedBindingSchema, assertSharedTask } from './local-web-shared-guard.js';
import { createSharedSetupManager } from './local-web-shared.js';
import { createSetupReviewManager } from './local-web-setup-review.js';
import { externalContract } from './external-session-contract.js';
import { createHash, randomUUID } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { constants, closeSync, fstatSync, mkdirSync, openSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { Lifecycle } from './lifecycle.js';
import { Store } from './store.js';
import { comparisonProtocol, protocolRow } from './comparison.js';
import { CodexWorkflowExecutionSchema } from './codex-workflow-adapter.js';
import { recoverCodexWorkflow } from './codex-workflow-journal.js';
import { ExternalTaskSetupSchema, buildExternalTaskSetup, createExternalTask, prepareExternalTask, issueExternalStartTicket, connectExternalTask, collectExternalTask, pauseExternalTask, externalTaskState, recordExternalTaskOutcome, externalTaskResult } from './external-session-service.js';
import type { ExternalTaskSetup } from './external-session-service.js';
import type { WorkflowAdapter } from './task-workflow.js';
import { bindingCollectionControl, registerBindingCollectionControl, revokeBindingCollectionControl } from './external-session-contract.js';
import { releaseExternalWorkflow } from './external-session-workflow.js';
import { readOnlinePriceCatalogStatus, refreshOnlinePriceCatalog } from './price-catalog-online.js';
import { localWebError, type LocalWebDomain } from './local-web-server.js';
import { createSessionBindingService, type BindingObservation } from './session-binding-service.js';
import { ClaudeSessionBindingProvider, type ClaudeBindingOptions } from './session-binding-claude.js';
import { CodexSessionBindingProvider, codexRootPilotVersions } from './session-binding-codex.js';
import { resolveSourceCompatibility, effectiveSourceCompatibility } from './source-compatibility.js';
import { functionalWorkflowEligible, comparisonReadiness } from './readiness-store.js';
import { parseProtocol, parseTaskMetadata } from './flexible-contracts.js';
import type { BindingQualificationLease } from './session-binding-qualification-lease.js';
import { assertBindingQualification, bindingQualificationOwnerLive, revokeBindingQualification, noteQualificationCollectorError } from './session-binding-qualification-lease.js';
import { issueCodexHumanPilotScope, assertHumanPilotScope, isHumanPilotProtocol, codexRootHumanPilotProfileId, type HumanPilotScope } from './session-binding-human-pilot.js';
import type { BindingProduct, SessionBindingProvider } from './session-binding-contract.js';
import { issueClaudeHumanPilotScope, assertClaudeHumanPilotSource, isClaudeHumanPilotScope } from './session-binding-claude-human-pilot.js';
import { setTimeout as delay } from 'node:timers/promises';
import { codexBindingAdmission, isAdmittedCodexBindingProtocol } from './codex-binding-admission.js';
import {
  assertOrdinaryTaskPrepared, createOrdinaryTask, ordinaryTask,
  ordinaryTaskSettings, OrdinaryProjectSettingsSchema, revokeOrdinaryObservation,
} from './ordinary-observation.js';
import { ordinaryProjectAction, ordinaryProjectDto } from './local-web-ordinary.js';
import { createOrdinarySessionBindingService } from './ordinary-session-binding.js';
import { claudeBindingAdmission } from './claude-binding-admission.js';
import { inspectClaudeProjectSkill, inspectOrdinaryClaudeProjectSkill } from './claude-connect-readiness.js';

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/);
const executionFields = CodexWorkflowExecutionSchema.shape;
/** Existing reviewed inputs only. No protocol, pricing or criterion defaults are invented here. */
export const LocalWebProfileSchema = z.strictObject({
  id: identifier, name: z.string().trim().min(1).max(200), setup: ExternalTaskSetupSchema,
  execution: z.strictObject({ binary: executionFields.binary, codex_home: executionFields.codex_home,
    hook_recorder: executionFields.hook_recorder, sandbox: executionFields.sandbox,
    timeout_ms: executionFields.timeout_ms, poll_ms: executionFields.poll_ms }),
  shared_binding: SharedBindingSchema.optional(),
  session_binding: z.discriminatedUnion('product', [
    z.strictObject({ product: z.literal('codex'), receipt_directory: z.string().min(1), source_roots: z.array(z.string().min(1)).min(1).max(16), project_root: z.string().min(1) }),
    z.strictObject({ product: z.literal('claude_code'), receipt_directory: z.string().min(1), claude_projects_directory: z.string().min(1) }),
  ]).optional(),
});
export const LocalWebManifestSchema = z.strictObject({ schema_version: z.literal(1), profiles: z.array(LocalWebProfileSchema).max(64) });
export type LocalWebProfile = z.infer<typeof LocalWebProfileSchema>;
export function localWebSupport(store: Store, profile: LocalWebProfile) {
  const workflow = profile.setup.workflow;
  const protocolRecord = protocolRow(store, workflow.assignment.protocol_id);
  const protocol = parseProtocol(JSON.parse(protocolRecord.settings) as unknown);
  const synthetic = workflow.assignment.metadata.product === 'synthetic' || protocol.schema_version === 2 && protocol.purpose === 'synthetic_validation';
  const familyPilot = protocol.schema_version === 2 && isHumanPilotProtocol(protocol);
  const rootPilot = familyPilot && protocol.schema_version === 2 && protocol.source_profiles[0]?.profile_id === codexRootHumanPilotProfileId;
  const ordinaryFamily = protocol.schema_version === 2 && isAdmittedCodexBindingProtocol(protocol);
  const parserCompatibility = ordinaryFamily
    ? resolveSourceCompatibility('codex',workflow.product_version,'codex_binding',codexBindingAdmission.profileId)
    : rootPilot ? resolveSourceCompatibility('codex', workflow.product_version, 'codex_workflow', 'codex-workflow-own-response-v1') : null;
  const parserState=parserCompatibility?effectiveSourceCompatibility(store,parserCompatibility):null;
  const launchAllowed = !ordinaryFamily && protocolRecord.status === 'frozen' && protocol.schema_version === 2 && (functionalWorkflowEligible(store, protocol) || comparisonReadiness(store, protocol.id).real_allocation);
  const launch = protocol.schema_version === 2 ? protocol.source_profiles.map(source => {
    const compatibility = source.product === 'synthetic' || ordinaryFamily ? null : resolveSourceCompatibility(source.product, source.product_version,
      source.product === 'codex' ? 'codex_workflow' : 'claude_workflow', source.profile_id);
    return { profile_id: source.profile_id, state: !synthetic && launchAllowed && compatibility ? effectiveSourceCompatibility(store, compatibility).state : 'unsupported' };
  }) : [];
  return {
    context: synthetic ? 'synthetic_validation_only' : 'real',
    connection_route: synthetic ? 'synthetic' : profile.session_binding || familyPilot ? 'family' : 'ticket',
    product: workflow.assignment.metadata.product, product_version: workflow.product_version,
    launch,
    ticket: synthetic ? 'synthetic_validation_only' : workflow.assignment.metadata.product === 'codex' && workflow.product_version === '0.160.0' ? 'exact_version_only' : 'unsupported',
    family: synthetic ? 'synthetic_validation_only' : protocolRecord.status === 'frozen' && ordinaryFamily && parserState?.state!=='invalidated' ? 'verified_bounded_family' : protocolRecord.status === 'frozen' && familyPilot ? rootPilot ? 'candidate_root_pilot' : 'candidate_pilot' : 'qualification_required',
    ...(parserState ? { family_parser_compatibility: parserState } : {}),
    complete_cost: false, inference: false,
  };
}
interface PrivateTask { id: string; name: string; profile_id: string; setup: string; startup: string | null; source: string | null; reason: string | null; }
interface Source { handle: string; label: string; path: string; session_id: string; }
interface Job { promise: Promise<void>; pauseRequested: boolean; }
export interface LocalWebDomainOptions {
  store: Store; metadataFile: string; profiles?: LocalWebProfile[];
  picker?: (kind: 'project' | 'session' | 'setup') => Promise<string | null>;
  adapterFactory?: (store: Store, execution: unknown) => WorkflowAdapter;
  bindingProviders?: SessionBindingProvider[];
  /** Internal consumed, isolated qualification intent; never profile/browser input. */
  qualificationLease?: BindingQualificationLease;
  /** Trusted execution instrumentation; does not grant collection authority. */
  bindingObservation?: BindingObservation;
  /** Local operator selection only; profiles and browser requests cannot activate it. */
  nativePilot?: { taskId: string; observe: boolean; untilExplicitStop?: boolean };
  /** Opt-in local pilot instrumentation only; never browser/profile input. */
  onChildReadiness?: (observation: Readonly<ChildReadinessObservation>) => void;
  /** Trusted fixture injection only; browser/profile flags cannot enable admission. */
  bindingProviderFactory?: (taskId: string, projectRoot: string,
    ordinaryCallbacks?: Pick<ClaudeBindingOptions, 'authorizeSource' | 'memberEligible'>) => SessionBindingProvider[];
}
const runFile = promisify(execFile);
/** Constant AppleScript only; no browser-provided command or script is executed. */
export async function nativeLocalPicker(kind: 'project' | 'session' | 'setup'): Promise<string | null> {
  if (process.platform !== 'darwin') throw new Error('picker_unavailable');
  const script = kind === 'project' ? 'POSIX path of (choose folder with prompt "Choose the measurement project")'
    : kind === 'session' ? 'POSIX path of (choose file with prompt "Choose the exact new Codex session JSONL")'
      : 'POSIX path of (choose file with prompt "Choose an existing reviewed Harness Delta UI setup")';
  try { const result = await runFile('/usr/bin/osascript', ['-e', script], { timeout: 120000, maxBuffer: 8192 }); return result.stdout.trim() || null; }
  catch (error) { if (error instanceof Error && 'stderr' in error && String(error.stderr).includes('(-128)')) return null; throw new Error('picker_unavailable', { cause: error }); }
}
export function readLocalWebSetupDocument(path: string): unknown {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd); if (!stat.isFile() || stat.size > 1048576) throw new Error('invalid_ui_setup');
    return JSON.parse(readFileSync(fd, 'utf8')) as unknown;
  } finally { if (fd !== undefined) closeSync(fd); }
}
export function readLocalWebManifest(path: string) { return LocalWebManifestSchema.parse(readLocalWebSetupDocument(path)); }
/** Reads the current commit; it never creates a commit or changes the checkout. */
export function projectBaseline(directory: string): string {
  try {
    const value = execFileSync('git', ['-C', directory, 'rev-parse', '--verify', 'HEAD'], { encoding: 'utf8', timeout: 5000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) throw new Error(); return value;
  } catch { throw new Error('git_baseline_unavailable'); }
}

/** UI labels and private native handoffs stay outside the measurement Store. */
export function createLocalWebDomain(options: LocalWebDomainOptions): LocalWebDomain {
  if(options.nativePilot&&(options.qualificationLease||options.bindingProviders||options.bindingProviderFactory))throw new Error('binding_pilot_scope_invalid');
  const store = options.store; const life = new Lifecycle(store);
  mkdirSync(dirname(options.metadataFile), { recursive: true, mode: 0o700 });
  const privateDb = new Database(options.metadataFile);
  privateDb.pragma('busy_timeout = 5000');
  privateDb.exec(`CREATE TABLE IF NOT EXISTS web_profiles(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS web_tasks(id TEXT PRIMARY KEY,name TEXT NOT NULL,profile_id TEXT NOT NULL,setup TEXT NOT NULL,startup TEXT,source TEXT,reason TEXT);
    CREATE TABLE IF NOT EXISTS web_sources(handle TEXT PRIMARY KEY,task_id TEXT NOT NULL,payload TEXT NOT NULL)`);
  const jobs = new Map<string, Job>(); const picker = options.picker ?? nativeLocalPicker;
  const saveProfiles = (inputs: LocalWebProfile[]) => privateDb.transaction(() => {
    let addedCount = 0; let existingCount = 0;
    for (const input of inputs) {
      const profile = LocalWebProfileSchema.parse(input);
      // Replacing an existing definition would silently change a user's setup.
      const old = privateDb.prepare('SELECT payload FROM web_profiles WHERE id=?').get(profile.id) as { payload: string } | undefined;
      if (old && old.payload !== JSON.stringify(profile)) throw new Error('ui_setup_conflict');
      const saved = privateDb.prepare('INSERT OR IGNORE INTO web_profiles(id,payload) VALUES (?,?)').run(profile.id, JSON.stringify(profile));
      addedCount += saved.changes;
      if (saved.changes === 0) existingCount++;
    }
    return { addedCount, existingCount };
  })();
  saveProfiles(options.profiles ?? []);
  const profiles = () => (privateDb.prepare('SELECT payload FROM web_profiles ORDER BY rowid').all() as { payload: string }[]).map(p => LocalWebProfileSchema.parse(JSON.parse(p.payload) as unknown));
  const applications=new ApplicationCoordinator(store,()=>[options.metadataFile,...profiles().flatMap(profile=>[profile.execution.codex_home,...(profile.session_binding?.product==='codex'?[profile.session_binding.receipt_directory,...profile.session_binding.source_roots]:profile.session_binding?[profile.session_binding.receipt_directory,profile.session_binding.claude_projects_directory]:[])])]);
  const sharedSetups = createSharedSetupManager(store, privateDb, profiles, saveProfiles);
  const setupReviews = createSetupReviewManager(store, privateDb, profiles, saveProfiles, sharedSetups);
  const row = (id: string) => {
    const result = privateDb.prepare('SELECT * FROM web_tasks WHERE id=?').get(id) as PrivateTask | undefined;
    if (!result) throw new Error('unknown_task');
    if(store.get("SELECT 1 FROM tombstones WHERE kind='task' AND id=?",[id]))throw new Error('unknown_task');
    if(!store.get('SELECT id FROM tasks WHERE id=?',[id])){const setup=ExternalTaskSetupSchema.parse(JSON.parse(result.setup) as unknown);if(!profileFor(result.profile_id).shared_binding||!store.get('SELECT id FROM projects WHERE id=?',[setup.workflow.assignment.project_id]))throw new Error('unknown_task');}
    return result;
  };
  const setupFor = (task: PrivateTask) => ExternalTaskSetupSchema.parse(JSON.parse(task.setup) as unknown);
  const profileFor = (id: string) => { const result = profiles().find(p => p.id === id); if (!result) throw new Error('unknown_setup'); return result; };
  const sourceFor = (task: PrivateTask) => task.source === null ? null : JSON.parse(task.source) as Source;
  const executionFor = (task: PrivateTask, operation: 'link' | 'collect', source: Source) => CodexWorkflowExecutionSchema.parse({
    ...profileFor(task.profile_id).execution, run_id: randomUUID(), operation, session_id: source.session_id, source_path: source.path,
  });
  const running = (id: string) => store.all<{ id: string; stop_requested: number }>("SELECT id,stop_requested FROM codex_workflow_runs WHERE task_id=? AND state='running'", [id]);
  for (const record of privateDb.prepare('SELECT * FROM web_tasks').all() as PrivateTask[]) {
    if(store.get("SELECT 1 FROM tombstones WHERE kind='task' AND id=?",[record.id]))continue;
    if (record.profile_id === 'ordinary-claude') continue;
    const profile=profileFor(record.profile_id);if(!profile.shared_binding)continue;
    try{const pins=sharedSetups.journalTask(profile,record.id,true)!;store.execute('INSERT OR IGNORE INTO shared_configuration_tasks(task_id,project_id,settings_hash,setup_hash) VALUES(?,?,?,?)',[record.id,setupFor(record).workflow.assignment.project_id,pins.settingsHash,pins.setupHash]);}
    catch{privateDb.prepare('UPDATE web_tasks SET reason=? WHERE id=?').run('shared_binding_changed',record.id);}
  }
  const providers = new Map<string, SessionBindingProvider[]>();
  const providersForTask = (id: string, deletedProjectRoot?: string): SessionBindingProvider[] => {
      if (options.bindingProviders) return options.bindingProviders;
      if (providers.has(id)) return providers.get(id)!;
      const projectRoot = deletedProjectRoot ?? effectiveTaskWorkspace(store,id);
      if (!projectRoot) throw new Error('binding_scope_mismatch');
      if (options.bindingProviderFactory) {
        const callbacks = ordinaryTask(store, id) ? {
          authorizeSource: (source: Parameters<NonNullable<ClaudeBindingOptions['authorizeSource']>>[0]) => ordinaryBindings.assertSource(id, source),
          memberEligible: (member: Parameters<NonNullable<ClaudeBindingOptions['memberEligible']>>[0]) => ordinaryBindings.memberEligible(id, member),
        } : undefined;
        const result = options.bindingProviderFactory(id, projectRoot, callbacks); providers.set(id, result); return result;
      }
      const record = privateDb.prepare('SELECT * FROM web_tasks WHERE id=?').get(id) as PrivateTask | undefined;
      if (!record) return [];
      if (record.profile_id === 'ordinary-claude') {
        const config = ordinaryTask(store, id) ? ordinaryTaskSettings(store, id) :
          OrdinaryProjectSettingsSchema.parse(JSON.parse(record.setup));
        const result = [new ClaudeSessionBindingProvider({
          receiptDir: config.receipt_directory, claudeProjectsDir: config.claude_projects_directory,
          projectRoot, ordinaryAdmission: true, maxFamilyMembers: claudeBindingAdmission.maxFamilyMembers,
          authorizeSource: source => ordinaryBindings.assertSource(id, source),
          memberEligible: member => ordinaryBindings.memberEligible(id, member),
        })];
        providers.set(id, result);
        return result;
      }
      const protocol = comparisonProtocol(store,protocolRow(store,setupFor(record).workflow.assignment.protocol_id));
      const ordinaryFamily = !options.qualificationLease && !options.nativePilot && protocol.schema_version === 2 && isAdmittedCodexBindingProtocol(protocol);
      const config = profileFor(record.profile_id).session_binding;
      if (!config) return [];
      if (config.product === 'codex' && !applicationRequired(store,id) && config.project_root !== projectRoot) throw new Error('binding_scope_mismatch');
      const result = config.product === 'codex'
        ? [new CodexSessionBindingProvider({ receiptDirectory: config.receipt_directory, sourceRoots: config.source_roots, projectRoot,
          ...(setupFor(record).workflow.assignment.metadata.product==='synthetic' ? {} : {productVersion:setupFor(record).workflow.product_version}),
          ...(options.qualificationLease ? {maxDepth:1,maxFamilyMembers:3,
            ...(setupFor(record).workflow.product_version==='0.162.1'?{ordinaryFamilyQualification:true}:{})} : options.nativePilot ? {maxDepth:1,maxFamilyMembers:codexRootPilotVersions.some(version=>version===setupFor(record).workflow.product_version)?1:3} : {}),
          ...(ordinaryFamily ? { ordinaryFamilyAdmission:true,maxDepth:codexBindingAdmission.maxDepth,maxFamilyMembers:codexBindingAdmission.maxFamilyMembers } : {}),
          ...(options.nativePilot?.observe && options.nativePilot.taskId===id && codexRootPilotVersions.some(version=>version===setupFor(record).workflow.product_version) ? {ordinaryRootPilot:true} : {}) })]
        : [new ClaudeSessionBindingProvider({ receiptDir: config.receipt_directory, claudeProjectsDir: config.claude_projects_directory, projectRoot, ...(options.nativePilot ? { allowCandidateProfiles: true, maxFamilyMembers: 3, authorizeSource: source => { if (!humanPilot || options.nativePilot?.taskId !== id) throw new Error('binding_source_unqualified'); assertClaudeHumanPilotSource(humanPilot, store, id, source); } } : {}) })];
      providers.set(id, result); return result;

  };
  let humanPilot: HumanPilotScope | undefined;
  if(options.nativePilot) {
    const provider=providersForTask(options.nativePilot.taskId)[0];
    if(!(provider instanceof CodexSessionBindingProvider) && !(provider instanceof ClaudeSessionBindingProvider))throw new Error('binding_pilot_scope_invalid');
    // Issuance inspects task/protocol metadata only; preparation grants no reads.
    const scope = provider instanceof ClaudeSessionBindingProvider ? issueClaudeHumanPilotScope(store, options.nativePilot.taskId, provider, { untilExplicitStop: options.nativePilot.untilExplicitStop === true }) : issueCodexHumanPilotScope(store,options.nativePilot.taskId,provider,{untilExplicitStop:options.nativePilot.untilExplicitStop===true});
    if(options.nativePilot.observe)humanPilot=scope;
  }
  const familyDiagnosticsEnabled = !!humanPilot && isClaudeHumanPilotScope(humanPilot);
  const writeFamilyDiagnostic = (diagnostic: unknown) => appendFamilyDiagnostic(options.metadataFile + '.family-diagnostics.jsonl',diagnostic);
  const legacyBindings = createSessionBindingService({store,providers:options.bindingProviders??[],setupFor:id=>setupFor(row(id)),providersForTask,
    ...(options.bindingObservation ? {bindingObservation:options.bindingObservation} : {}),
    ...(options.qualificationLease ? {qualificationLease:options.qualificationLease} : {}),
    ...(humanPilot ? {humanPilot, ...(familyDiagnosticsEnabled ? {onFamilyRejection:writeFamilyDiagnostic, ...(options.onChildReadiness ? {onChildReadiness:options.onChildReadiness} : {})} : {})} : {}),
    syntheticProviderForTask(provider,id){return !!options.bindingProviderFactory&&!!providers.get(id)?.includes(provider);},
  });
  const ordinaryBindings = createOrdinarySessionBindingService({ store, providersForTask,
    syntheticProviderForTask: () => options.bindingProviders !== undefined || options.bindingProviderFactory !== undefined });
  const selectedService = (id: string) => ordinaryTask(store, id) ? ordinaryBindings : legacyBindings;
  const bindings = {
    status: (id: string) => selectedService(id).status(id),
    pause: (id: string) => selectedService(id).pause(id),
    resumeAvailable: (id: string) => selectedService(id).resumeAvailable(id),
    sourceSupported: (id: string, product: BindingProduct) => selectedService(id).sourceSupported(id, product),
    capabilities: (id: string, product: BindingProduct) => selectedService(id).capabilities(id, product),
    connect: (id: string, product: BindingProduct, input: { receipt: string }) => selectedService(id).connect(id, product, input),
    resume: (id: string) => selectedService(id).resume(id),
    tick: (id: string) => selectedService(id).tick(id),
    flushForgotten: async () => { await legacyBindings.flushForgotten(); await ordinaryBindings.flushForgotten(); },
  };
  // A newly opened server never resumes an unobserved interval from a persisted
  // cursor. No native source is touched here; reconnect always baselines again.
  for (const task of store.all<{task_id: string}>("SELECT DISTINCT task_id FROM session_bindings WHERE state='observing'")) {
    if (!ordinaryTask(store, task.task_id)) legacyBindings.pause(task.task_id);
  }
  const beginBindingObservation = (id: string) => {
    if (jobs.has(id)) return;
    const job: Job = { promise: Promise.resolve(), pauseRequested: false }; jobs.set(id, job);
    job.promise = (async () => {
      try {
        while (!job.pauseRequested && store.get<{state: string}>('SELECT state FROM tasks WHERE id=?', [id])?.state === 'active') {
          await bindings.tick(id); await delay(250);
        }
      } catch (error) {
        const expectedPause = job.pauseRequested && error instanceof Error && error.message === 'binding_scope_revoked';
        if (!expectedPause) options.bindingObservation?.error(error);
        if (store.get('SELECT id FROM tasks WHERE id=?', [id])) {
          const diagnostic = familyDiagnosticsEnabled && options.nativePilot?.taskId === id && !job.pauseRequested ? takeFamilyDiagnostic(error,id,store) : null;
          privateDb.prepare('UPDATE web_tasks SET reason=? WHERE id=?').run(expectedPause ? 'measurement_paused' : localWebError(error), id);
          if (!expectedPause && options.qualificationLease) { noteQualificationCollectorError(options.qualificationLease,error); revokeBindingQualification(options.qualificationLease); }
          try{bindings.pause(id);}catch(pauseError){
            // Pause fences are durable even when a clock/gap write fails.
            if(options.qualificationLease)noteQualificationCollectorError(options.qualificationLease,pauseError);
          }
          if(diagnostic)writeFamilyDiagnostic(diagnostic);
        }
      } finally { jobs.delete(id); }
    })();
  };
  const taskDto = (id: string) => {
    const record = row(id);
    if (ordinaryTask(store, id)) return ordinaryTaskDto(id, record);
    const setup = setupFor(record); const task = store.get('SELECT id FROM tasks WHERE id=?',[id])?life.task(id):{id,project_id:setup.workflow.assignment.project_id,state:'registered' as const};
    const supportDetails = localWebSupport(store, profileFor(record.profile_id));
    if (!externalContract(store,id) || (task.state!=='finalized' && record.reason?.startsWith('shared_') && externalContract(store,id)?.started_at===null)) {
      const assignment=store.get<{variant_id:string}>('SELECT variant_id FROM comparison_assignments WHERE task_id=?',[id]);
      const reason=record.reason??'external_preparation_required';
      const nativeApplication=!!setup.workflow.application;
      const blockedApplication=nativeApplication?{state:'blocked_configuration',jobId:null,epoch:0,reason,workspace:null,launchState:'not_requested',identity:'unavailable',capabilities:[getApplicationLaunchCapability('codex'),getApplicationLaunchCapability('claude_code')],baseline:setup.workflow.assignment.code_base_commit}:undefined;
      return {id,name:record.name,project_id:task.project_id,setup_id:record.profile_id,version:'"'+createHash('sha256').update(JSON.stringify({task,record})).digest('hex')+'"',state:task.state,status:'blocked_configuration',...(blockedApplication?{application:blockedApplication}:{}),
        support_details:supportDetails,measurement:{state:'waiting_connection',active_ms:null,requests:null,window:{started_at:null,ends_at:null}},outcome:null,attempt:1,
        preparation:{state:'blocked_configuration',configuration_evidence:'unverified',native_context_evidence:'unverified',freshness_evidence:'unverified',tool_use_evidence:'unavailable',assigned_variant_id:assignment?.variant_id??null},
        price:{partial_amount:null,currency:'USD',unpriced_events:0,basis:null},criteria:setup.workflow.assignment.metadata.criterion_ids,startup:null,source:null,reason,
        actions:[{code:'prepare',enabled:task.state!=='finalized',reason:null},...(!nativeApplication?[{code:'apply',enabled:task.state!=='finalized',reason:null}]:[])]};
    }
    const application=applicationRequired(store,id)?{...applications.status(id),capabilities:[getApplicationLaunchCapability('codex'),getApplicationLaunchCapability('claude_code')],baseline:setup.workflow.assignment.code_base_commit}:undefined;
    const state = externalTaskState(store, id);
    const result = externalTaskResult(store, id); const runs = running(id); const active = runs.length > 0 || jobs.has(id);
    const finalized = task.state === 'finalized'; const connected = state.window.started_at !== null;
    const supported = setup.workflow.assignment.metadata.product !== 'claude_code';
    const ready = application
      ? application.state === 'applied' && application.identity === 'verified_metadata'
      : state.configuration_evidence === 'verified_at_preparation' && state.state !== 'released';
    const source = sourceFor(record); const startup = record.startup === null ? null : JSON.parse(record.startup) as { ticket_id: string; start_command: string };
    const binding = bindings.status(id); const bindingProduct = profileFor(record.profile_id).session_binding?.product ?? options.bindingProviders?.[0]?.product ?? providers.get(id)?.[0]?.product ?? (setup.workflow.assignment.metadata.product === 'claude_code' ? 'claude_code' : 'codex'); let bindingAvailable = false;
    try { bindings.capabilities(id, bindingProduct); bindingAvailable = true; } catch { /* Missing instrumentation is explicit; no native discovery here. */ }
    let ordinaryAvailable = false;
    try { ordinaryAvailable = bindings.sourceSupported(id, bindingProduct); } catch { /* Missing/unqualified sources cannot enable an action. */ }
    let qualificationAvailable = false;
    try { qualificationAvailable = bindingQualificationOwnerLive(options.qualificationLease) && assertBindingQualification(options.qualificationLease, store, id); } catch { /* A revoked lease cannot enable a browser action. */ }
    const ownedNativeLive = bindingQualificationOwnerLive(options.qualificationLease);
    let pilotAvailable=false;
    try{if(humanPilot){assertHumanPilotScope(humanPilot,store,id,providersForTask(id)[0]);pilotAvailable=true;}}catch{/* Exact pilot task only. */}
    const bindingAuthorized = options.qualificationLease ? qualificationAvailable : humanPilot ? pilotAvailable : ordinaryAvailable;
    const reason = ownedNativeLive ? 'owned_native_running' : finalized ? 'finalized' : active ? 'observation_running' : !connected ? 'external_connection_required' : null;
    const action = (code: string, enabled: boolean, why: string | null = null) => ({ code, enabled, reason: enabled ? null : why });
    const explicitStop = state.collection_end_condition === 'explicit_stop' && !options.qualificationLease;
    const canFinish = !finalized && (!active || explicitStop && binding.roots > 0) && !ownedNativeLive && connected;
    const qualificationActions=new Set(['session-connect','pause','resume-binding','emergency-stop']);
    const actions = [
      ...(application?[action('application-prepare',!finalized&&!active&&['awaiting_application','failed','abandoned'].includes(application.state),'application_required'),action('application-open',!finalized&&!active&&application.state==='awaiting_session','application_required'),action('application-cancel',!finalized&&!active&&!!application.jobId&&['awaiting_session','applying','applied','failed'].includes(application.state),'application_required')]:[]),
      action('apply', !finalized && !active && !ready, finalized ? 'finalized' : active ? 'workflow_run_active' : 'configuration_ready'),
      action('ticket', !finalized && !active && ready && state.window_status !== 'closed' && supported, !supported ? 'external_collection_unsupported' : finalized ? 'finalized' : active ? 'workflow_run_active' : 'external_preparation_required'),
      action('connect', !finalized && !active && startup !== null && ready && state.window_status !== 'closed' && supported, !supported ? 'external_collection_unsupported' : active ? 'workflow_run_active' : 'external_ticket_required'),
      action('session-connect', !finalized && ready && state.window_status !== 'closed' && bindingAvailable && bindingAuthorized, !bindingAvailable ? 'binding_provider_unavailable' : !bindingAuthorized ? 'binding_source_unqualified' : finalized ? 'finalized' : !ready ? 'external_preparation_required' : 'external_window_closed'),
      action('observe', binding.roots === 0 && !finalized && !active && !ownedNativeLive && connected && source !== null && ready && state.window_status !== 'closed' && supported, binding.roots > 0 ? 'binding_reconnect_required' : reason ?? (state.window_status === 'closed' ? 'external_window_closed' : 'external_connection_required')),
      action('resume-binding', bindingAuthorized && ready && state.window_status !== 'closed' && task.state === 'paused' && bindings.resumeAvailable(id), !bindingAuthorized ? 'binding_source_unqualified' : task.state === 'active' ? 'observation_running' : task.state === 'finalized' ? 'finalized' : 'binding_reconnect_required'),
      action('emergency-stop', ownedNativeLive, 'owned_native_inactive'),
      action('revoke-collection', explicitStop && !finalized && !bindingCollectionControl(store,id)?.revoked_at, 'binding_scope_revoked'),
      action('pause', !finalized && (active || task.state === 'active'), 'inactive_observation'),
      action('rework', !finalized && !active && !ownedNativeLive && connected && state.window_status !== 'closed', reason ?? 'external_window_closed'),
      action('finish-success', canFinish, reason),
      action('finish-failed', canFinish, reason),
      action('finish-abandoned', canFinish, reason),
      action('recover', runs.length > 0 && !jobs.has(id), 'inactive_observation'),
      action('release', !active && state.state !== 'released', 'workflow_run_active'),
    ].map(a=>application&&['apply','ticket','connect'].includes(a.code)?{...a,enabled:false,reason:'application_native_loading_unqualified'}:a).map(a=>options.qualificationLease&&!qualificationActions.has(a.code)?{...a,enabled:false,reason:'binding_qualification_control_only'}:options.nativePilot&&(id!==options.nativePilot.taskId||!['apply','pause','revoke-collection','session-connect','resume-binding','finish-success','finish-failed','finish-abandoned','release'].includes(a.code))?{...a,enabled:false,reason:'binding_pilot_control_only'}:a);
    const version = '"' + createHash('sha256').update(JSON.stringify({ task, application, control: { revision: state.revision, window: state.window, configuration_evidence: state.configuration_evidence }, record, collectionControl:bindingCollectionControl(store,id), runs, ownJob: jobs.has(id) })).digest('hex') + '"';
    const measurementState = finalized ? 'measurement_ended' : active ? (state.state === 'measuring' ? 'active' : 'starting') : task.state === 'active' ? 'connected' : connected ? 'paused' : 'waiting_connection';
    const status = state.outcome ?? (measurementState === 'waiting_connection' ? ready ? supportDetails.context === 'synthetic_validation_only' ? 'validation_ready' : 'waiting_for_session' : 'draft' : measurementState);
    const connectionReadiness = ready && supportDetails.context === 'real' && supportDetails.connection_route === 'family' && bindingProduct === 'claude_code'
      ? { skill: inspectClaudeProjectSkill(effectiveTaskWorkspace(store, id)), configured_version: setup.workflow.product_version,
        installed_version: null, collection_revoked: !!bindingCollectionControl(store, id)?.revoked_at } : undefined;
    return { id, name: record.name, project_id: task.project_id, setup_id: record.profile_id, version, ...(application?{application}:{}), state: task.state, status, support_details: supportDetails,
      ...(connectionReadiness ? { connection_readiness: connectionReadiness } : {}),
      measurement: { state: measurementState, active_ms: result.time.active_ms, requests: result.cost?.event_count ?? null, window: state.window, end_condition: state.collection_end_condition },
      outcome: state.outcome === null ? null : { status: state.outcome, assessed_at: result.outcome_at! }, attempt: state.rework_count + 1,
      preparation: { state: state.state, configuration_evidence: state.configuration_evidence, native_context_evidence: state.native_context_evidence,
        freshness_evidence: state.freshness_evidence, tool_use_evidence: state.tool_use_evidence, assigned_variant_id: state.assigned_variant_id },
      price: { partial_amount: result.cost?.partial_amount ?? null, compatibility_unverified_partial_amount: result.cost?.compatibility_unverified_partial_amount ?? null, legacy_unverified_partial_amount: result.cost?.legacy_unverified_partial_amount ?? null, compatibility: result.cost?.compatibility ?? null, currency: result.cost?.currency ?? 'USD', unpriced_events: result.cost?.unpriced_events ?? 0, basis: result.cost?.price_table_hash ?? null },
      criteria: setup.workflow.assignment.metadata.criterion_ids, actions, startup, source: source ? { handle: source.handle, label: source.label } : null,
      binding: { ...binding, ...(supportDetails.context === 'synthetic_validation_only' ? {} : { product: bindingProduct }), support: supportDetails.context === 'synthetic_validation_only' ? 'synthetic_validation_only' : options.nativePilot && id===options.nativePilot.taskId ? (humanPilot ? 'native_unverified_pilot' : 'native_pilot_preparation_only') : options.qualificationLease ? 'native_qualification_only' : bindingAvailable ? ordinaryAvailable ? 'verified_bounded_family' : 'qualification_required' : 'instrumentation_required' },
      reason: record.reason === 'measurement_paused' ? null : record.reason ?? state.reason_code,
    };
  };
  const ordinaryTaskDto = (id: string, record: PrivateTask) => {
    const task = life.task(id);
    const preparation = ordinaryTask(store, id);
    if (!preparation) throw new Error('ordinary_preparation_required');
    const metadata = parseTaskMetadata(JSON.parse(task.metadata));
    const binding = ordinaryBindings.status(id);
    const summary = life.summary(id);
    const end = Date.parse(task.finalized_at ?? new Date().toISOString());
    const activeMs = task.started_at === null ? null : store.all<{ started_at: string; ended_at: string | null }>(
      'SELECT started_at,ended_at FROM active_intervals WHERE task_id=?', [id]).reduce((total, interval) =>
      total + Math.max(0, Math.min(Date.parse(interval.ended_at ?? new Date(end).toISOString()), end) -
        Date.parse(interval.started_at)), 0);
    const finalized = task.state === 'finalized';
    const active = binding.state === 'observing';
    const connected = binding.roots > 0;
    const revoked = preparation.revoked_at !== null;
    let supported = false;
    let supportReason = 'binding_source_unqualified';
    if (!finalized && !revoked) {
      try { supported = ordinaryBindings.sourceSupported(id, 'claude_code'); }
      catch (error) { supportReason = localWebError(error); }
    }
    const action = (code: string, enabled: boolean, reason: string) =>
      ({ code, enabled, reason: enabled ? null : reason });
    const actions = [
      action('session-connect', !finalized && !revoked && supported, !supported ? supportReason : 'binding_scope_revoked'),
      action('pause', !finalized && active, 'inactive_observation'),
      action('resume-binding', !finalized && !revoked && task.state === 'paused' && ordinaryBindings.resumeAvailable(id), 'binding_reconnect_required'),
      action('stop-observation', !finalized && !!binding.selected_root_id &&
        binding.segment_state !== null && binding.segment_state !== 'closed', 'inactive_observation'),
      action('revoke-collection', !finalized && !revoked, 'binding_scope_revoked'),
      action('finish-success', !finalized && connected, 'external_connection_required'),
      action('finish-failed', !finalized && connected, 'external_connection_required'),
      action('finish-abandoned', !finalized && connected, 'external_connection_required'),
    ];
    return {
      id, mode: 'ordinary' as const, name: record.name, project_id: task.project_id, setup_id: record.profile_id,
      version: '"' + createHash('sha256').update(JSON.stringify({ task, record, preparation, binding: {
        state: binding.state, selected_root_id: binding.selected_root_id, segment_state: binding.segment_state,
      } })).digest('hex') + '"',
      state: task.state, status: finalized ? summary.outcome : active ? 'active' : connected ? 'paused' : 'waiting_for_session',
      connection_readiness: {
        skill: inspectOrdinaryClaudeProjectSkill(effectiveTaskWorkspace(store, id)),
        configured_version: ordinaryTaskSettings(store, id).product_version,
        installed_version: null, collection_revoked: revoked,
      },
      measurement: { state: finalized ? 'measurement_ended' : active ? 'active' : connected ? 'paused' : 'waiting_connection',
        active_ms: activeMs, requests: binding.requests,
        window: { started_at: task.started_at, ends_at: null }, end_condition: 'explicit_stop' as const },
      outcome: summary.outcome === null ? null : { status: summary.outcome, assessed_at: task.finalized_at },
      attempt: summary.rework_count + 1,
      preparation: { state: 'prepared', configuration_evidence: 'task_snapshot_pinned',
        native_context_evidence: connected ? 'native_metadata_receipt' : 'unverified',
        freshness_evidence: connected ? 'explicit_connection_baseline' : 'unverified',
        tool_use_evidence: 'unavailable' },
      price: { partial_amount: binding.summary.partial_amount, currency: binding.summary.currency ?? 'USD',
        compatibility_unverified_partial_amount: binding.summary.compatibility_unverified_partial_amount,
        legacy_unverified_partial_amount: binding.summary.legacy_unverified_partial_amount,
        compatibility: binding.summary.compatibility, unpriced_events: binding.summary.unpriced_events,
        basis: binding.price_table_hash },
      criteria: metadata.criterion_ids, actions, startup: null, source: null,
      binding: { ...binding, product: 'claude_code' as const,
        product_version: claudeBindingAdmission.productVersion, max_family_members: claudeBindingAdmission.maxFamilyMembers,
        supported_model: claudeBindingAdmission.model,
        support: claudeBindingAdmission.qualified ? 'verified_claude_family' : 'ordinary_qualification_pending' },
      reason: record.reason === 'measurement_paused' ? null : record.reason,
    };
  };
  const domain: LocalWebDomain = {
    async bootstrap() {
      await bindings.flushForgotten();
      const allProfiles = profiles().filter(p => store.get<{status: string}>('SELECT status FROM comparison_protocols WHERE id=?', [p.setup.workflow.assignment.protocol_id])?.status === 'frozen' && store.get('SELECT id FROM projects WHERE id=?', [p.setup.workflow.assignment.project_id]));
      const projects = store.all<{ id: string; local_root: string }>('SELECT id,local_root FROM projects').map(p => {
        let baseline: string | null = null; try { baseline = projectBaseline(p.local_root); } catch { /* Show unavailable without creating a commit. */ }
        const ordinary = ordinaryProjectDto(store, p.id);
        return { id: p.id, name: basename(p.local_root), directory: p.local_root, baseline, setup_ids: allProfiles.filter(s => s.setup.workflow.assignment.project_id === p.id).map(s => s.id),
          ordinary: { configured: ordinary.configured, product_version: ordinary.product_version,
            installation_state: ordinary.installation.state, qualified: ordinary.admission.qualified } };
      });
      const setups = allProfiles.map(p => {
        const protocol = comparisonProtocol(store, protocolRow(store, p.setup.workflow.assignment.protocol_id));
        const strata = protocol.strata.filter(s => s.assignees.includes(p.setup.workflow.assignment.metadata.assignee));
        return { id: p.id, name: p.name, project_id: p.setup.workflow.assignment.project_id, arm_a: protocol.variant_ids[0], arm_b: protocol.variant_ids[1],
          ...(p.shared_binding?{shared:{revision_id:p.id,template_id:p.shared_binding.template_id,template_name:profiles().find(row=>row.id===p.shared_binding!.template_id)?.name??p.shared_binding.template_id,runtime:p.setup.runtime}}:{}),
          types: [...new Set(strata.flatMap(s => s.types))], sizes: [...new Set(strata.flatMap(s => s.sizes))], support: `${p.setup.workflow.assignment.metadata.product} ${p.setup.workflow.product_version}: route-specific gates; partial cost only`, support_details: localWebSupport(store, p) };
      });
      const tasks = (privateDb.prepare('SELECT id FROM web_tasks ORDER BY rowid DESC').all() as { id: string }[])
        .flatMap(t => {try{return [taskDto(t.id)];}catch{return [];}});
      return { projects, setups, tasks, catalog: readOnlinePriceCatalogStatus(store) };
    },
    task: taskDto,
    ordinaryProject: id => ordinaryProjectDto(store, id),
    ordinaryProjectAction(id, input) {
      if (options.nativePilot) throw new Error('binding_pilot_control_only');
      if (options.qualificationLease) throw new Error('binding_qualification_control_only');
      return Promise.resolve(ordinaryProjectAction(store, id, input));
    },
    registerProject(directory) {
      if(options.nativePilot)throw new Error('binding_pilot_control_only');
      if(options.qualificationLease)throw new Error('binding_qualification_control_only');
      const root = realpathSync(resolve(directory)); projectBaseline(root);
      const previous = store.get<{ id: string }>('SELECT id FROM projects WHERE local_root=?', [root]);
      if (previous) return Promise.resolve({ id: previous.id });
      const id = randomUUID(); life.registerProject(id, root); return Promise.resolve({ id });
    },
    createTask(input) {
      if(options.nativePilot)throw new Error('binding_pilot_control_only');
      if(options.qualificationLease)throw new Error('binding_qualification_control_only');
      if ('mode' in input) {
        const id = createOrdinaryTask(store, {
          project_id: input.project_id, criterion_ids: input.criterion_ids,
          ...(input.type ? { type: input.type } : {}),
          ...(input.size ? { expected_size: input.size } : {}),
          ...(input.assignee ? { assignee: input.assignee } : {}),
        });
        privateDb.prepare('INSERT INTO web_tasks(id,name,profile_id,setup) VALUES (?,?,?,?)')
          .run(id, input.name, 'ordinary-claude', JSON.stringify(ordinaryTaskSettings(store, id)));
        return Promise.resolve(taskDto(id));
      }
      const profile = profileFor(input.setup_id); const existing = store.get<{ local_root: string }>('SELECT local_root FROM projects WHERE id=?', [input.project_id]);
      if (!existing || profile.setup.workflow.assignment.project_id !== input.project_id) throw new Error('unknown_project');
      const base = buildExternalTaskSetup(store, { id: profile.id, setup: profile.setup }, { projectId: input.project_id });
      const setup: ExternalTaskSetup = { ...base, workflow: { ...base.workflow, assignment: { ...base.workflow.assignment,
        code_base_commit: projectBaseline(existing.local_root), metadata: { ...base.workflow.assignment.metadata,
          ...(input.type ? { type: input.type } : {}), ...(input.size ? { expected_size: input.size } : {}) } } } };
      if (profile.shared_binding) {
        sharedSetups.assertProfile(profile);
        const id=randomUUID();const reserved:ExternalTaskSetup={...setup,workflow:{...setup.workflow,confirmation_id:randomUUID(),assignment:{...setup.workflow.assignment,task_id:id,logical_task_id:randomUUID(),alias_ids:[randomUUID()]}}};
        const pins=sharedSetups.journalTask(profile,id)!;
        privateDb.prepare('INSERT INTO web_tasks(id,name,profile_id,setup,reason) VALUES (?,?,?,?,?)').run(id,input.name,profile.id,JSON.stringify(reserved),'shared_preparation_pending');
        store.execute('INSERT INTO shared_configuration_tasks(task_id,project_id,settings_hash,setup_hash) VALUES(?,?,?,?)',[id,input.project_id,pins.settingsHash,pins.setupHash]);
        try {prepareExternalTask(store,reserved,false);assertSharedTask(store,id,undefined,true);privateDb.prepare('UPDATE web_tasks SET reason=NULL WHERE id=?').run(id);if(profile.session_binding)registerBindingCollectionControl(store,id);}
        catch(error){privateDb.prepare('UPDATE web_tasks SET reason=? WHERE id=?').run(localWebError(error),id);}
        return Promise.resolve(taskDto(id));
      }
      const created = createExternalTask(store, setup, false); const id = created.state.task_id;
      if (profile.session_binding) registerBindingCollectionControl(store,id);
      privateDb.prepare('INSERT INTO web_tasks(id,name,profile_id,setup) VALUES (?,?,?,?)').run(id, input.name, profile.id, JSON.stringify(created.setup));
      return Promise.resolve(taskDto(id));
    },
    async chooseDirectory() { if(options.nativePilot)throw new Error('binding_pilot_control_only');
      if(options.qualificationLease)throw new Error('binding_qualification_control_only'); return picker('project'); },
    async importSetup() { if(options.nativePilot)throw new Error('binding_pilot_control_only');
      if(options.qualificationLease)throw new Error('binding_qualification_control_only'); const path = await picker('setup'); if (path === null) return { cancelled: true };
      const raw=readLocalWebSetupDocument(path) as {kind?:unknown};if(raw.kind==='harness-delta.comparison')return sharedSetups.preview(path);
      const saved=saveProfiles(readLocalWebManifest(path).profiles);return {imported:true,added_count:saved.addedCount,existing_count:saved.existingCount}; },
    bindSetup(input) { if(options.nativePilot)throw new Error('binding_pilot_control_only');if(options.qualificationLease)throw new Error('binding_qualification_control_only');return Promise.resolve(sharedSetups.bind(input)); },
    reviewSetup(input) { if(options.nativePilot)throw new Error('binding_pilot_control_only');if(options.qualificationLease)throw new Error('binding_qualification_control_only');return Promise.resolve(setupReviews.review(input)); },
    saveReviewedSetup(token) { if(options.nativePilot)throw new Error('binding_pilot_control_only');if(options.qualificationLease)throw new Error('binding_qualification_control_only');return Promise.resolve(setupReviews.save(token)); },
    applicationWorkspace(taskId,directory){row(taskId);return applications.workspace(taskId,directory);},
    applicationContext(taskId,attemptId){row(taskId);return applications.context(taskId,attemptId);},
    applicationLaunchContext(taskId,origin){row(taskId);return applications.launchContext(taskId,origin);},
    applicationHandoff(taskId,origin){row(taskId);return applications.handoff(taskId,origin);},
    applicationReview(taskId){row(taskId);return applications.review(taskId);},
    async chooseSession(taskId) {
      if(options.nativePilot)throw new Error('binding_pilot_control_only');
      if(options.qualificationLease)throw new Error('binding_qualification_control_only');
      row(taskId); const selected = await picker('session'); if (selected === null) return null;
      const path = realpathSync(selected); const match = basename(path).match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.jsonl$/i);
      if (!match) throw new Error('native_source_unqualified');
      // Filename identity only. Session contents are read exclusively by the scoped domain collector.
      const source: Source = { handle: randomUUID(), label: basename(path), path, session_id: z.uuid().parse(match[1]) };
      privateDb.prepare('INSERT INTO web_sources(handle,task_id,payload) VALUES (?,?,?)').run(source.handle, taskId, JSON.stringify(source));
      return { handle: source.handle, label: source.label };
    },
    async taskAction(id, action, input) {
      if(options.nativePilot&&(id!==options.nativePilot.taskId||!['prepare','apply','session-connect','pause','revoke-collection','resume-binding','finish-success','finish-failed','finish-abandoned','release'].includes(action)))throw new Error('binding_pilot_control_only');
      if(options.qualificationLease&&(id!==store.get<{task_id:string}>('SELECT task_id FROM binding_qualification WHERE singleton=1')?.task_id||!['session-connect','pause','resume-binding','emergency-stop'].includes(action)))throw new Error('binding_qualification_control_only');
      const record = row(id);
      if (ordinaryTask(store, id)) {
        if (action === 'session-connect' || action === 'resume-binding') assertOrdinaryTaskPrepared(store, id);
        if (action === 'session-connect') {
          const product = z.enum(['codex','claude_code']).parse(input.product);
          const receipt = z.uuid().parse(input.receipt);
          const previous = jobs.get(id);
          if (previous) { previous.pauseRequested = true; await previous.promise; }
          const connection = await ordinaryBindings.connect(id, product, { receipt });
          privateDb.prepare('UPDATE web_tasks SET reason=NULL WHERE id=?').run(id);
          beginBindingObservation(id);
          return { ...taskDto(id), connection: { ...connection, project_id: life.task(id).project_id,
            task_id: id, identity_basis: 'native_metadata_receipt',
            evidence: 'server_verified_identity_source_and_relations',
            collection_active: true, cost_coverage: 'partial' } };
        }
        if (action === 'resume-binding') {
          await ordinaryBindings.resume(id); beginBindingObservation(id);
          return taskDto(id);
        }
        if (action === 'revoke-collection') {
          const previous = jobs.get(id);
          if (previous) previous.pauseRequested = true;
          revokeOrdinaryObservation(store, id);
          await ordinaryBindings.stopObservation(id);
          await previous?.promise;
          privateDb.prepare('UPDATE web_tasks SET reason=NULL WHERE id=?').run(id);
          return taskDto(id);
        }
        if (action === 'pause' || action === 'stop-observation' || action.startsWith('finish-')) {
          const previous = jobs.get(id);
          if (previous) previous.pauseRequested = true;
          if (action === 'pause') ordinaryBindings.pause(id);
          else await ordinaryBindings.stopObservation(id);
          await previous?.promise;
          if (action.startsWith('finish-')) {
            const outcome = action === 'finish-success' ? 'success' : action === 'finish-failed' ? 'failed' :
              action === 'finish-abandoned' ? 'aborted' : null;
            if (outcome === null) throw new Error('invalid_ui_request');
            const metadata = parseTaskMetadata(JSON.parse(life.task(id).metadata));
            const criteria = outcome === 'success' ? z.array(identifier).parse(input.criteria ?? metadata.criterion_ids) : [];
            life.finalize(id, outcome, criteria);
          }
          privateDb.prepare('UPDATE web_tasks SET reason=NULL WHERE id=?').run(id);
          return taskDto(id);
        }
        throw new Error('invalid_ui_request');
      }
      const setup = setupFor(record);
      if(['application-start','application-execute','application-permission-decide','application-recover','application-publish'].includes(action))throw new Error('application_managed_retired');
      if(action==='application-prepare'){providers.delete(id);applications.prepareHandoff(id,ApplicationSelectionSchema.parse(input));return taskDto(id);}
      if(action==='application-open'){await applications.open(id,z.string().parse(input.origin));return taskDto(id);}
      if(action==='application-checkpoint')return applications.checkpoint(id,ApplicationCheckpointSchema.parse(input));
      if(action==='application-report'){applications.report(id,ApplicationReportSchema.parse(input));return taskDto(id);}
      if(action==='application-identity'){const request=ApplicationIdentitySchema.parse(input);applications.context(id,request.attempt_id);const provider=providersForTask(id).find(p=>p.product===request.product);if(!provider?.resolveApplicationIdentity||provider.capabilities().currentIdentity==='unavailable')throw new Error('application_identity_unavailable');const identity=await provider.resolveApplicationIdentity({receipt:request.receipt});return applications.registerIdentity(id,request.attempt_id,identity);}
      if(action==='application-cancel'){applications.cancel(id);return taskDto(id);}

      if (action === 'prepare' || action === 'apply') {
        if(action==='apply'&&setup.workflow.application)throw new Error('application_required');
        if(applicationRequired(store,id)){if(action==='apply')throw new Error('application_required');assertSharedTask(store,id,undefined,true);return taskDto(id);}
        const profile=profileFor(record.profile_id);sharedSetups.assertProfile(profile);
        if(store.get('SELECT id FROM tasks WHERE id=?',[id]))assertSharedTask(store,id);
        if(profile.shared_binding){const pins=sharedSetups.journalTask(profile,id,true)!;store.execute('INSERT OR IGNORE INTO shared_configuration_tasks(task_id,project_id,settings_hash,setup_hash) VALUES(?,?,?,?)',[id,setup.workflow.assignment.project_id,pins.settingsHash,pins.setupHash]);}
        try{prepareExternalTask(store, setup, action === 'apply');assertSharedTask(store,id,undefined,!!setup.workflow.application);if(profile.session_binding)registerBindingCollectionControl(store,id);privateDb.prepare('UPDATE web_tasks SET reason=NULL WHERE id=?').run(id);}
        catch(error){privateDb.prepare('UPDATE web_tasks SET reason=? WHERE id=?').run(localWebError(error),id);throw error;}
      }
      else if (profileFor(record.profile_id).shared_binding && !['pause','release','finish-success','finish-failed','finish-abandoned','rework','recover','revoke-collection'].includes(action)) { assertSharedTask(store,id); return guardedAction(); }
      else return guardedAction();
      return taskDto(id);
      async function guardedAction() {
      if (action === 'ticket') {
        const ticket = issueExternalStartTicket(store, setup);
        privateDb.prepare('UPDATE web_tasks SET startup=?,reason=NULL WHERE id=?').run(JSON.stringify({ ticket_id: ticket.ticket_id, start_command: ticket.start_command }), id);
      } else if (action === 'connect') {
        const stored = privateDb.prepare('SELECT payload FROM web_sources WHERE handle=? AND task_id=?').get(input.source_handle, id) as { payload: string } | undefined;
        if (!stored || record.startup === null) throw new Error('external_ticket_required');
        const source = JSON.parse(stored.payload) as Source; const execution = executionFor(record, 'link', source);
        const startup = JSON.parse(record.startup) as { ticket_id: string };
        await connectExternalTask(store, setup, execution, startup.ticket_id, options.adapterFactory?.(store, execution));
        privateDb.prepare('UPDATE web_tasks SET source=?,startup=NULL,reason=NULL WHERE id=?').run(JSON.stringify(source), id);
      } else if (action === 'session-connect') {
        const product = z.enum(['codex','claude_code']).parse(input.product) satisfies BindingProduct;
        const receipt = z.uuid().parse(input.receipt);
        const previous = jobs.get(id); if (previous) { previous.pauseRequested = true; await previous.promise; }
        let connection;
        try { connection = await bindings.connect(id, product, { receipt }); }
        catch (error) {
          privateDb.prepare('UPDATE web_tasks SET reason=? WHERE id=?').run(localWebError(error), id);
          // A rejected new receipt must not silently stop a previously authorized
          // live family. Failed baseline acquisition already pauses its scope.
          if (store.get<{state: string}>('SELECT state FROM tasks WHERE id=?', [id])?.state === 'active' && bindings.status(id).roots > 0) beginBindingObservation(id);
          throw error;
        }
        privateDb.prepare('UPDATE web_tasks SET reason=NULL WHERE id=?').run(id);
        beginBindingObservation(id);
        return { ...taskDto(id), connection: { ...connection, project_id: life.task(id).project_id, task_id: id, assigned_variant_id: externalTaskState(store,id).assigned_variant_id,
          identity_basis: 'native_metadata_receipt', evidence: 'server_verified_identity_source_and_relations', collection_active: true, cost_coverage: 'partial' } };
      } else if (action === 'observe') {
        if (jobs.has(id) || running(id).length) throw new Error('workflow_run_active');
        if (bindings.status(id).roots > 0) throw new Error('binding_identity_unavailable');
        const source = sourceFor(record); if (!source) throw new Error('external_connection_required');
        const execution = executionFor(record, 'collect', source);
        // Foreground core collection runs asynchronously; the mutation queue remains free for pause.
        const job: Job = { promise: Promise.resolve(), pauseRequested: false };
        jobs.set(id, job);
        job.promise = collectExternalTask(store, setup, execution, options.adapterFactory?.(store, execution))
          .then(() => { privateDb.prepare('UPDATE web_tasks SET reason=NULL WHERE id=?').run(id); })
          .catch((error: unknown) => { const reason = job.pauseRequested && error instanceof Error && error.message === 'workflow_scope_revoked' ? 'measurement_paused' : localWebError(error); privateDb.prepare('UPDATE web_tasks SET reason=? WHERE id=?').run(reason, id); })
          .finally(() => { jobs.delete(id); });

      } else if (action === 'pause') { const job = jobs.get(id); if (job) job.pauseRequested = true; if (bindings.status(id).roots > 0) bindings.pause(id); else pauseExternalTask(store, id); await job?.promise; }
      else if (action === 'revoke-collection') {
        if(options.qualificationLease)throw new Error('binding_qualification_control_only');
        const job=jobs.get(id);if(job)job.pauseRequested=true;
        revokeBindingCollectionControl(store,id);
        if(bindings.status(id).roots>0)bindings.pause(id);
        await job?.promise;
      }
      else if (action === 'resume-binding') { await bindings.resume(id); beginBindingObservation(id); }
      else if (action === 'emergency-stop') { if (!options.qualificationLease) throw new Error('owned_native_inactive'); revokeBindingQualification(options.qualificationLease); const job = jobs.get(id); if (job) job.pauseRequested = true; bindings.pause(id); await job?.promise; }
      else if (action === 'recover') {
        if (jobs.has(id)) throw new Error('workflow_run_active');
        for (const run of running(id)) recoverCodexWorkflow(store, run.id); pauseExternalTask(store, id);
      } else if (action === 'release') releaseExternalWorkflow(store, id, input.external_session_stopped === true);
      else if (action === 'rework' || action.startsWith('finish-')) {
        const choice = action === 'rework' ? 'rework' : action === 'finish-success' ? 'success' : action === 'finish-failed' ? 'failed' : action === 'finish-abandoned' ? 'aborted' : null;
        if (choice === null) throw new Error('invalid_ui_request');
        if (action.startsWith('finish-') && bindingCollectionControl(store,id) && !options.qualificationLease && bindings.status(id).roots>0) {
          const job=jobs.get(id);if(job)job.pauseRequested=true;bindings.pause(id);await job?.promise;
        }
        if (jobs.has(id) || bindingQualificationOwnerLive(options.qualificationLease)) throw new Error('workflow_run_active');
        recordExternalTaskOutcome(store, id, choice, choice === 'success' ? z.array(identifier).parse(input.criteria ?? setup.workflow.assignment.metadata.criterion_ids) : []);
      } else throw new Error('invalid_ui_request');
      return taskDto(id);
      }
    },
    async refreshPrices() { if(options.nativePilot)throw new Error('binding_pilot_control_only');
      if(options.qualificationLease)throw new Error('binding_qualification_control_only'); return refreshOnlinePriceCatalog(store); },
    async close() { applications.close();
      if(options.qualificationLease)revokeBindingQualification(options.qualificationLease);
      let failure:unknown;const pending=[...jobs.entries()];
      for(const [id,job] of pending){
        job.pauseRequested=true;
        try{if(store.get('SELECT id FROM tasks WHERE id=?',[id])){if(bindings.status(id).roots>0)bindings.pause(id);else pauseExternalTask(store,id);}}
        catch(error){failure??=error;}
      }
      for(const result of await Promise.allSettled(pending.map(([,job])=>job.promise)))if(result.status==='rejected')failure??=result.reason as unknown;
      await ordinaryBindings.close();
      privateDb.close();if(failure)throw failure instanceof Error?failure:new Error('local_operation_failed');
    },
  };
  return domain;
}
