import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { z } from 'zod';

/** Narrow declaration check for pinned 0.160 TurnContextItem. PermissionProfile
 * is authoritative; legacy/split fields can only corroborate it. This records
 * no permission paths and does not attest native/kernel enforcement. */
export type CandidateWireMode = 'default' | 'bypassPermissions';
export type CandidatePermissionField =
  'approval_policy' | 'approvals_reviewer' | 'sandbox_policy' | 'permission_profile' | 'file_system_sandbox_policy' | 'permission_mode';
export class CandidatePermissionFailure extends Error {
  constructor(
    readonly field: CandidatePermissionField,
    code = 'candidate_permissions_invalid'
  ) {
    super(code);
  }
}
const text = z
  .string()
  .min(1)
  .max(4096)
  .refine(value => !value.includes('\0'));
const pathSchema = z.union([
  z.strictObject({ type: z.literal('path'), path: text.refine(isAbsolute) }),
  z.strictObject({ type: z.literal('glob_pattern'), pattern: text }),
  z.strictObject({
    type: z.literal('special'),
    value: z.union([
      z.strictObject({ kind: z.enum(['root', 'minimal', 'tmpdir', 'slash_tmp']) }),
      z.strictObject({ kind: z.literal('project_roots'), subpath: text.optional() })
    ])
  })
]);
const entrySchema = z.strictObject({ path: pathSchema, access: z.enum(['read', 'deny']), missing_path_behavior: z.literal('skip').optional() });
const entriesSchema = z.array(entrySchema).max(1024);
const depthSchema = z.number().int().positive().optional();
const profileSchema = z.strictObject({
  type: z.literal('managed'),
  file_system: z.strictObject({
    type: z.literal('restricted'),
    entries: entriesSchema,
    glob_scan_max_depth: depthSchema
  }),
  network: z.literal('restricted')
});
const legacySchema = z.strictObject({ type: z.literal('read-only'), network_access: z.literal(false).optional() });
const splitSchema = z.strictObject({ kind: z.literal('restricted'), entries: entriesSchema.default([]), glob_scan_max_depth: depthSchema });
function checked<T>(schema: z.ZodType<T>, value: unknown, field: CandidatePermissionField): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new CandidatePermissionFailure(field);
  return parsed.data;
}
export function checkCandidatePermissions(context: Record<string, unknown>, wireMode: CandidateWireMode) {
  const approvalPolicy = checked(z.enum(['never', 'on-request']), context.approval_policy, 'approval_policy');
  const reviewer = checked(z.enum(['user', 'auto_review']), context.approvals_reviewer, 'approvals_reviewer');
  if (approvalPolicy === 'on-request' && reviewer !== 'auto_review') throw new CandidatePermissionFailure('approvals_reviewer');
  if (wireMode !== (approvalPolicy === 'never' ? 'bypassPermissions' : 'default'))
    throw new CandidatePermissionFailure('permission_mode', 'candidate_permission_mode_mismatch');
  const legacy = checked(legacySchema, context.sandbox_policy, 'sandbox_policy');
  const profile = checked(profileSchema, context.permission_profile, 'permission_profile');
  const split =
    context.file_system_sandbox_policy === undefined || context.file_system_sandbox_policy === null
      ? null
      : checked(splitSchema, context.file_system_sandbox_policy, 'file_system_sandbox_policy');
  if (
    split !== null &&
    (JSON.stringify(split.entries) !== JSON.stringify(profile.file_system.entries) || split.glob_scan_max_depth !== profile.file_system.glob_scan_max_depth)
  )
    throw new CandidatePermissionFailure('file_system_sandbox_policy');
  return {
    approvalPolicy,
    reviewer,
    wireMode,
    declaration: 'managed_read_only_restricted' as const,
    // Memory-only continuity proof. Neither paths nor their hash enter results/DB.
    signature: createHash('sha256').update(JSON.stringify({ approvalPolicy, reviewer, legacy, profile, split })).digest('hex')
  };
}
