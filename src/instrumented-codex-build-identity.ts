import { constants, closeSync, fstatSync, openSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { canonicalJson } from './reports/comparison-snapshot.js';
import {
  InstrumentedBuildIdentitySchema,
  type InstrumentedBuildIdentity, type InstrumentedProducerProfile,
} from './instrumented-codex-contracts.js';
import type { Store } from './store.js';

export class InstrumentedBuildIdentityError extends Error {
  readonly name = 'InstrumentedBuildIdentityError';
  constructor(readonly code: 'binary_changed' | 'unqualified_build' | 'profile_mismatch') { super(code); }
}

export function hashInstrumentedBinary(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile()) throw new InstrumentedBuildIdentityError('binary_changed');
    const bytes = readFileSync(fd);
    const after = fstatSync(fd, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
      throw new InstrumentedBuildIdentityError('binary_changed');
    }
    return createHash('sha256').update(bytes).digest('hex');
  } finally { closeSync(fd); }
}

export function readInstrumentedBuildIdentity(
  store: Store, profile: InstrumentedProducerProfile,
): InstrumentedBuildIdentity | null {
  const row = store.get<{ payload: string }>(
    'SELECT payload FROM instrumented_codex_build_identities WHERE binary_sha256=? AND manifest_hash=?',
    [profile.binary_sha256, profile.build_manifest_digest]);
  if (!row) return null;
  const identity = InstrumentedBuildIdentitySchema.parse(JSON.parse(row.payload));
  if (canonicalJson(identity.profile) !== canonicalJson(profile)) {
    throw new InstrumentedBuildIdentityError('profile_mismatch');
  }
  return identity;
}

export function resolveInstrumentedBuildIdentity(
  store: Store, binaryPath: string, profile: InstrumentedProducerProfile,
): InstrumentedBuildIdentity {
  if (hashInstrumentedBinary(binaryPath) !== profile.binary_sha256) {
    throw new InstrumentedBuildIdentityError('binary_changed');
  }
  const identity = readInstrumentedBuildIdentity(store, profile);
  if (!identity) throw new InstrumentedBuildIdentityError('unqualified_build');
  return identity;
}
