import { createLocalWebBindingSelection } from './local-web-binding-selection.js';
import { createLocalWebBindingObservation, type Job } from './local-web-binding-observation.js';
import { createLocalWebProjectHandlers } from './local-web-project-handlers.js';
import { createLocalWebTaskCreation } from './local-web-task-creation.js';
import { createLocalWebSetupHandlers } from './local-web-setup-handlers.js';
import { createLocalWebApplicationHandlers } from './local-web-application-handlers.js';
import { createLocalWebTaskActions } from './local-web-task-actions.js';
import { createLocalWebTaskReader } from './local-web-task-read.js';
import { createLocalWebMetadata, type PrivateTask, type Source } from './local-web-metadata-store.js';
import type { ChildReadinessObservation } from '../binding-child-readiness.js';

import { ApplicationCoordinator } from '../harness-application.js';

import { LocalWebManifestSchema, type LocalWebProfile } from './local-web-profile.js';
export { LocalWebProfileSchema, LocalWebManifestSchema, type LocalWebProfile } from './local-web-profile.js';
import { createSharedSetupManager } from './local-web-shared.js';
import { createSetupReviewManager } from './local-web-setup-review.js';

import { randomUUID } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';

import { promisify } from 'node:util';

import { Lifecycle } from '../lifecycle.js';
import { Store } from '../store.js';

import { protocolRow } from '../core/protocol-store.js';
import { CodexWorkflowExecutionSchema } from '../codex-workflow-adapter.js';

import { ExternalTaskSetupSchema, pauseExternalTask } from '../external-session-service.js';

import type { WorkflowAdapter } from '../task-workflow.js';

import { type LocalWebDomain } from './local-web-server.js';
import { type BindingObservation } from '../session-binding-service.js';
import { type ClaudeBindingOptions } from '../session-binding-claude.js';

import { resolveSourceCompatibility, effectiveSourceCompatibility } from '../source-compatibility.js';
import { functionalWorkflowEligible, comparisonReadiness } from '../readiness-store.js';
import { parseProtocol } from '../flexible-contracts.js';
import type { BindingQualificationLease } from '../session-binding-qualification-lease.js';
import { revokeBindingQualification } from '../session-binding-qualification-lease.js';
import { isHumanPilotProtocol, codexRootHumanPilotProfileId } from '../session-binding-human-pilot.js';
import type { SessionBindingProvider } from '../session-binding-contract.js';

import { getCodexBindingAdmission, isAdmittedCodexBindingProtocol } from '../codex-binding-admission.js';

import { createCodexProjectSetupManager } from './local-web-codex.js';

