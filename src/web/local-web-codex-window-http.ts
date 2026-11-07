import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CodexWindowActionSchema, CodexWindowConnectSchema, type CodexWindowControl, CodexWindowPrepareSchema } from './local-web-codex-window-control.js';
import { IdSchema } from '../contracts.js';

export type CodexWindowMutation = <T>(
  request: { body: unknown; url: string; headers: Record<string, unknown> },
  parse: (input: unknown) => T,
  execute: (input: T) => Promise<unknown>,
  taskId?: string,
  windowControl?: CodexWindowControl
) => Promise<{ status: number; result: unknown }>;

export function registerCodexWindowRoutes(
  app: FastifyInstance,
  control: CodexWindowControl | undefined,
  options: { csrf: string; mutation: CodexWindowMutation; errorCode: (error: unknown) => string }
) {
  const { csrf, mutation, errorCode } = options;
  app.get<{ Params: { id: string } }>('/api/tasks/:id/codex-window-v1', (request, reply) => {
    if (!control) throw new Error('binding_window_unavailable');
    z.strictObject({}).parse(request.query);
    const task = control.task(IdSchema.parse(request.params.id));
    reply.header('ETag', task.version);
    return { csrf, task };
  });
  app.post<{ Params: { id: string } }>('/api/projects/:id/codex-window-prepare-v1', async (request, reply) => {
    if (!control) throw new Error('binding_window_unavailable');
    const value = await mutation(
      request,
      input => CodexWindowPrepareSchema.parse(input),
      input => Promise.resolve(control.prepare(IdSchema.parse(request.params.id), input)),
      undefined,
      control
    );
    await reply.code(value.status).send(value.result);
  });
  for (const operation of ['connect', 'action'] as const) {
    app.post<{ Params: { id: string } }>(`/api/tasks/:id/codex-window-${operation}-v1`, async (request, reply) => {
      if (!control) throw new Error('binding_window_unavailable');
      const taskId = IdSchema.parse(request.params.id);
      try {
        const value = await mutation(
          request,
          input => (operation === 'connect' ? CodexWindowConnectSchema.parse(input) : CodexWindowActionSchema.parse(input)),
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
