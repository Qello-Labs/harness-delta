import { z } from "zod";
import { assertWindowPins, requireCondition } from "./fixtures.mjs";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const windowExecutionPinsSchema = z.strictObject({
	kind: z.literal("ordinary_window_execution_pins"),
	schema_version: z.literal(1),
	pin_scheme_revision: z.literal("ordinary-window-execution-v1"),
	product: z.literal("codex"),
	policy_id: z.literal("codex-binding-root-window-v1"),
	policy_revision: z.literal("codex-ordinary-root-window-v1"),
	evidence_mode: z.literal("source_only"),
	execution_mode: z.enum(["source", "built"]),
	pins: z.strictObject({
		runtime: digest,
		source: digest,
		build: digest,
		instrument: digest,
		skill: digest,
		producer: digest,
		built_skill: digest,
		built_producer: digest,
		lockfile: digest,
		package: digest,
	}),
});

// A pin packet authenticates local input equality, not permission to execute or collect.
export function validateWindowExecutionPins(input) {
	const parsed = windowExecutionPinsSchema.safeParse(input);
	requireCondition(parsed.success, "approval_invalid");
	const packet = parsed.data;
	assertWindowPins(packet.pins, {
		product: packet.product,
		executionMode: packet.execution_mode,
	});
	return packet;
}
