import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { comparisonProtocol, protocolRow } from '../core/protocol-store.js';
import { readOnlinePriceCatalogStatus, refreshOnlinePriceCatalog } from '../pricing/price-catalog-online.js';
import { ordinaryProjectAction, ordinaryProjectDto } from './local-web-ordinary.js';
import { localWebRecruitment } from './local-web-recruitment.js';
import type { Store } from '../store.js';
import type { Lifecycle } from '../lifecycle.js';
import type { SessionBindingProvider } from '../session-binding-contract.js';
import type { createSessionBindingService } from '../session-binding-service.js';
import type { createCodexProjectSetupManager } from './local-web-codex.js';
import type { createLocalWebMetadata } from './local-web-metadata-store.js';
import type { LocalWebProfile } from './local-web-profile.js';
import type { LocalWebDomain } from './local-web-server.js';
import type { LocalWebDomainOptions, projectBaseline as readProjectBaseline, localWebSupport as readLocalWebSupport } from './local-web-domain.js';

type ProjectDependencies = {
  readonly life: Lifecycle;
  readonly metadata: ReturnType<typeof createLocalWebMetadata>;
  readonly profiles: () => LocalWebProfile[];
  readonly taskDto: LocalWebDomain['task'];
  readonly bindings: Pick<ReturnType<typeof createSessionBindingService>, 'flushForgotten'>;
  readonly providers: Map<string, SessionBindingProvider[]>;
  readonly codexProjects: ReturnType<typeof createCodexProjectSetupManager>;
  readonly picker: NonNullable<LocalWebDomainOptions['picker']>;
  readonly projectBaseline: typeof readProjectBaseline;
  readonly localWebSupport: typeof readLocalWebSupport;
};

async function bootstrapProjects(store: Store, dependencies: ProjectDependencies) {
  const { codexProjects, bindings, profiles, projectBaseline, localWebSupport, metadata, taskDto } = dependencies;
  codexProjects.pruneDeleted();
  await bindings.flushForgotten();
  const allProfiles = profiles().filter(
    p =>
      store.get<{ status: string }>('SELECT status FROM comparison_protocols WHERE id=?', [p.setup.workflow.assignment.protocol_id])?.status === 'frozen' &&
      store.get('SELECT id FROM projects WHERE id=?', [p.setup.workflow.assignment.project_id])
  );
  const projects = store.all<{ id: string; local_root: string }>('SELECT id,local_root FROM projects').map(p => {
    let baseline: string | null = null;
    try {
      baseline = projectBaseline(p.local_root);
    } catch {
      /* Show unavailable without creating a commit. */
    }
    const ordinary = ordinaryProjectDto(store, p.id);
    return {
      id: p.id,
      name: basename(p.local_root),
      directory: p.local_root,
      baseline,
      setup_ids: allProfiles.filter(s => s.setup.workflow.assignment.project_id === p.id).map(s => s.id),
      ordinary: {
        configured: ordinary.configured,
        product_version: ordinary.product_version,
        installation_state: ordinary.installation.state,
        qualified: ordinary.admission.qualified
      }
    };
  });
  const setups = allProfiles.map(p => {
    const protocol = comparisonProtocol(store, protocolRow(store, p.setup.workflow.assignment.protocol_id));
    const strata = protocol.strata.filter(s => s.assignees.includes(p.setup.workflow.assignment.metadata.assignee));
    return {
      id: p.id,
      name: p.name,
      project_id: p.setup.workflow.assignment.project_id,
      arm_a: protocol.variant_ids[0],
      arm_b: protocol.variant_ids[1],
      recruitment: localWebRecruitment(protocol),
      application_mode: p.setup.workflow.application ? ('agent_applied' as const) : ('selected_markdown_only' as const),
      ...(p.shared_binding
        ? {
            shared: {
              revision_id: p.id,
              template_id: p.shared_binding.template_id,
              template_name: profiles().find(row => row.id === p.shared_binding!.template_id)?.name ?? p.shared_binding.template_id,
              runtime: p.setup.runtime
            }
          }
        : {}),
      types: [...new Set(strata.flatMap(s => s.types))],
      sizes: [...new Set(strata.flatMap(s => s.sizes))],
      support: `${p.setup.workflow.assignment.metadata.product} ${p.setup.workflow.product_version}: route-specific gates; partial cost only`,
      support_details: localWebSupport(store, p)
    };
  });
  const tasks = metadata.taskIds().flatMap(t => {
    try {
      return [taskDto(t.id)];
    } catch {
      return [];
    }
  });
  return { projects, setups, tasks, catalog: readOnlinePriceCatalogStatus(store) };
}

export function createLocalWebProjectHandlers(
  options: LocalWebDomainOptions,
  dependencies: ProjectDependencies
): Pick<
  LocalWebDomain,
  'bootstrap' | 'ordinaryProject' | 'ordinaryProjectAction' | 'codexProject' | 'codexProjectAction' | 'registerProject' | 'chooseDirectory' | 'refreshPrices'
> {
  const store = options.store;
  const { life, providers, codexProjects, picker, projectBaseline } = dependencies;
  return {
    bootstrap: () => bootstrapProjects(store, dependencies),
    ordinaryProject: id => ordinaryProjectDto(store, id),
    ordinaryProjectAction(id, input) {
      if (options.nativePilot) throw new Error('binding_pilot_control_only');
      if (options.qualificationLease) throw new Error('binding_qualification_control_only');
      return Promise.resolve(ordinaryProjectAction(store, id, input));
    },
    codexProject: id => codexProjects.inspect(id),
    codexProjectAction(id, input) {
      if (options.nativePilot) throw new Error('binding_pilot_control_only');
      if (options.qualificationLease) throw new Error('binding_qualification_control_only');
      const result = codexProjects.action(id, input);
      if (['configure', 'install', 'remove'].includes(input.operation)) {
        for (const task of store.all<{ id: string }>('SELECT id FROM tasks WHERE project_id=?', [id])) providers.delete(task.id);
      }
      return Promise.resolve(result);
    },
    registerProject(directory) {
      if (options.nativePilot) throw new Error('binding_pilot_control_only');
      if (options.qualificationLease) throw new Error('binding_qualification_control_only');
      const root = realpathSync(resolve(directory));
      projectBaseline(root);
      const previous = store.get<{ id: string }>('SELECT id FROM projects WHERE local_root=?', [root]);
      if (previous) return Promise.resolve({ id: previous.id });
      const id = randomUUID();
      life.registerProject(id, root);
      return Promise.resolve({ id });
    },
    async chooseDirectory() {
      if (options.nativePilot) throw new Error('binding_pilot_control_only');
      if (options.qualificationLease) throw new Error('binding_qualification_control_only');
      return picker('project');
    },
    async refreshPrices() {
      if (options.nativePilot) throw new Error('binding_pilot_control_only');
      if (options.qualificationLease) throw new Error('binding_qualification_control_only');
      return refreshOnlinePriceCatalog(store);
    }
  };
}
