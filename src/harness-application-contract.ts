import {z} from 'zod';
import {IdSchema} from './contracts.js';
import {ApplicationWorkspaceSchema} from './harness-application-workspace.js';
export const applicationHash=z.string().regex(/^[a-f0-9]{64}$/);
export const ApplicationSelectionSchema=z.strictObject({workspace:z.string().min(1).max(4096),workspaceDigest:applicationHash,product:z.enum(['codex','claude_code'])});
export const ApplicationCheckpointSchema=z.strictObject({attempt_id:z.uuid(),paths:z.array(z.string().min(1).max(2048)).min(1).max(256)});
export const ApplicationReportSchema=z.strictObject({attempt_id:z.uuid(),bundle_hash:applicationHash,outputs:z.array(z.strictObject({path:z.string().min(1).max(2048),checkpoint_id:z.uuid(),sha256:applicationHash.nullable()})).min(1).max(256),checks:z.array(z.strictObject({check_id:z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,79}$/),outcome:z.enum(['passed','failed','missing','refused'])})).max(64)});
/** The checkbox records the user's own native stop; the server never stops an agent. */
export const ApplicationRestoreSchema=z.strictObject({preview_digest:applicationHash,external_session_stopped:z.literal(true)});
export const ApplicationIdentitySchema=z.strictObject({attempt_id:z.uuid(),product:z.enum(['codex','claude_code']),receipt:z.uuid()});
export const ApplicationContextSchema=z.strictObject({attempt_id:z.uuid(),task_id:IdSchema,project_id:IdSchema,product:z.enum(['codex','claude_code']),variant_id:IdSchema,bundle_path:z.string(),bundle_hash:applicationHash,workspace:ApplicationWorkspaceSchema,epoch:z.number().int().nonnegative(),prior_outputs:z.array(z.strictObject({path:z.string(),sha256:applicationHash.nullable()})).max(256)});
export type ApplicationContext=z.infer<typeof ApplicationContextSchema>;
export type ApplicationSelection=z.infer<typeof ApplicationSelectionSchema>;
