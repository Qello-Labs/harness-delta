import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TimestampSchema } from '../contracts.js';
import type { LocalWebDomain } from './local-web-server.js';
import { readOrdinaryWindowBindingReport } from '../ordinary-session-binding.js';
import type { Store } from '../store.js';

/** The versioned read surface does not inspect UI setup, skills or native providers. */
export function readLocalWebOrdinaryWindowReport(store: Store, taskId: string, cutoff: string) {
  return readOrdinaryWindowBindingReport(store, taskId, cutoff);
}

export function registerLocalWebTaskReadRoutes(app: FastifyInstance, domain: LocalWebDomain, id: z.ZodString) {
  app.get<{ Params: { id: string } }>('/api/tasks/:id/ordinary-window-report-v1', request => {
    if (!domain.ordinaryWindowReport) throw new Error('binding_window_unavailable');
    const query = z.strictObject({ cutoff: TimestampSchema }).parse(request.query);
    return domain.ordinaryWindowReport(id.parse(request.params.id), query.cutoff);
  });
  app.get<{ Params: { id: string } }>('/api/tasks/:id', (request, reply) => {
    const task = domain.task(id.parse(request.params.id));
    reply.header('ETag', task.version);
    return task;
  });
}
