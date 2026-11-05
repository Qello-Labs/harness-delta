import { localWebSupport } from './local-web-support.js';
import { readOrdinaryTask } from './local-web-task-read-ordinary.js';
export { readOrdinaryTask } from './local-web-task-read-ordinary.js';
import type { Job } from './local-web-binding-observation.js';
import type { Lifecycle } from '../lifecycle.js';
import type { Store } from '../store.js';
import type { ApplicationCoordinator } from '../harness-application.js';
import type { LocalWebDomainOptions } from './local-web-domain.js';
import type { LocalWebProfile } from './local-web-profile.js';
import type { ExternalTaskSetup } from '../external-session-service.js';
import type { SessionBindingProvider } from '../session-binding-contract.js';
import type { createSessionBindingService } from '../session-binding-service.js';
import type { createOrdinarySessionBindingService } from '../ordinary-session-binding.js';
import type { HumanPilotScope } from '../session-binding-human-pilot.js';
import type { PrivateTask, Source, TaskApplication } from './local-web-task-projection.js';
import { projectBlockedTask, projectExternalTask, projectOrdinaryTask, projectTaskHarness, externalTaskVersion } from './local-web-task-projection.js';
import { externalContract, bindingCollectionControl } from '../external-session-contract.js';
import { externalTaskState, externalTaskResult } from '../external-session-service.js';
import { applicationRequired, effectiveTaskWorkspace } from '../harness-application.js';
import { getApplicationLaunchCapability } from '../harness/harness-application-launch.js';
import { comparisonVariant, protocolRow } from '../core/protocol-store.js';
import { parseProtocol } from '../flexible-contracts.js';
import { ordinaryTask } from '../ordinary-observation.js';

import { inspectClaudeProjectSkill } from '../connect/claude-connect-readiness.js';
import { bindingQualificationOwnerLive, assertBindingQualification } from '../session-binding-qualification-lease.js';
import { assertHumanPilotScope } from '../session-binding-human-pilot.js';
import { localWebError } from './local-web-server.js';
import { localWebRecruitment } from './local-web-recruitment.js';

type BindingService = ReturnType<typeof createSessionBindingService> | ReturnType<typeof createOrdinarySessionBindingService>;
export interface LocalWebTaskReadContext {
  readonly options: LocalWebDomainOptions;
  readonly store: Store;
  readonly life: Lifecycle;
  readonly applications: ApplicationCoordinator;
  readonly row: (id: string) => PrivateTask;
  readonly setupFor: (record: PrivateTask) => ExternalTaskSetup;
  readonly profileFor: (id: string) => LocalWebProfile;
  readonly sourceFor: (record: PrivateTask) => Source | null;
  readonly running: (id: string) => { id: string; stop_requested: number }[];
  readonly jobs: ReadonlyMap<string, Job>;
  readonly bindings: Pick<BindingService, 'capabilities' | 'sourceSupported' | 'resumeAvailable'> & {
    readonly status: (id: string) => ReturnType<BindingService['status']>;
  };
  readonly ordinaryBindings: ReturnType<typeof createOrdinarySessionBindingService>;
  readonly providers: ReadonlyMap<string, SessionBindingProvider[]>;
  readonly providersForTask: (id: string) => SessionBindingProvider[];
  readonly humanPilot: HumanPilotScope | undefined;
}

function readTaskBase(context: LocalWebTaskReadContext, id: string, record: PrivateTask) {
  const { store, life, setupFor, profileFor } = context;
  const setup = setupFor(record);
  const task = store.get('SELECT id FROM tasks WHERE id=?', [id])
    ? life.task(id)
    : { id, project_id: setup.workflow.assignment.project_id, state: 'registered' as const };
  const supportDetails = localWebSupport(store, profileFor(record.profile_id));
  const taskProtocol = parseProtocol(JSON.parse(protocolRow(store, setup.workflow.assignment.protocol_id).settings) as unknown);
  const recruitment = localWebRecruitment(taskProtocol);
  const assignedVariant = store.get<{ variant_id: string }>('SELECT variant_id FROM comparison_assignments WHERE task_id=?', [id])?.variant_id ?? null;
  const assignedIndex = assignedVariant === null ? -1 : taskProtocol.variant_ids.indexOf(assignedVariant);
  const version = assignedVariant === null ? null : comparisonVariant(store, assignedVariant).harness_version;
  const nativeApplication = !!setup.workflow.application || applicationRequired(store, id);
  const harness = projectTaskHarness({ assignedIndex, assignedVariant, version, nativeApplication });
  return { id, record, setup, task, supportDetails, recruitment, harness };
}
type TaskBase = ReturnType<typeof readTaskBase>;

export function readBlockedTask(context: LocalWebTaskReadContext, base: TaskBase) {
  const assignment = context.store.get<{ variant_id: string }>('SELECT variant_id FROM comparison_assignments WHERE task_id=?', [base.id]);
  const capabilities =
    base.harness.application_mode === 'agent_applied' ? [getApplicationLaunchCapability('codex'), getApplicationLaunchCapability('claude_code')] : [];
  return { ...base, assignment, capabilities };
}

