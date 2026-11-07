import type { ApplicationCoordinator } from '../harness/harness-application.js';
import type { PrivateTask } from './local-web-metadata-store.js';
import type { LocalWebDomain } from './local-web-server.js';

export function createLocalWebApplicationHandlers(
  row: (id: string) => PrivateTask,
  applications: ApplicationCoordinator
): Pick<LocalWebDomain, 'applicationWorkspace' | 'applicationContext' | 'applicationLaunchContext' | 'applicationHandoff' | 'applicationReview'> {
  return {
    applicationWorkspace(taskId, directory) {
      row(taskId);
      return applications.workspace(taskId, directory);
    },
    applicationContext(taskId, attemptId) {
      row(taskId);
      return applications.context(taskId, attemptId);
    },
    applicationLaunchContext(taskId, origin) {
      row(taskId);
      return applications.launchContext(taskId, origin);
    },
    applicationHandoff(taskId, origin) {
      row(taskId);
      return applications.handoff(taskId, origin);
    },
    applicationReview(taskId) {
      row(taskId);
      return applications.review(taskId);
    }
  };
}
