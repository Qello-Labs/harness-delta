import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { z } from 'zod';
import { createLocalWebDomain } from '../../src/web/local-web-domain.js';
import type { SessionBindingProvider, VerifiedSessionIdentity } from '../../src/session-binding-contract.js';
import { localWebFixture } from '../helpers/local-web-fixture.js';

type ObservationStrategy = 'immediate-pause' | 'rejected-ordinary-action' | 'finish-unknown';
function observationFixture(strategy: ObservationStrategy) {
  const f = localWebFixture();
  const signals = new EventEmitter();
  const trace: string[] = [];
  let assertSource: () => void = () => {
    throw new Error('provider_not_created');
  };
  const native = randomUUID();
  const receipt = randomUUID();
  const at = new Date().toISOString();
  const identity: VerifiedSessionIdentity = {
    product: 'claude_code',
    productVersion: '2.1.296',
    sessionId: native,
    parentSessionId: null,
    sourceRef: join(f.root, 'synthetic-session.jsonl'),
    sourceIdentity: randomUUID(),
    cwd: f.project,
    identityEvidenceId: randomUUID(),
    createdAt: at,
    nativeMapping: {
      nativeSessionId: native,
      agentId: null,
      processId: 'synthetic-process'
    }
  };
  const metadata = {
    nativeSessionId: native,
    agentId: null,
    sourceRef: identity.sourceRef,
    sourceIdentity: identity.sourceIdentity,
    birthtimeMs: Date.parse(at),
    recordedAt: at,
    processId: 'synthetic-process'
  };
  writeFileSync(identity.sourceRef, '{}\n');
  const domain = createLocalWebDomain({
    store: f.store,
    metadataFile: f.metadataFile,
    profiles: [f.profile],
    bindingProviderFactory: (_taskId, _root, callbacks) => {
      if (!callbacks) throw new Error('ordinary_callbacks_missing');
      assertSource = () => {
        callbacks.authorizeSource?.(metadata);
      };
      const provider: SessionBindingProvider = {
        product: 'claude_code',
        capabilities: () => ({
          currentIdentity: 'native_hook',
          ancestry: 'verified_relations',
          usage: 'own_requests',
          productionSupported: false,
          maxDepth: 1,
          reasons: []
        }),
        inspectCurrent: () =>
          Promise.resolve({
            receipt,
            recordedAt: at,
            nativeSessionId: native,
            agentId: null,
            sourceRef: identity.sourceRef,
            sourceIdentity: identity.sourceIdentity,
            cwd: f.project,
            processId: 'synthetic-process',
            productVersion: '2.1.296'
          }),
        resolveCurrent: () => {
          callbacks.authorizeSource?.(metadata);
          trace.push('resolve');
          return Promise.resolve(identity);
        },
        revalidateBound: () => {
          callbacks.authorizeSource?.(metadata);
          trace.push('revalidate');
          return Promise.resolve(identity);
        },
        discoverChildren: () => {
          trace.push('discover');
          return Promise.resolve({ children: [], gaps: [] });
        },
        readUsage: (_identity, _cursor, _scope, boundary) => {
          callbacks.authorizeSource?.(metadata);
          if (!boundary?.baseline && strategy === 'finish-unknown') {
            const released = once(signals, 'release-read', {
              signal: AbortSignal.timeout(3000)
            });
            signals.emit('pending-read');
            return released.then(() => {
              trace.push('drained');
              return { records: [], cursor: '0', gaps: [] };
            });
          }
          if (!boundary?.baseline && strategy === 'rejected-ordinary-action') {
            signals.emit('pending-read');
            return Promise.resolve().then(() => {
              callbacks.authorizeSource?.(metadata);
              readFileSync(identity.sourceRef);
              trace.push('read');
              return { records: [], cursor: '0', gaps: [] };
            });
          }
          trace.push(boundary?.baseline ? 'baseline' : 'read');
          return Promise.resolve({
            records: [],
            cursor: '0',
            gaps: []
          });
        },
        forgetSession: () => Promise.resolve()
      };
      return [provider];
    }
  });

  return { f, signals, trace, receipt, domain, assertSource: () => assertSource() };
}

test.each(['immediate-pause', 'rejected-ordinary-action', 'finish-unknown'] as const)(
  'ordinary observation ordering with %s through the domain seam',
  async strategy => {
    const { f, signals, trace, receipt, domain, assertSource } = observationFixture(strategy);
    try {
      if (!domain.ordinaryProjectAction) {
        throw new Error('missing_ordinary_setup');
      }
      await domain.ordinaryProjectAction('project-1', {
        operation: 'configure',
        product_version: '2.1.296',
        claude_projects_directory: join(f.root, 'claude')
      });
      const { id } = z.object({ id: z.string() }).parse(
        await domain.createTask({
          mode: 'ordinary',
          name: 'Synthetic timing',
          project_id: 'project-1',
          criterion_ids: ['accepted']
        })
      );
      const paused = strategy === 'rejected-ordinary-action' ? once(signals, 'paused', { signal: AbortSignal.timeout(3000) }) : undefined;
      if (paused) {
        signals.once('pending-read', () => {
          void domain
            .taskAction(id, 'ticket', {})
            .then(
              () => {
                throw new Error('unexpected_action_success');
              },
              (error: unknown) => {
                expect(error).toBeInstanceOf(Error);
                expect(error instanceof Error && error.message).toBe('invalid_ui_request');
                trace.push('action-rejected');
                return domain.taskAction(id, 'pause', {});
              }
            )
            .then(
              () => {
                signals.emit('paused');
              },
              (error: unknown) => {
                signals.emit('error', error);
              }
            );
        });
      }
      const pendingRead =
        strategy === 'finish-unknown'
          ? once(signals, 'pending-read', {
              signal: AbortSignal.timeout(3000)
            })
          : undefined;
      const connected = await domain.taskAction(id, 'session-connect', {
        product: 'claude_code',
        receipt
      });
      expect(connected).toMatchObject({
        state: 'active',
        connection: { status: 'connected' }
      });
      trace.push('returned');
      if (paused) await paused;
      else if (strategy === 'finish-unknown') {
        await pendingRead;
        expect(assertSource).not.toThrow();
        const outcome = domain.taskAction(id, 'finish-unknown', {}).then(
          () => {
            throw new Error('unexpected_finish_success');
          },
          (error: unknown) => {
            expect(error).toBeInstanceOf(Error);
            expect(error instanceof Error && error.message).toBe('invalid_ui_request');
            trace.push('rejected');
          }
        );
        expect(assertSource).toThrow();
        signals.emit('release-read');
        await outcome;
        expect(trace.filter(event => event === 'drained' || event === 'rejected')).toEqual(['drained', 'rejected']);
        expect(f.store.all('SELECT * FROM outcomes')).toEqual([]);
        expect(f.store.get('SELECT selected_root_id FROM ordinary_tasks WHERE task_id=?', [id])).toEqual({ selected_root_id: null });
      } else await domain.taskAction(id, 'pause', {});
      expect(trace).not.toContain('read');
      expect(domain.task(id).state).toBe('paused');
      expect(f.store.eventCount()).toBe(0);
    } finally {
      signals.emit('release-read');
      await domain.close?.();
      f.cleanup();
    }
  }
);
