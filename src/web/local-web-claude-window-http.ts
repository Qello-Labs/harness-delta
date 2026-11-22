import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { IdSchema } from '../contracts.js';
import { ClaudeWindowActionSchema, ClaudeWindowConnectSchema, type ClaudeWindowControl } from './local-web-claude-window-control.js';
import { ordinaryProjectSettings } from '../ordinary-observation.js';
import type { LocalWebDomain } from './local-web-server.js';

type ClaudeWindowMutation = <T>(
  request: { body: unknown; url: string; headers: Record<string, unknown> },
  parse: (input: unknown) => T,
  execute: (input: T) => Promise<unknown>,
  taskId?: string,
  windowControl?: ClaudeWindowControl
) => Promise<{ status: number; result: unknown }>;

export function registerClaudeWindowPreparationRoute(
  app: FastifyInstance,
  domain: Pick<LocalWebDomain, 'metadataStore' | 'claudeWindow'>,
  create: (request: Parameters<ClaudeWindowMutation>[0]) => ReturnType<ClaudeWindowMutation>
) {
  app.post('/api/tasks', async (request, reply) => {
    const perform = async () => {
      const value = await create(request);
      await reply.code(value.status).send(value.result);
    };
    const scope = z.object({ mode: z.literal('ordinary'), project_id: IdSchema }).safeParse(request.body);
    const control = domain.claudeWindow;
    return scope.success && control && ordinaryProjectSettings(domain.metadataStore, scope.data.project_id)?.bundle_mode === 'ordinary_window'
      ? control.request({ projectId: scope.data.project_id }, perform)
      : perform();
  });
}

export function registerClaudeWindowRoutes(
  app: FastifyInstance,
  control: ClaudeWindowControl | undefined,
  options: {
    csrf: string;
    mutation: ClaudeWindowMutation;
    errorCode: (error: unknown) => string;
  }
) {
  const { csrf, mutation, errorCode } = options;
  app.get<{ Params: { id: string } }>('/api/tasks/:id/claude-window-v1', (request, reply) => {
    if (!control) throw new Error('binding_window_unavailable');
    return control.request({ taskId: request.params.id }, () => {
      z.strictObject({}).parse(request.query);
      const task = control.task(IdSchema.parse(request.params.id));
      reply.header('ETag', task.version);
      return { csrf, task };
    });
  });
  for (const operation of ['connect', 'action'] as const) {
    app.post<{ Params: { id: string } }>(`/api/tasks/:id/claude-window-${operation}-v1`, async (request, reply) => {
      if (!control) throw new Error('binding_window_unavailable');
      return control.request({ taskId: request.params.id }, async () => {
        const taskId = IdSchema.parse(request.params.id);
        try {
          const value = await mutation(
            request,
            input => (operation === 'connect' ? ClaudeWindowConnectSchema.parse(input) : ClaudeWindowActionSchema.parse(input)),
            input => ('receipt' in input ? control.connect(taskId, input) : control.action(taskId, input)),
            taskId,
            control
          );
          await reply.code(value.status).send(value.result);
        } catch (error) {
          const code = errorCode(error);
          await reply.code(['ui_state_changed', 'ui_action_conflict', 'ui_action_uncertain'].includes(code) ? 409 : 400).send({ error: code });
        }
      });
    });
  }
}
