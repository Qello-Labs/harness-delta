import { z } from 'zod';
import { IdSchema } from '../contracts.js';
import { uuid, time, count, DataPackageSchema } from '../exchange/contracts.js';
import { MappingSchema } from '../exchange/mapping.js';
export const TeamRequestSchema = z.strictObject({
  schema_version: z.literal(1),
  snapshot_id: IdSchema,
  local_project_id: IdSchema,
  shared_project_id: uuid,
  protocol_id: IdSchema,
  cutoff: time,
  as_of: time,
  required_namespaces: z
    .array(uuid)
    .min(1)
    .max(256)
    .refine(a => new Set(a).size === a.length)
});
export const TeamInputSchema = z.strictObject({
  schema_version: z.literal(1),
  descriptive_version: z.literal('team-descriptive-1'),
  request: TeamRequestSchema,
  mapping: MappingSchema,
  created_at: time,
  merged_revision: count,
  snapshot_sequence: count.refine(n => n > 0),
  contributions: z
    .array(z.strictObject({ received_at: time, package: DataPackageSchema }))
    .min(1)
    .max(256)
});
export type TeamInput = z.infer<typeof TeamInputSchema>;
export type TeamRequest = z.infer<typeof TeamRequestSchema>;
