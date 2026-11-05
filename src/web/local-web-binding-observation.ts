import { setTimeout as delay } from 'node:timers/promises';
import { takeFamilyDiagnostic } from '../binding-family-diagnostics.js';
import { noteQualificationCollectorError, revokeBindingQualification } from '../session-binding-qualification-lease.js';
import type { createLocalWebBindingSelection } from './local-web-binding-selection.js';
import type { LocalWebDomainOptions } from './local-web-domain.js';
import type { createLocalWebMetadata } from './local-web-metadata-store.js';
import { localWebError } from './local-web-server.js';

export interface Job {
  promise: Promise<void>;
  pauseRequested: boolean;
}

interface BindingObservationDependencies {
  readonly options: LocalWebDomainOptions;
  readonly jobs: Map<string, Job>;
  readonly bindings: ReturnType<typeof createLocalWebBindingSelection>['bindings'];
  readonly familyDiagnosticsEnabled: boolean;
  readonly writeFamilyDiagnostic: ReturnType<typeof createLocalWebBindingSelection>['writeFamilyDiagnostic'];
  readonly setReason: ReturnType<typeof createLocalWebMetadata>['setReason'];
}

export function createLocalWebBindingObservation(dependencies: BindingObservationDependencies) {
  const { options, jobs, bindings, familyDiagnosticsEnabled, writeFamilyDiagnostic, setReason } = dependencies;
  const store = options.store;
  const beginBindingObservation = (id: string) => {
    if (jobs.has(id)) return;
    const job: Job = { promise: Promise.resolve(), pauseRequested: false };
    jobs.set(id, job);
    job.promise = (async () => {
      try {
        while (!job.pauseRequested && store.get<{ state: string }>('SELECT state FROM tasks WHERE id=?', [id])?.state === 'active') {
          await bindings.tick(id);
          await delay(250);
        }
      } catch (error) {
        const expectedPause = job.pauseRequested && error instanceof Error && error.message === 'binding_scope_revoked';
        if (!expectedPause) options.bindingObservation?.error(error);
        if (store.get('SELECT id FROM tasks WHERE id=?', [id])) {
          const diagnostic =
            familyDiagnosticsEnabled && options.nativePilot?.taskId === id && !job.pauseRequested ? takeFamilyDiagnostic(error, id, store) : null;
          setReason(id, expectedPause ? 'measurement_paused' : localWebError(error));
          if (!expectedPause && options.qualificationLease) {
            noteQualificationCollectorError(options.qualificationLease, error);
            revokeBindingQualification(options.qualificationLease);
          }
          try {
            bindings.pause(id);
          } catch (pauseError) {
            // Pause fences are durable even when a clock/gap write fails.
            if (options.qualificationLease) noteQualificationCollectorError(options.qualificationLease, pauseError);
          }
          if (diagnostic) writeFamilyDiagnostic(diagnostic);
        }
      } finally {
        jobs.delete(id);
      }
    })();
  };
  return { beginBindingObservation };
}
