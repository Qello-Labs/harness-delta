import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { z } from 'zod';
import { withLiveWebMetadataScope } from './local-web-metadata.js';
import type { LocalWebDomain } from './local-web-server.js';
import type { createSharedSetupManager } from './local-web-shared.js';
import type { createSetupReviewManager } from './local-web-setup-review.js';
import type { createLocalWebMetadata, PrivateTask, Source } from './local-web-metadata-store.js';
import type { LocalWebDomainOptions, readLocalWebSetupDocument as readSetup, readLocalWebManifest as readManifest } from './local-web-domain.js';

export function createLocalWebSetupHandlers(
  options: LocalWebDomainOptions,
  dependencies: {
    readonly picker: NonNullable<LocalWebDomainOptions['picker']>;
    readonly row: (id: string) => PrivateTask;
    readonly metadata: ReturnType<typeof createLocalWebMetadata>;
    readonly saveProfiles: ReturnType<typeof createLocalWebMetadata>['saveProfiles'];
    readonly sharedSetups: ReturnType<typeof createSharedSetupManager>;
    readonly setupReviews: ReturnType<typeof createSetupReviewManager>;
    readonly readLocalWebSetupDocument: typeof readSetup;
    readonly readLocalWebManifest: typeof readManifest;
  }
): Pick<LocalWebDomain, 'importSetup' | 'bindSetup' | 'reviewSetup' | 'saveReviewedSetup' | 'chooseSession'> {
  const store = options.store;
  const { picker, row, metadata, saveProfiles, sharedSetups, setupReviews, readLocalWebSetupDocument, readLocalWebManifest } = dependencies;
  return {
    async importSetup() {
      if (options.nativePilot) throw new Error('binding_pilot_control_only');
      if (options.qualificationLease) throw new Error('binding_qualification_control_only');
      const path = await picker('setup');
      if (path === null) return { cancelled: true };
      const raw = readLocalWebSetupDocument(path) as { kind?: unknown };
      if (raw.kind === 'harness-delta.comparison') return sharedSetups.preview(path);
      const saved = saveProfiles(readLocalWebManifest(path).profiles);
      return { imported: true, added_count: saved.addedCount, existing_count: saved.existingCount };
    },
    bindSetup(input) {
      if (options.nativePilot) throw new Error('binding_pilot_control_only');
      if (options.qualificationLease) throw new Error('binding_qualification_control_only');
      return Promise.resolve(sharedSetups.bind(input));
    },
    reviewSetup(input) {
      if (options.nativePilot) throw new Error('binding_pilot_control_only');
      if (options.qualificationLease) throw new Error('binding_qualification_control_only');
      return Promise.resolve(setupReviews.review(input));
    },
    saveReviewedSetup(token) {
      if (options.nativePilot) throw new Error('binding_pilot_control_only');
      if (options.qualificationLease) throw new Error('binding_qualification_control_only');
      return Promise.resolve(setupReviews.save(token));
    },
    async chooseSession(taskId) {
      if (options.nativePilot) throw new Error('binding_pilot_control_only');
      if (options.qualificationLease) throw new Error('binding_qualification_control_only');
      row(taskId);
      const selected = await picker('session');
      if (selected === null) return null;
      const path = realpathSync(selected);
      const match = basename(path).match(/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.jsonl$/i);
      if (!match) throw new Error('native_source_unqualified');
      // Filename identity only. Session contents are read exclusively by the scoped domain collector.
      const source: Source = { handle: randomUUID(), label: basename(path), path, session_id: z.uuid().parse(match[1]) };
      withLiveWebMetadataScope(store, { taskId }, () => {
        metadata.saveSource(taskId, source);
      });
      return { handle: source.handle, label: source.label };
    }
  };
}
