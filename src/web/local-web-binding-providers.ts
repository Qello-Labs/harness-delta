import { comparisonProtocol, protocolRow } from '../core/protocol-store.js';
import { getClaudeBindingAdmission } from '../claude-binding-admission.js';
import { getCodexBindingAdmission, isAdmittedCodexBindingProtocol } from '../codex-binding-admission.js';
import type { ExternalTaskSetup } from '../external-session-service.js';
import { applicationRequired, effectiveTaskWorkspace } from '../harness-application.js';
import { ordinaryTask, ordinaryTaskSettings, OrdinaryProjectSettingsSchema } from '../ordinary-observation.js';
import type { createOrdinarySessionBindingService } from '../ordinary-session-binding.js';
import { ClaudeSessionBindingProvider, type ClaudeBindingOptions } from '../session-binding-claude.js';
import { assertClaudeHumanPilotSource } from '../session-binding-claude-human-pilot.js';
import { CodexSessionBindingProvider, codexRootPilotVersions } from '../session-binding-codex.js';
import type { SessionBindingProvider } from '../session-binding-contract.js';
import type { HumanPilotScope } from '../session-binding-human-pilot.js';
import { codexReceiptDirectoryState, type createCodexProjectSetupManager } from './local-web-codex.js';
import type { LocalWebDomainOptions } from './local-web-domain.js';
import type { createLocalWebMetadata, PrivateTask } from './local-web-metadata-store.js';
import type { LocalWebProfile } from './local-web-profile.js';

interface ProviderDependencies {
  readonly options: LocalWebDomainOptions;
  readonly recordFor: ReturnType<typeof createLocalWebMetadata>['task'];
  readonly setupFor: (record: PrivateTask) => ExternalTaskSetup;
  readonly profileFor: (id: string) => LocalWebProfile;
  readonly codexProjects: ReturnType<typeof createCodexProjectSetupManager>;
  readonly ordinaryBindings: () => ReturnType<typeof createOrdinarySessionBindingService>;
  readonly humanPilot: () => HumanPilotScope | undefined;
}

interface ProviderTask {
  readonly id: string;
  readonly record: PrivateTask;
  readonly projectRoot: string;
}
function codexProvider(
  dependencies: ProviderDependencies,
  task: ProviderTask,
  configuration: {
    readonly config: Extract<NonNullable<LocalWebProfile['session_binding']>, { product: 'codex' }>;
    readonly ordinaryAdmission: ReturnType<typeof getCodexBindingAdmission>;
  }
) {
  const { options, setupFor } = dependencies;
  const { id, record, projectRoot } = task;
  const { config, ordinaryAdmission } = configuration;
  return new CodexSessionBindingProvider({
    receiptDirectory: config.receipt_directory,
    sourceRoots: config.source_roots,
    projectRoot,
    ...(setupFor(record).workflow.assignment.metadata.product === 'synthetic' ? {} : { productVersion: setupFor(record).workflow.product_version }),
    ...(options.qualificationLease
      ? {
          maxDepth: 1,
          maxFamilyMembers: 3,
          ...(['0.162.1', '0.163.0'].includes(setupFor(record).workflow.product_version) ? { ordinaryFamilyQualification: true } : {})
        }
      : options.nativePilot
        ? { maxDepth: 1, maxFamilyMembers: codexRootPilotVersions.some(version => version === setupFor(record).workflow.product_version) ? 1 : 3 }
        : {}),
    ...(ordinaryAdmission
      ? {
          ordinaryFamilyAdmission: true,
          maxDepth: ordinaryAdmission.maxDepth,
          maxFamilyMembers: options.bindingObservation?.maxFamilyMembers ?? ordinaryAdmission.maxFamilyMembers
        }
      : {}),
    ...(options.nativePilot?.observe &&
    options.nativePilot.taskId === id &&
    codexRootPilotVersions.some(version => version === setupFor(record).workflow.product_version)
      ? { ordinaryRootPilot: true }
      : {})
  });
}

function ordinaryClaudeProvider(dependencies: ProviderDependencies, task: ProviderTask) {
  const { id, record, projectRoot } = task;
  const { options, ordinaryBindings } = dependencies;
  const config = ordinaryTask(options.store, id) ? ordinaryTaskSettings(options.store, id) : OrdinaryProjectSettingsSchema.parse(JSON.parse(record.setup));
  const admission = getClaudeBindingAdmission(config.product_version);
  if (!admission?.admitted) throw new Error('binding_source_unqualified');
  return new ClaudeSessionBindingProvider({
    receiptDir: config.receipt_directory,
    claudeProjectsDir: config.claude_projects_directory,
    projectRoot,
    ordinaryAdmission: true,
    productVersion: config.product_version,
    maxFamilyMembers: admission.maxFamilyMembers,
    authorizeSource: source => ordinaryBindings().assertSource(id, source),
    memberEligible: member => ordinaryBindings().memberEligible(id, member)
  });
}

