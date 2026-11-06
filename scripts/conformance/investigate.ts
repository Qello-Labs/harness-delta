import type { ConfirmationPlan } from './confirm.js';
import { toolVersionRecipe } from '../../src/core/tool-version-profiles.js';
import { classifyCounters, classifySessionTopology } from './checks.js';
import { matchExactSessionFilename } from './filename.js';
import type { CandidateInspection } from './parse-candidate.js';
import { projectReport, type ConformanceReport } from './report.js';

export interface InvestigationMapping {
  readonly projectId: string;
  readonly taskId: string;
  readonly processId: string;
  readonly sessionId: string;
  readonly sourcePath: string;
  readonly product: 'codex' | 'claude_code';
}

export function createInvestigation(input: InvestigationMapping): InvestigationMapping {
  return Object.freeze({ ...input });
}

export interface ProductChannel {
  start(plan: ConfirmationPlan): 'refused' | CandidateInspection;
}

export function refusedChannel(): ProductChannel {
  return { start() { return 'refused'; } };
}

export function runInvestigation(input: {
  version?: string;
  mapping: InvestigationMapping;
  channel: ProductChannel;
  plan: ConfirmationPlan;
  names: readonly string[];
  openFile?: () => void;
  writeEvent?: () => void;
  pauseOrRotation?: boolean;
}): { status: 'stopped' } | { status: 'report'; report: ConformanceReport } {
  const match = matchExactSessionFilename(input.names, input.mapping.sessionId, input.mapping.product);
  if (input.pauseOrRotation === true || match !== 'match') return { status: 'stopped' };
  const started = input.channel.start(input.plan);
  if (started === 'refused') return { status: 'stopped' };
  const checks = {
    ...classifyCounters({
      total: started.vectors.total,
      last: started.vectors.last,
      exec: started.vectors.exec,
      priorTotal: started.vectors.priorTotal,
      inputIncludesCacheWrite: false,
    }),
    ...classifySessionTopology(started.topology),
  };
  return {
    status: 'report',
    report: projectReport({
      modes: { collaboration: [...new Set(started.topology.collaborationModes)], multiAgent: [...new Set(started.topology.multiAgentVersions)] },
      version: input.version ?? toolVersionRecipe('codex-file-conformance-01580').version,
      scenario: 'synthetic',
      traversal: started.traversal,
      checks,
      expectations: {},
      prior: null,
      blocked: started.blocked,
    }),
  };
}
