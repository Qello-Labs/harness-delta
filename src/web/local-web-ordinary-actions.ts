import { z } from 'zod';
import { parseTaskMetadata } from '../flexible-contracts.js';
import { assertOrdinaryTaskPrepared, revokeOrdinaryObservation } from '../ordinary-observation.js';
import type { createOrdinarySessionBindingService } from '../ordinary-session-binding.js';
import type { LocalWebWorkflowActionDependencies, LocalWebTaskActionRequest } from './local-web-workflow-actions.js';

const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/);

export interface LocalWebOrdinaryActionDependencies extends Pick<
  LocalWebWorkflowActionDependencies,
  'store' | 'metadata' | 'life' | 'jobs' | 'taskDto' | 'beginBindingObservation'
> {
  readonly ordinaryBindings: ReturnType<typeof createOrdinarySessionBindingService>;
}

function finishOrdinaryTask(deps: LocalWebOrdinaryActionDependencies, request: LocalWebTaskActionRequest) {
  const { id, action, input } = request;
  const outcome = action === 'finish-success' ? 'success' : action === 'finish-failed' ? 'failed' : action === 'finish-abandoned' ? 'aborted' : null;
  if (outcome === null) throw new Error('invalid_ui_request');
  const metadata = parseTaskMetadata(JSON.parse(deps.life.task(id).metadata));
  const criteria = outcome === 'success' ? z.array(identifier).parse(input.criteria ?? metadata.criterion_ids) : [];
  deps.life.finalize(id, outcome, criteria);
}

export async function localWebOrdinaryAction(deps: LocalWebOrdinaryActionDependencies, request: LocalWebTaskActionRequest) {
  const { id, action, input } = request;
  const { store, metadata, life, jobs, ordinaryBindings, taskDto, beginBindingObservation } = deps;
  if (action === 'session-connect' || action === 'resume-binding') assertOrdinaryTaskPrepared(store, id);
  if (action === 'session-connect') {
    const product = z.enum(['codex', 'claude_code']).parse(input.product);
    const receipt = z.uuid().parse(input.receipt);
    const previous = jobs.get(id);
    if (previous) {
      previous.pauseRequested = true;
      await previous.promise;
    }
    const connection = await ordinaryBindings.connect(id, product, { receipt });
    metadata.setReason(id, null);
    beginBindingObservation(id);
    return {
      ...taskDto(id),
      connection: {
        ...connection,
        project_id: life.task(id).project_id,
        task_id: id,
        identity_basis: 'native_metadata_receipt',
        evidence: 'server_verified_identity_source_and_relations',
        collection_active: true,
        cost_coverage: 'partial'
      }
    };
  }
  if (action === 'resume-binding') {
    await ordinaryBindings.resume(id);
    beginBindingObservation(id);
    return taskDto(id);
  }
  if (action === 'revoke-collection') {
    const previous = jobs.get(id);
    if (previous) previous.pauseRequested = true;
    revokeOrdinaryObservation(store, id);
    await ordinaryBindings.stopObservation(id);
    await previous?.promise;
    metadata.setReason(id, null);
    return taskDto(id);
  }
  if (action === 'pause' || action === 'stop-observation' || action.startsWith('finish-')) {
    const previous = jobs.get(id);
    if (previous) previous.pauseRequested = true;
    if (action === 'pause') ordinaryBindings.pause(id);
    else await ordinaryBindings.stopObservation(id);
    await previous?.promise;
    if (action.startsWith('finish-')) finishOrdinaryTask(deps, request);
    metadata.setReason(id, null);
    return taskDto(id);
  }
  throw new Error('invalid_ui_request');
}
