export interface WindowUsageVector {
  readonly input: number;
  readonly output: number;
  readonly cached: number;
  readonly reasoning: number;
}
export interface WindowOracle {
  connect(): {
    receive(chunk: Buffer): boolean;
    start(): Buffer;
    complete(): Buffer;
    close(): void;
  };
  summary(): {
    readonly origin: 'synthetic';
    readonly actual_qualification: false;
    readonly connections: number;
    readonly http_requests: number;
    readonly requests: number;
    readonly completed: number;
    readonly request_wire_bytes: number;
    readonly response_wire_bytes: number;
    readonly buffered_body_bytes: number;
    readonly terminal_usage: 'observed' | 'missing';
    readonly input_tokens: number | null;
    readonly output_tokens: number | null;
    readonly cached_input_tokens: number | null;
    readonly reasoning_tokens: number | null;
    readonly stopped: boolean;
  };
}
export function createWindowOracle(vectors: readonly WindowUsageVector[]): WindowOracle;
export interface WindowOracleServerOptions {
  readonly port: number;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}
export interface WindowOracleServer {
  readonly events: import('node:events').EventEmitter;
  listen(): Promise<number>;
  start(): Promise<void>;
  complete(): Promise<void>;
  close(): Promise<void>;
  summary(): ReturnType<WindowOracle['summary']> & { readonly listener_closed: boolean };
}
export function createWindowOracleBatch(): {
  createCase(vectors: readonly WindowUsageVector[]): WindowOracle;
  createServer(vectors: readonly WindowUsageVector[], options: WindowOracleServerOptions): WindowOracleServer;
};
export function createWindowOracleServer(vectors: readonly WindowUsageVector[], options: WindowOracleServerOptions): WindowOracleServer;
