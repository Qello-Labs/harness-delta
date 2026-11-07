import type { LocalWebProfile } from './local-web-profile.js';
import { nativeLocalPicker } from './local-web-native.js';
export { nativeLocalPicker, readLocalWebSetupDocument, readLocalWebManifest, projectBaseline } from './local-web-native.js';
export { localWebSupport } from './local-web-support.js';
import { createLocalWebTaskRecords } from './local-web-task-records.js';
import { createLocalWebBindingSelection } from './local-web-binding-selection.js';
import { createLocalWebBindingObservation, type Job } from './local-web-binding-observation.js';
import { createLocalWebProjectHandlers } from './local-web-project-handlers.js';
import { createLocalWebTaskCreation } from './local-web-task-creation.js';
import { createLocalWebSetupHandlers } from './local-web-setup-handlers.js';
import { createLocalWebApplicationHandlers } from './local-web-application-handlers.js';
import { createLocalWebTaskActions } from './local-web-task-actions.js';
import { createLocalWebTaskReader } from './local-web-task-read.js';
import { readLocalWebOrdinaryWindowReport } from './local-web-ordinary-window-report.js';
import { createLocalWebMetadata } from './local-web-metadata-store.js';
import type { ChildReadinessObservation } from '../binding-child-readiness.js';

import { ApplicationCoordinator } from '../harness-application.js';

export { LocalWebProfileSchema, LocalWebManifestSchema, type LocalWebProfile } from './local-web-profile.js';
import { createSharedSetupManager } from './local-web-shared.js';
import { createSetupReviewManager } from './local-web-setup-review.js';

import { Lifecycle } from '../lifecycle.js';
import { Store } from '../store.js';

import { pauseExternalTask } from '../external-session-service.js';

import type { WorkflowAdapter } from '../task-workflow.js';

import { type LocalWebDomain } from './local-web-server.js';
import { type BindingObservation } from '../session-binding-service.js';
import { type ClaudeBindingOptions } from '../session-binding-claude.js';

import type { BindingQualificationLease } from '../session-binding-qualification-lease.js';
import { revokeBindingQualification } from '../session-binding-qualification-lease.js';

import type { SessionBindingProvider } from '../session-binding-contract.js';

import { createCodexProjectSetupManager } from './local-web-codex.js';
import { createCodexWindowControl } from './local-web-codex-window-control.js';
import { createClaudeWindowControl } from './local-web-claude-window-control.js';
import type { ClaudeWindowBinaryAdapters } from '../claude-process-binary.js';

export interface LocalWebDomainOptions {
  store: Store;
  metadataFile: string;
  profiles?: LocalWebProfile[];
  picker?: (kind: 'project' | 'session' | 'setup') => Promise<string | null>;
  adapterFactory?: (store: Store, execution: unknown) => WorkflowAdapter;
  bindingProviders?: SessionBindingProvider[];
  /** Trusted backend instrumentation only; does not grant collection authority. */
  claudeWindowBinaryAdapters?: ClaudeWindowBinaryAdapters;
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
  const codexWindow = createCodexWindowControl(store, metadata, codexProjects);
  const claudeWindow = createClaudeWindowControl(store, metadata, options.claudeWindowBinaryAdapters);
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
  const { row, setupFor, profileFor, sourceFor, executionFor, running } = createLocalWebTaskRecords(store, metadata, sharedSetups);
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
    humanPilot
  });
  const domain: LocalWebDomain = {
    metadataStore: store,
    codexWindow,
    claudeWindow,
    ...createLocalWebProjectHandlers(options, { life, metadata, taskDto, bindings, providers, codexProjects, picker }),
    task: taskDto,
    ordinaryWindowReport: (taskId, cutoff) => readLocalWebOrdinaryWindowReport(store, taskId, cutoff),
    createTask: createLocalWebTaskCreation(options, { profileFor, taskDto, sharedSetups, metadata, claudeWindow }),
    ...createLocalWebSetupHandlers(options, { picker, row, metadata, sharedSetups, setupReviews }),
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
