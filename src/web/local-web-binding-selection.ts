import { appendFamilyDiagnostic } from '../binding-family-diagnostics.js';
import { assertOrdinaryWindowSurfaceClosed } from '../core/ordinary-window-store.js';
import type { ExternalTaskSetup } from '../external-session-service.js';
import { ordinaryTask } from '../ordinary-observation.js';
import { createOrdinarySessionBindingService } from '../ordinary-session-binding.js';
import { ClaudeSessionBindingProvider } from '../session-binding-claude.js';
import { issueClaudeHumanPilotScope, isClaudeHumanPilotScope } from '../session-binding-claude-human-pilot.js';
import { CodexSessionBindingProvider } from '../session-binding-codex.js';
import type { BindingProduct } from '../session-binding-contract.js';
import { issueCodexHumanPilotScope, type HumanPilotScope } from '../session-binding-human-pilot.js';
import { createSessionBindingService } from '../session-binding-service.js';
import { createLocalWebBindingProviders } from './local-web-binding-providers.js';
import type { createCodexProjectSetupManager } from './local-web-codex.js';
import type { LocalWebDomainOptions } from './local-web-domain.js';
import type { createLocalWebMetadata, PrivateTask } from './local-web-metadata-store.js';
import type { LocalWebProfile } from './local-web-profile.js';

interface BindingSelectionDependencies {
  readonly options: LocalWebDomainOptions;
  readonly recordFor: ReturnType<typeof createLocalWebMetadata>['task'];
  readonly row: (id: string) => PrivateTask;
  readonly setupFor: (record: PrivateTask) => ExternalTaskSetup;
  readonly profileFor: (id: string) => LocalWebProfile;
  readonly codexProjects: ReturnType<typeof createCodexProjectSetupManager>;
}

export function createLocalWebBindingSelection(dependencies: BindingSelectionDependencies) {
  const { options, row, setupFor } = dependencies;
  const store = options.store;
  const { providers, providersForTask } = createLocalWebBindingProviders({
    ...dependencies,
    ordinaryBindings: () => ordinaryBindings,
    humanPilot: () => humanPilot
  });
  let humanPilot: HumanPilotScope | undefined;
  if (options.nativePilot) {
    const provider = providersForTask(options.nativePilot.taskId)[0];
    if (!(provider instanceof CodexSessionBindingProvider) && !(provider instanceof ClaudeSessionBindingProvider))
      throw new Error('binding_pilot_scope_invalid');
    // Issuance inspects task/protocol metadata only; preparation grants no reads.
    const scope =
      provider instanceof ClaudeSessionBindingProvider
        ? issueClaudeHumanPilotScope(store, options.nativePilot.taskId, provider, { untilExplicitStop: options.nativePilot.untilExplicitStop === true })
        : issueCodexHumanPilotScope(store, options.nativePilot.taskId, provider, { untilExplicitStop: options.nativePilot.untilExplicitStop === true });
    if (options.nativePilot.observe) humanPilot = scope;
  }
  const familyDiagnosticsEnabled = !!humanPilot && isClaudeHumanPilotScope(humanPilot);
  const writeFamilyDiagnostic = (diagnostic: unknown) => appendFamilyDiagnostic(options.metadataFile + '.family-diagnostics.jsonl', diagnostic);
  const legacyBindings = createSessionBindingService({
    store,
    providers: options.bindingProviders ?? [],
    setupFor: id => setupFor(row(id)),
    providersForTask,
    ...(options.bindingObservation ? { bindingObservation: options.bindingObservation } : {}),
    ...(options.qualificationLease ? { qualificationLease: options.qualificationLease } : {}),
    ...(humanPilot
      ? {
          humanPilot,
          ...(familyDiagnosticsEnabled
            ? { onFamilyRejection: writeFamilyDiagnostic, ...(options.onChildReadiness ? { onChildReadiness: options.onChildReadiness } : {}) }
            : {})
        }
      : {}),
    syntheticProviderForTask(provider, id) {
      return !!options.bindingProviderFactory && !!providers.get(id)?.includes(provider);
    }
  });
  const ordinaryBindings = createOrdinarySessionBindingService({
    store,
    providersForTask,
    syntheticProviderForTask: () => options.bindingProviders !== undefined || options.bindingProviderFactory !== undefined
  });
  const selectedService = (id: string) => {
    assertOrdinaryWindowSurfaceClosed(store, id);
    return ordinaryTask(store, id) ? ordinaryBindings : legacyBindings;
  };
  const bindings = {
    status: (id: string) => selectedService(id).status(id),
    pause: (id: string) => selectedService(id).pause(id),
    resumeAvailable: (id: string) => selectedService(id).resumeAvailable(id),
    sourceSupported: (id: string, product: BindingProduct) => selectedService(id).sourceSupported(id, product),
    capabilities: (id: string, product: BindingProduct) => selectedService(id).capabilities(id, product),
    connect: (id: string, product: BindingProduct, input: { receipt: string }) => selectedService(id).connect(id, product, input),
    resume: (id: string) => selectedService(id).resume(id),
    tick: (id: string) => selectedService(id).tick(id),
    flushForgotten: async () => {
      await legacyBindings.flushForgotten();
      await ordinaryBindings.flushForgotten();
    }
  };
  // Reopening never resumes an unobserved interval; reconnect baselines again.
  for (const task of store.all<{ task_id: string }>("SELECT DISTINCT task_id FROM session_bindings WHERE state='observing'")) {
    if (!ordinaryTask(store, task.task_id)) legacyBindings.pause(task.task_id);
  }
  return { providers, providersForTask, humanPilot, familyDiagnosticsEnabled, writeFamilyDiagnostic, legacyBindings, ordinaryBindings, bindings };
}
