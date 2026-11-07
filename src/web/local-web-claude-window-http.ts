import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { IdSchema } from '../contracts.js';
import { ClaudeWindowActionSchema, ClaudeWindowConnectSchema, type ClaudeWindowControl } from './local-web-claude-window-control.js';

type ClaudeWindowMutation = <T>(
  request: { body: unknown; url: string; headers: Record<string, unknown> },
  parse: (input: unknown) => T,
  execute: (input: T) => Promise<unknown>,
  taskId?: string,
  windowControl?: ClaudeWindowControl
) => Promise<{ status: number; result: unknown }>;

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
    z.strictObject({}).parse(request.query);
    const task = control.task(IdSchema.parse(request.params.id));
    reply.header('ETag', task.version);
    return { csrf, task };
  });
  for (const operation of ['connect', 'action'] as const) {
    app.post<{ Params: { id: string } }>(`/api/tasks/:id/claude-window-${operation}-v1`, async (request, reply) => {
      if (!control) throw new Error('binding_window_unavailable');
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
  }
}
