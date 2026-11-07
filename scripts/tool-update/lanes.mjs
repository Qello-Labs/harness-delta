import { z } from "zod";

export const routes = [
	"file",
	"codex_workflow",
	"claude_workflow",
	"codex_binding",
	"claude_binding",
];
export const operations = ["launch", "link", "collect", "restart", "resume"];
export const topologies = ["root", "root_direct_child", "bounded_family"];
// Imperative operation fences have no exported descriptor. Drift requires a fresh rule review.
export const scopeSourceDigests = Object.freeze({
	"src/codex-workflow-adapter.ts":
		"1b69d9d1ed067b25f509c9c8416a64197c7d505de42bda3e962f18065f541168",
	"src/claude-workflow-adapter.ts":
		"344a6483aba255249ae59a7f53e0f8937ed60c79ce3767b85df1c188f5928ac4",
	"src/session-binding-contract.ts":
		"c01de8b3c48c6a7db75247771031160a5f06745ad53c29323a658e9ef10e1454",
	"src/ordinary-session-binding.ts":
		"82292e9178147d0ecfbe22e25383da514b5b25ee63f43e93a4db5a11eec9722d",
	"src/session-binding-service.ts":
		"4b49f8e7dc1c4a7554493577bff35331d2b634d1c6d62e631722462c475c1176",
	"src/claude-workflow-versions.ts":
		"3a85ae4d57edd2897954502420e000d41fedcdf2b475e502c6453a50a8218937",
	"src/session-binding-codex.ts":
		"820730e96a6bac962231228a410704aa5028340fc7129a47957045f901d06930",
	"src/session-binding-claude.ts":
		"57652e3da5e4dfdb57708c2280662a8f24f37d9e08c6b3aea500afda2cea9185",
});
export const laneSchema = z.strictObject({
	product: z.enum(["codex", "claude_code"]),
	route: z.enum(routes),
	profile_id: z.string().max(128).regex(
		/^(?:codex-file-(?:legacy|checkpoint)-v1|claude-file-message-components-v1|codex-workflow-(?:own-response|direct-child)-v1|claude-workflow-(?:own-trace|direct-child)-v1|codex-binding-[0-9]{5,27}-direct-family-v1|claude-binding-(?:[0-9]{5,27}|[0-9]{1,9}-[0-9]{1,9}-[0-9]{1,9})-family-v1|(?:codex|claude)-binding-root-window-v1)$/,
	),
	operation: z.enum(operations),
	topology: z.enum(topologies),
});
export const laneKey = (row) =>
	[row.product, row.route, row.profile_id, row.operation, row.topology].join(
		":",
	);

export function sourceLanes(
	{
		windows,
		files,
		evidence,
		codexAdmissions,
		claudeAdmissions,
		ordinaryWindows = [],
	},
) {
	const profiles = new Map();
	const add = (product, route, profile_id) =>
		profiles.set(`${product}:${route}:${profile_id}`, {
			product,
			route,
			profile_id,
		});
	for (const row of windows) add(row.product, row.source, row.profile_id);
	for (const row of files) {
		add(
			row.product,
			"file",
			row.product === "codex"
				? `codex-file-${
					row.boundaryMode === "legacy" ? "legacy" : "checkpoint"
				}-v1`
				: "claude-file-message-components-v1",
		);
	}
	for (
		const row of evidence.filter((row) =>
			row.profile_id.includes("-workflow-")
		)
	) {
		add(
			row.product,
			row.product === "codex" ? "codex_workflow" : "claude_workflow",
			row.profile_id,
		);
	}
	for (const row of codexAdmissions) {
		add("codex", "codex_binding", row.profileId);
	}
	for (const row of claudeAdmissions) {
		add("claude_code", "claude_binding", row.profileId);
	}
	const lanes = [];
	for (const row of profiles.values()) {
		const binding = row.route.endsWith("_binding");
		const child = row.profile_id.includes("-direct-child-");
		const ops = row.route === "file"
			? ["collect", "restart"]
			: binding
			? ["link", "collect", "restart", "resume"]
			: row.route === "codex_workflow"
			? ["launch", "link", "collect", "resume"]
			: ["launch", "resume"];
		for (
			const topology of binding
				? ["root", "bounded_family"]
				: [child ? "root_direct_child" : "root"]
		) {
			for (const operation of ops) {
				lanes.push(laneSchema.parse({ ...row, topology, operation }));
			}
		}
	}
	for (const policy of ordinaryWindows) {
		for (const operation of policy.operations) {
			lanes.push(
				laneSchema.parse({
					product: policy.product,
					route: policy.source,
					profile_id: policy.policyId,
					operation,
					topology: "root",
				}),
			);
		}
	}
	return lanes.sort((a, b) => laneKey(a).localeCompare(laneKey(b), "en"));
}
