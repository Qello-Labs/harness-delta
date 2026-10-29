export interface ToolUpdateOptions {
  readonly root?: string;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => string;
}
export interface ToolUpdateResult {
  readonly exitCode: number;
  readonly output: {
    readonly status: string;
    readonly candidate_id?: string | null;
    readonly observation_id?: string;
    readonly assessment_id?: string;
    readonly heads?: {
      readonly github: string | null;
      readonly npm_latest: string | null;
      readonly npm_stable: string | null;
    };
  };
}
export function runToolUpdate(argv: readonly string[], options?: ToolUpdateOptions): Promise<ToolUpdateResult>;
