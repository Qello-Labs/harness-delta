import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withOrdinaryWindowReconciliation } from '../ordinary-window-emission.js';
import type { LocalWebDomain } from './local-web-server.js';

const registrationInput = z.strictObject({
  directory: z
    .string()
    .min(1)
    .max(4096)
    .refine(path => !/[\0\r\n]/.test(path))
});
type ProjectMutation = (
  request: { body: unknown; url: string; headers: Record<string, unknown> },
  parse: (input: unknown) => z.infer<typeof registrationInput>,
  execute: (input: z.infer<typeof registrationInput>) => Promise<unknown>
) => Promise<{ status: number; result: unknown }>;

export function registerLocalWebProjectRoute(app: FastifyInstance, domain: LocalWebDomain, mutation: ProjectMutation): void {
  app.post('/api/projects', (request, reply) => {
    const supplied = z.object({ directory: registrationInput.shape.directory.refine(path => resolve(path) === path) }).safeParse(request.body);
    const target: { projectId: string; projectRoot?: string } = { projectId: randomUUID() };
    if (supplied.success) {
      try {
        target.projectRoot = realpathSync(supplied.data.directory);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
      }
    }
    // Invalid supplied roots must not gain repair scope through nested domain registration.
    return withOrdinaryWindowReconciliation(domain.metadataStore, target, async () => {
      const value = await mutation(
        request,
        input => registrationInput.parse(input),
        input => domain.registerProject(input.directory)
      );
      await reply.code(value.status).send(value.result);
    });
  });
}
