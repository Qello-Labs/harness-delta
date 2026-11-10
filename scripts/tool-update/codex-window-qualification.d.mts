export function assessWindowContainment(input: unknown): {
  readonly passed: boolean;
  readonly actual_target_qualified: false;
  readonly checked: number;
};
export function qualifyWindowContainment(out: string): Promise<{
  readonly schema_version: number;
  readonly kind: string;
  readonly origin: string;
  readonly containment_verified: boolean;
  readonly native_exec_mapping_verified: boolean;
  readonly historical_controls_verified: false;
  readonly actual_target_qualified: false;
  readonly execution_enabled: false;
  readonly controls: readonly unknown[];
  readonly cleanup_verified: boolean;
  readonly failure: string | null;
}>;
