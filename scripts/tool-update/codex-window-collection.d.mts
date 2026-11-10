import type { Store } from '../../src/store.js';
export function createSyntheticWindowCollection(capability: object, observedPins: Readonly<Record<string, string>>): {
  readonly origin: 'synthetic';
  readonly actual_qualification: false;
  readonly store: Store;
  readonly taskId: string;
  readonly projectRoot: string;
  readonly sourceRoot: string;
  readonly receiptDirectory: string;
  connect(receipt: unknown): Promise<{ readonly baseline_established: true; readonly actual_qualification: false }>;
  collect(): Promise<void>;
  close(): void;
};
