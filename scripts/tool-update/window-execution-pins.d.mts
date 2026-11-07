import type { z } from 'zod';
import type { WindowPins } from './fixtures.mjs';

interface WindowExecutionPinFields {
  readonly kind: 'ordinary_window_execution_pins';
  readonly schema_version: 1;
  readonly pin_scheme_revision: 'ordinary-window-execution-v1';
  readonly execution_mode: 'source' | 'built';
  readonly pins: WindowPins;
}
export type WindowExecutionPins = WindowExecutionPinFields & (
  | {
    readonly product: 'codex';
    readonly policy_id: 'codex-binding-root-window-v1';
    readonly policy_revision: 'codex-ordinary-root-window-v1';
    readonly evidence_mode: 'source_only';
  }
  | {
    readonly product: 'claude_code';
    readonly policy_id: 'claude-binding-root-window-v1';
    readonly policy_revision: 'claude-ordinary-root-window-v1';
    readonly evidence_mode: 'publisher_verified_local_pin';
  }
);
export const windowExecutionPinsSchema: z.ZodType<WindowExecutionPins>;
export function validateWindowExecutionPins(input: unknown): WindowExecutionPins;
