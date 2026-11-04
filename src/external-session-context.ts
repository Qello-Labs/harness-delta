import { z } from 'zod';
import { TimestampSchema } from './contracts.js';
import { sha256 } from './harness-managed-file.js';

export interface ExternalStartupExpectation {
  ticketId: string;
  fragmentHash: string;
  issuedAt: string;
}
export interface ExternalContextEvidence {
  nativeCreatedAt: string;
  fragmentHash: string;
}
export function externalInstructionFragment(ticketId: string, instructions: string): string {
  z.uuid().parse(ticketId);
  if (Buffer.byteLength(instructions) > 32768) throw new Error('external_instructions_too_large');
  return `<<<harness-delta:${ticketId}:start>>>\n${instructions}\n<<<harness-delta:${ticketId}:end>>>`;
}

/** Called only after exact root scope/identity and candidate projection validation.
 * Inspect only our supplied developer fragment. Never persist native text. */
export function verifyExternalContext(
  rows: readonly { type: string; timestamp?: string | undefined; payload: Record<string, unknown> }[],
  expected: ExternalStartupExpectation,
  at: string
): ExternalContextEvidence {
  const header = rows[0];
  const parsed = TimestampSchema.safeParse(header?.timestamp ?? header?.payload.timestamp);
  if (!parsed.success || Date.parse(parsed.data) < Date.parse(expected.issuedAt) || Date.parse(parsed.data) > Date.parse(at))
    throw new Error('external_freshness_unverified');
  const start = `<<<harness-delta:${expected.ticketId}:start>>>`;
  const end = `<<<harness-delta:${expected.ticketId}:end>>>`;
  let matches = 0;
  for (const row of rows) {
    if (row.type !== 'response_item' || row.payload.type !== 'message' || row.payload.role !== 'developer') continue;
    const content = z.array(z.object({ type: z.literal('input_text'), text: z.string() }).passthrough()).safeParse(row.payload.content);
    if (!content.success) continue;
    for (const block of content.data) {
      const begin = block.text.indexOf(start);
      if (begin < 0) continue;
      const finish = block.text.indexOf(end, begin + start.length);
      if (finish < 0 || block.text.indexOf(start, begin + start.length) >= 0 || block.text.indexOf(end, finish + end.length) >= 0)
        throw new Error('external_context_mismatch');
      const fragment = block.text.slice(begin, finish + end.length);
      if (Buffer.byteLength(fragment) > 33000 || sha256(fragment) !== expected.fragmentHash) throw new Error('external_context_mismatch');
      const stamp = TimestampSchema.safeParse(row.timestamp);
      if (!stamp.success || Date.parse(stamp.data) < Date.parse(parsed.data) || Date.parse(stamp.data) > Date.parse(at))
        throw new Error('external_context_mismatch');
      matches++;
    }
  }
  if (matches !== 1) throw new Error(matches ? 'external_context_mismatch' : 'external_context_unverified');
  return { nativeCreatedAt: new Date(parsed.data).toISOString(), fragmentHash: expected.fragmentHash };
}