export function localWebSupport(store: Store, profile: LocalWebProfile) {
  const workflow = profile.setup.workflow;
  const protocolRecord = protocolRow(store, workflow.assignment.protocol_id);
  const protocol = parseProtocol(JSON.parse(protocolRecord.settings) as unknown);
  const synthetic = workflow.assignment.metadata.product === 'synthetic' || (protocol.schema_version === 2 && protocol.purpose === 'synthetic_validation');
  const familyPilot = protocol.schema_version === 2 && isHumanPilotProtocol(protocol);
  const rootPilot = familyPilot && protocol.schema_version === 2 && protocol.source_profiles[0]?.profile_id === codexRootHumanPilotProfileId;
  const ordinaryFamily = protocol.schema_version === 2 && isAdmittedCodexBindingProtocol(protocol);
  const parserCompatibility = ordinaryFamily
    ? resolveSourceCompatibility('codex', workflow.product_version, 'codex_binding', getCodexBindingAdmission(workflow.product_version)?.profileId)
    : rootPilot
      ? resolveSourceCompatibility('codex', workflow.product_version, 'codex_workflow', 'codex-workflow-own-response-v1')
      : null;
  const parserState = parserCompatibility ? effectiveSourceCompatibility(store, parserCompatibility) : null;
  const launchAllowed =
    !ordinaryFamily &&
    protocolRecord.status === 'frozen' &&
    protocol.schema_version === 2 &&
    (functionalWorkflowEligible(store, protocol) || comparisonReadiness(store, protocol.id).real_allocation);
  const launch =
    protocol.schema_version === 2
      ? protocol.source_profiles.map(source => {
          const compatibility =
            source.product === 'synthetic' || ordinaryFamily
              ? null
              : resolveSourceCompatibility(
                  source.product,
                  source.product_version,
                  source.product === 'codex' ? 'codex_workflow' : 'claude_workflow',
                  source.profile_id
                );
          return {
            profile_id: source.profile_id,
            state: !synthetic && launchAllowed && compatibility ? effectiveSourceCompatibility(store, compatibility).state : 'unsupported'
          };
        })
      : [];
  return {
    context: synthetic ? 'synthetic_validation_only' : 'real',
    connection_route: synthetic ? 'synthetic' : profile.session_binding || familyPilot ? 'family' : 'ticket',
    product: workflow.assignment.metadata.product,
    product_version: workflow.product_version,
    launch,
    ticket: synthetic
      ? 'synthetic_validation_only'
      : workflow.assignment.metadata.product === 'codex' && workflow.product_version === '0.160.0'
        ? 'exact_version_only'
        : 'unsupported',
    family: synthetic
      ? 'synthetic_validation_only'
      : protocolRecord.status === 'frozen' && ordinaryFamily && parserState && parserState.state !== 'invalidated'
        ? parserState.state === 'verified'
          ? 'verified_bounded_family'
          : 'candidate_pilot'
        : protocolRecord.status === 'frozen' && familyPilot
          ? rootPilot
            ? 'candidate_root_pilot'
            : 'candidate_pilot'
          : 'qualification_required',
    ...(parserState ? { family_parser_compatibility: parserState } : {}),
    complete_cost: false,
    inference: false
  };
}
export type { Job } from './local-web-binding-observation.js';
export interface LocalWebDomainOptions {
  store: Store;
  metadataFile: string;
  profiles?: LocalWebProfile[];
  picker?: (kind: 'project' | 'session' | 'setup') => Promise<string | null>;
  adapterFactory?: (store: Store, execution: unknown) => WorkflowAdapter;
  bindingProviders?: SessionBindingProvider[];
  /** Internal consumed, isolated qualification intent; never profile/browser input. */
  qualificationLease?: BindingQualificationLease;
  /** Trusted execution instrumentation; does not grant collection authority. */
  bindingObservation?: BindingObservation & { maxFamilyMembers?: 1 | 3 };
  /** Local operator selection only; profiles and browser requests cannot activate it. */
  nativePilot?: { taskId: string; observe: boolean; untilExplicitStop?: boolean };
  /** Opt-in local pilot instrumentation only; never browser/profile input. */
  onChildReadiness?: (observation: Readonly<ChildReadinessObservation>) => void;
  /** Trusted fixture injection only; browser/profile flags cannot enable admission. */
  bindingProviderFactory?: (
    taskId: string,
    projectRoot: string,
    ordinaryCallbacks?: Pick<ClaudeBindingOptions, 'authorizeSource' | 'memberEligible'>
  ) => SessionBindingProvider[];
}
const runFile = promisify(execFile);
/** Constant AppleScript only; no browser-provided command or script is executed. */
export async function nativeLocalPicker(kind: 'project' | 'session' | 'setup'): Promise<string | null> {
  if (process.platform !== 'darwin') throw new Error('picker_unavailable');
  const script =
    kind === 'project'
      ? 'POSIX path of (choose folder with prompt "Choose the measurement project")'
      : kind === 'session'
        ? 'POSIX path of (choose file with prompt "Choose the exact new Codex session JSONL")'
        : 'POSIX path of (choose file with prompt "Choose an existing reviewed Harness Delta UI setup")';
  try {
    const result = await runFile('/usr/bin/osascript', ['-e', script], { timeout: 120000, maxBuffer: 8192 });
    return result.stdout.trim() || null;
  } catch (error) {
    if (error instanceof Error && 'stderr' in error && String(error.stderr).includes('(-128)')) return null;
    throw new Error('picker_unavailable', { cause: error });
  }
}
export function readLocalWebSetupDocument(path: string): unknown {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1048576) throw new Error('invalid_ui_setup');
    return JSON.parse(readFileSync(fd, 'utf8')) as unknown;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
