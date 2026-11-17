import type { DiscoveryCheck, DiscoveryOptions } from './discovery.mjs';

export function transport(
  fetchImpl: NonNullable<DiscoveryOptions['fetchImpl']>,
  now: () => string,
  signal: AbortSignal
): {
  readonly stamp: () => string;
  readonly bindRepository: (identity: { readonly repository: string; readonly id: number }) => void;
  readonly get: (
    url: string,
    source: DiscoveryCheck['source'],
    key: string
  ) => Promise<{ readonly body: unknown; readonly link: string | null }>;
  readonly revalidate: () => Promise<void>;
  readonly checks: () => readonly DiscoveryCheck[];
};