function readBindingAvailability(context: LocalWebTaskReadContext, id: string, bindingProduct: SessionBindingProvider['product']) {
  const { bindings, options, store, humanPilot, providersForTask } = context;
  let bindingAvailable = false;
  let bindingUnavailableReason = 'binding_provider_unavailable';
  try {
    bindings.capabilities(id, bindingProduct);
    bindingAvailable = true;
  } catch (error) {
    const reason = localWebError(error);
    if (reason !== 'local_operation_failed') bindingUnavailableReason = reason;
  }
  let ordinaryAvailable = false;
  try {
    ordinaryAvailable = bindings.sourceSupported(id, bindingProduct);
  } catch {
    /* Missing/unqualified sources cannot enable an action. */
  }
  let qualificationAvailable = false;
  try {
    qualificationAvailable = bindingQualificationOwnerLive(options.qualificationLease) && assertBindingQualification(options.qualificationLease, store, id);
  } catch {
    /* A revoked lease cannot enable a browser action. */
  }
  const ownedNativeLive = bindingQualificationOwnerLive(options.qualificationLease);
  let pilotAvailable = false;
  try {
    if (humanPilot) {
      assertHumanPilotScope(humanPilot, store, id, providersForTask(id)[0]);
      pilotAvailable = true;
    }
  } catch {
    /* Exact pilot task only. */
  }
  const bindingAuthorized = options.qualificationLease ? qualificationAvailable : humanPilot ? pilotAvailable : ordinaryAvailable;
  return { bindingAvailable, bindingUnavailableReason, ordinaryAvailable, ownedNativeLive, bindingAuthorized };
}

function readConnectionReadiness(context: LocalWebTaskReadContext, base: TaskBase, ready: boolean, bindingProduct: SessionBindingProvider['product']) {
  const { store } = context;
  const { id, supportDetails, setup } = base;
  const connectionReadiness =
    ready && supportDetails.context === 'real' && supportDetails.connection_route === 'family' && bindingProduct === 'claude_code'
      ? {
          skill: inspectClaudeProjectSkill(effectiveTaskWorkspace(store, id)),
          configured_version: setup.workflow.product_version,
          installed_version: null,
          collection_revoked: !!bindingCollectionControl(store, id)?.revoked_at
        }
      : undefined;
  return connectionReadiness;
}

export function readExternalTask(context: LocalWebTaskReadContext, base: TaskBase) {
  const { store, options, applications, running, jobs, sourceFor, bindings, profileFor, providers, humanPilot } = context;
  const { id, record, setup, task } = base;
  const application: TaskApplication | undefined = applicationRequired(store, id)
    ? {
        ...applications.status(id),
        capabilities: [getApplicationLaunchCapability('codex'), getApplicationLaunchCapability('claude_code')],
        baseline: setup.workflow.assignment.code_base_commit
      }
    : undefined;
  const state = externalTaskState(store, id);
  const result = externalTaskResult(store, id);
  const runs = running(id);
  const active = runs.length > 0 || jobs.has(id);
  const finalized = task.state === 'finalized';
  const connected = state.window.started_at !== null;
  const supported = setup.workflow.assignment.metadata.product !== 'claude_code';
  const ready = application
    ? application.state === 'applied' && application.identity === 'verified_metadata'
    : state.configuration_evidence === 'verified_at_preparation' && state.state !== 'released';
  const source = sourceFor(record);
  const startup = record.startup === null ? null : (JSON.parse(record.startup) as { ticket_id: string; start_command: string });
  const binding = bindings.status(id);
  const bindingProduct =
    profileFor(record.profile_id).session_binding?.product ??
    options.bindingProviders?.[0]?.product ??
    providers.get(id)?.[0]?.product ??
    (setup.workflow.assignment.metadata.product === 'claude_code' ? 'claude_code' : 'codex');
  const availability = readBindingAvailability(context, id, bindingProduct);
  const { bindingAuthorized } = availability;
  const explicitStop = state.collection_end_condition === 'explicit_stop' && !options.qualificationLease;
  const resumeAvailable = bindingAuthorized && ready && state.window_status !== 'closed' && task.state === 'paused' && bindings.resumeAvailable(id);
  const collectionRevoked = explicitStop && !finalized && !!bindingCollectionControl(store, id)?.revoked_at;
  const recoverAvailable = runs.length > 0 && !jobs.has(id);
  const version = externalTaskVersion({ task, application, state, record, collectionControl: bindingCollectionControl(store, id), runs, ownJob: jobs.has(id) });
  const connectionReadiness = readConnectionReadiness(context, base, ready, bindingProduct);
  return {
    ...base,
    application,
    state,
    result,
    runs,
    active,
    finalized,
    connected,
    supported,
    ready,
    source,
    startup,
    binding,
    bindingProduct,
    ...availability,
    explicitStop,
    resumeAvailable,
    collectionRevoked,
    version,
    connectionReadiness,
    recoverAvailable,
    qualification: !!options.qualificationLease,
    nativePilotTaskId: options.nativePilot?.taskId,
    humanPilot: !!humanPilot
  };
}

export function createLocalWebTaskReader(context: LocalWebTaskReadContext) {
  return (id: string) => {
    const record = context.row(id);
    if (ordinaryTask(context.store, id)) return projectOrdinaryTask(readOrdinaryTask(context, id, record));
    const base = readTaskBase(context, id, record);
    if (
      !externalContract(context.store, id) ||
      (base.task.state !== 'finalized' && record.reason?.startsWith('shared_') && externalContract(context.store, id)?.started_at === null)
    )
      return projectBlockedTask(readBlockedTask(context, base));
    return projectExternalTask(readExternalTask(context, base));
  };
}