export function readLocalWebManifest(path: string) {
  return LocalWebManifestSchema.parse(readLocalWebSetupDocument(path));
}
/** Reads the current commit; it never creates a commit or changes the checkout. */
export function projectBaseline(directory: string): string {
  try {
    const value = execFileSync('git', ['-C', directory, 'rev-parse', '--verify', 'HEAD'], {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 4096,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) throw new Error();
    return value;
  } catch {
    throw new Error('git_baseline_unavailable');
  }
}

/** UI labels and private native handoffs stay outside the measurement Store. */
export function createLocalWebDomain(options: LocalWebDomainOptions): LocalWebDomain {
  if (options.nativePilot && (options.qualificationLease || options.bindingProviders || options.bindingProviderFactory))
    throw new Error('binding_pilot_scope_invalid');
  const store = options.store;
  const life = new Lifecycle(store);
  const metadata = createLocalWebMetadata(store, options.metadataFile);
  const privateDb = metadata.database;
  const codexProjects = createCodexProjectSetupManager(store, privateDb);
  metadata.initialize();
  const jobs = new Map<string, Job>();
  const picker = options.picker ?? nativeLocalPicker;
  const { saveProfiles, profiles } = metadata;
  saveProfiles(options.profiles ?? []);
  const applications = new ApplicationCoordinator(store, () => [
    options.metadataFile,
    ...profiles().flatMap(profile => [
      profile.execution.codex_home,
      ...(profile.session_binding?.product === 'codex'
        ? [profile.session_binding.receipt_directory, ...profile.session_binding.source_roots]
        : profile.session_binding
          ? [profile.session_binding.receipt_directory, profile.session_binding.claude_projects_directory]
          : [])
    ])
  ]);
  const sharedSetups = createSharedSetupManager(store, privateDb, profiles, saveProfiles);
  const setupReviews = createSetupReviewManager(store, privateDb, profiles, saveProfiles, sharedSetups);
  const row = (id: string) => {
    const result = metadata.task(id);
    if (!result) throw new Error('unknown_task');
    if (store.get("SELECT 1 FROM tombstones WHERE kind='task' AND id=?", [id])) throw new Error('unknown_task');
    if (!store.get('SELECT id FROM tasks WHERE id=?', [id])) {
      const setup = ExternalTaskSetupSchema.parse(JSON.parse(result.setup) as unknown);
      if (!profileFor(result.profile_id).shared_binding || !store.get('SELECT id FROM projects WHERE id=?', [setup.workflow.assignment.project_id]))
        throw new Error('unknown_task');
    }
    return result;
  };
  const setupFor = (task: PrivateTask) => ExternalTaskSetupSchema.parse(JSON.parse(task.setup) as unknown);
  const profileFor = (id: string) => {
    const result = profiles().find(p => p.id === id);
    if (!result) throw new Error('unknown_setup');
    return result;
  };
  const sourceFor = (task: PrivateTask) => (task.source === null ? null : (JSON.parse(task.source) as Source));
  const executionFor = (task: PrivateTask, operation: 'link' | 'collect', source: Source) =>
    CodexWorkflowExecutionSchema.parse({
      ...profileFor(task.profile_id).execution,
      run_id: randomUUID(),
      operation,
      session_id: source.session_id,
      source_path: source.path
    });
  const running = (id: string) =>
    store.all<{ id: string; stop_requested: number }>("SELECT id,stop_requested FROM codex_workflow_runs WHERE task_id=? AND state='running'", [id]);
  for (const record of metadata.tasks()) {
    if (store.get("SELECT 1 FROM tombstones WHERE kind='task' AND id=?", [record.id])) continue;
    if (record.profile_id === 'ordinary-claude') continue;
    const profile = profileFor(record.profile_id);
    if (!profile.shared_binding) continue;
    try {
      const pins = sharedSetups.journalTask(profile, record.id, true)!;
      store.execute('INSERT OR IGNORE INTO shared_configuration_tasks(task_id,project_id,settings_hash,setup_hash) VALUES(?,?,?,?)', [
        record.id,
        setupFor(record).workflow.assignment.project_id,
        pins.settingsHash,
        pins.setupHash
      ]);
    } catch {
      metadata.setReason(record.id, 'shared_binding_changed');
    }
  }
  const { providers, providersForTask, ordinaryBindings, bindings, humanPilot, familyDiagnosticsEnabled, writeFamilyDiagnostic } =
    createLocalWebBindingSelection({ options, recordFor: metadata.task, row, setupFor, profileFor, codexProjects });
  const { beginBindingObservation } = createLocalWebBindingObservation({
    options,
    jobs,
    bindings,
    familyDiagnosticsEnabled,
    writeFamilyDiagnostic,
    setReason: metadata.setReason
  });
  const taskDto = createLocalWebTaskReader({
    options,
    store,
    life,
    applications,
    row,
    setupFor,
    profileFor,
    sourceFor,
    running,
    jobs,
    bindings,
    ordinaryBindings,
    providers,
    providersForTask,
    humanPilot,
    supportDetails: localWebSupport
  });
  const domain: LocalWebDomain = {
    metadataStore: store,
    ...createLocalWebProjectHandlers(options, {
      life,
      metadata,
      profiles,
      taskDto,
      bindings,
      providers,
      codexProjects,
      picker,
      projectBaseline,
      localWebSupport
    }),
    task: taskDto,
    createTask: createLocalWebTaskCreation(options, { profileFor, taskDto, sharedSetups, metadata, projectBaseline }),
    ...createLocalWebSetupHandlers(options, {
      picker,
      row,
      metadata,
      saveProfiles,
      sharedSetups,
      setupReviews,
      readLocalWebSetupDocument,
      readLocalWebManifest
    }),
    ...createLocalWebApplicationHandlers(row, applications),
    taskAction: createLocalWebTaskActions({
      store,
      metadata,
      options,
      life,
      jobs,
      bindings,
      ordinaryBindings,
      applications,
      providers,
      providersForTask,
      sharedSetups,
      row,
      setupFor,
      profileFor,
      sourceFor,
      executionFor,
      running,
      beginBindingObservation,
      taskDto
    }),
    async close() {
      applications.close();
      if (options.qualificationLease) revokeBindingQualification(options.qualificationLease);
      let failure: unknown;
      const pending = [...jobs.entries()];
      for (const [id, job] of pending) {
        job.pauseRequested = true;
        try {
          if (store.get('SELECT id FROM tasks WHERE id=?', [id])) {
            if (bindings.status(id).roots > 0) bindings.pause(id);
            else pauseExternalTask(store, id);
          }
        } catch (error) {
          failure ??= error;
        }
      }
      for (const result of await Promise.allSettled(pending.map(([, job]) => job.promise)))
        if (result.status === 'rejected') failure ??= result.reason as unknown;
      await ordinaryBindings.close();
      metadata.close();
      if (failure) throw failure instanceof Error ? failure : new Error('local_operation_failed');
    }
  };
  return domain;
}