function profileConfiguration(dependencies: ProviderDependencies, task: ProviderTask) {
  const { id, record, projectRoot } = task;
  const { options, setupFor, profileFor, codexProjects } = dependencies;
  const store = options.store;
  const protocol = comparisonProtocol(store, protocolRow(store, setupFor(record).workflow.assignment.protocol_id));
  const ordinaryFamily = !options.qualificationLease && !options.nativePilot && protocol.schema_version === 2 && isAdmittedCodexBindingProtocol(protocol);
  const workflow = setupFor(record).workflow;
  const ordinaryAdmission = ordinaryFamily ? getCodexBindingAdmission(workflow.product_version) : undefined;
  const savedProjectConfig =
    workflow.assignment.metadata.product === 'codex' && !options.qualificationLease && !options.nativePilot
      ? codexProjects.configuration(workflow.assignment.project_id)
      : undefined;
  const projectConfig = savedProjectConfig?.product_version === workflow.product_version ? savedProjectConfig : undefined;
  const config = projectConfig ? { ...projectConfig, project_root: projectRoot } : profileFor(record.profile_id).session_binding;
  if (!config) return undefined;
  if (config.product === 'codex' && !applicationRequired(store, id) && config.project_root !== projectRoot) throw new Error('binding_scope_mismatch');
  if (projectConfig) {
    const receiptState = codexReceiptDirectoryState(config.receipt_directory);
    if (receiptState !== 'ready') throw new Error(receiptState === 'missing' ? 'receipt_directory_missing' : 'receipt_directory_unsafe');
  }
  return { config, ordinaryAdmission };
}

function profileProviders(dependencies: ProviderDependencies, task: ProviderTask): SessionBindingProvider[] {
  const { id, projectRoot } = task;
  const { options, humanPilot } = dependencies;
  const store = options.store;
  const configuration = profileConfiguration(dependencies, task);
  if (!configuration) return [];
  const { config, ordinaryAdmission } = configuration;
  try {
    return config.product === 'codex'
      ? [codexProvider(dependencies, task, { config, ordinaryAdmission })]
      : [
          new ClaudeSessionBindingProvider({
            receiptDir: config.receipt_directory,
            claudeProjectsDir: config.claude_projects_directory,
            projectRoot,
            ...(options.nativePilot
              ? {
                  allowCandidateProfiles: true,
                  maxFamilyMembers: 3,
                  authorizeSource: source => {
                    const scope = humanPilot();
                    if (!scope || options.nativePilot?.taskId !== id) throw new Error('binding_source_unqualified');
                    assertClaudeHumanPilotSource(scope, store, id, source);
                  }
                }
              : {})
          })
        ];
  } catch (error) {
    if (
      !options.qualificationLease &&
      !options.nativePilot &&
      config.product === 'codex' &&
      error instanceof Error &&
      'code' in error &&
      error.code === 'ENOENT' &&
      codexReceiptDirectoryState(config.receipt_directory) === 'missing'
    )
      throw new Error('receipt_directory_missing', { cause: error });
    throw error;
  }
}

export function createLocalWebBindingProviders(dependencies: ProviderDependencies) {
  const { options, recordFor, ordinaryBindings } = dependencies;
  const providers = new Map<string, SessionBindingProvider[]>();
  const providersForTask = (id: string, deletedProjectRoot?: string): SessionBindingProvider[] => {
    if (options.bindingProviders) return options.bindingProviders;
    const cached = providers.get(id);
    if (cached) return cached;
    const projectRoot = deletedProjectRoot ?? effectiveTaskWorkspace(options.store, id);
    if (!projectRoot) throw new Error('binding_scope_mismatch');
    if (options.bindingProviderFactory) {
      const callbacks = ordinaryTask(options.store, id)
        ? {
            authorizeSource: (source: Parameters<NonNullable<ClaudeBindingOptions['authorizeSource']>>[0]) => ordinaryBindings().assertSource(id, source),
            memberEligible: (member: Parameters<NonNullable<ClaudeBindingOptions['memberEligible']>>[0]) => ordinaryBindings().memberEligible(id, member)
          }
        : undefined;
      const result = options.bindingProviderFactory(id, projectRoot, callbacks);
      providers.set(id, result);
      return result;
    }
    const record = recordFor(id);
    if (!record) return [];
    if (record.profile_id === 'ordinary-claude') {
      const result = [ordinaryClaudeProvider(dependencies, { id, record, projectRoot })];
      providers.set(id, result);
      return result;
    }
    const result = profileProviders(dependencies, { id, record, projectRoot });
    if (result.length) providers.set(id, result);
    return result;
  };
  return { providers, providersForTask };
}
