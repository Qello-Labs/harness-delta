export interface WindowNativeLauncherInput {
  readonly argv_tail: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
}
export function deriveWindowNativeRecipe(prefixRoot: string, input: WindowNativeLauncherInput): {
  readonly controller_runtime: {
    readonly node_major: 24;
  };
  readonly argv: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
  readonly resolution: {
    readonly launcher: string;
    readonly platform_package_json: string;
    readonly native: string;
    readonly target_triple: 'aarch64-apple-darwin';
  };
  readonly required_signal_defaults: readonly string[];
  readonly residuals: readonly string[];
};
