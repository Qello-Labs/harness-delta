import type { z } from 'zod';
import type { laneSchema } from './lanes.mjs';
export const versionSchema: z.ZodString;
export const shaSchema: z.ZodString;
export const maxRecordBytes: number;
export class ToolUpdateError extends Error { readonly code: string; constructor(code: string); }
export function fail(code: string): never;
export function compareVersions(a: string, b: string): number;
export function canonical(value: unknown): string;
export function digest(value: unknown): string;
export interface BaselineRow extends z.infer<typeof laneSchema> {
  readonly last_reviewed_version: string;
  readonly contract_revision: 'consumed-v1';
  readonly evidence_ids: readonly string[];
  readonly source_digest: string;
}
export interface Baseline {
  readonly schema_version: 1;
  readonly kind: 'baseline';
  readonly rows: readonly BaselineRow[];
}
export const baselineSchema: z.ZodType<Baseline>;
export function laneKey(row: z.infer<typeof laneSchema>): string;
export function parseBaseline(input: unknown): Baseline;
export function boundedParse<T>(input: unknown, schema: z.ZodType<T>): T;
export function loadRecord<T>(path: string, schema: z.ZodType<T>): Promise<T>;
export function publishRecord<T>(root: string, input: T, schema: z.ZodType<T>): Promise<string>;
