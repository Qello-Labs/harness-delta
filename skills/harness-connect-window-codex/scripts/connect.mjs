import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';

const id = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/;
const receipt =
	/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const validId = (value) => typeof value === "string" && id.test(value);
const reasons = new Set([
	"binding_window_activation_required",
	"binding_window_unavailable",
	"binding_version_out_of_window",
	"binding_ordinary_assignment_conflict",
	"binding_root_only_required",
	"binding_scope_revoked",
	"binding_receipt_stale",
	"binding_identity_mismatch",
	"binding_identity_unavailable",
	"binding_session_conflict",
	"binding_relation_invalid",
	"binding_request_conflict",
	"binding_source_changed",
	"binding_source_unavailable",
	"binding_source_unqualified",
	"binding_reconnect_required",
	"binding_provider_unavailable",
	"deleted_identifier",
	"ordinary_preparation_required",
	"ordinary_configuration_changed",
	"task_closed",
	"connection_not_available",
	"ui_state_changed",
	"ui_action_conflict",
]);
class ConnectError extends Error {
	constructor(code) {
		super(code);
		this.code = code;
	}
}
const fail = (code) => {
	throw new ConnectError(code);
};
const record = (value, keys) =>
	value !== null && typeof value === "object" && !Array.isArray(value) &&
	Object.keys(value).every((key) => keys.includes(key));
function localOrigin(value) {
	if (typeof value !== "string") fail("invalid_origin");
	let url;
	try {
		url = new URL(value);
	} catch {
		fail("invalid_origin");
	}
	if (
		url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port ||
		url.username || url.password ||
		url.pathname !== "/" || url.search || url.hash
	) fail("invalid_origin");
	return url.origin;
}
function taskView(value, options) {
	if (
		!record(value, ["csrf", "task"]) || typeof value.csrf !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.csrf)
	) {
		fail("unsupported_ui_contract");
	}
	const task = value.task;
	if (
		!record(task, [
			"schema_version",
			"kind",
			"project_id",
			"task_id",
			"version",
			"state",
			"connection_enabled",
			"reason",
			"selected_root_id",
		]) ||
		task.schema_version !== 1 || task.kind !== "codex_window_task" ||
		task.project_id !== options.project || task.task_id !== options.task ||
		typeof task.version !== "string" ||
		!/^"[a-f0-9]{64}"$/.test(task.version) ||
		!["registered", "active", "paused", "finalized"].includes(task.state) ||
		typeof task.connection_enabled !== "boolean" ||
		!(task.reason === null || reasons.has(task.reason)) ||
		!(task.selected_root_id === null || validId(task.selected_root_id))
	) fail("unsupported_ui_contract");
	if (task.connection_enabled && task.reason !== null) {
		fail("unsupported_ui_contract");
	}
	return { csrf: value.csrf, task };
}
function requireLive(task) {
	if (task.state !== "active") fail("task_closed");
	if (!task.connection_enabled) {
		fail(task.reason ?? "connection_not_available");
	}
}
function connectionResult(value, options) {
	if (
		!record(value, [
			"schema_version",
			"kind",
			"status",
			"project_id",
			"task_id",
			"session_id",
			"automatic_children",
			"collection_active",
			"evidence_mode",
			"trust",
			"cost_coverage",
		]) ||
		value.schema_version !== 1 ||
		value.kind !== "codex_window_connection" ||
		value.status !== "connected" ||
		value.project_id !== options.project ||
		value.task_id !== options.task || !validId(value.session_id) ||
		value.automatic_children !== false ||
		value.collection_active !== true ||
		value.evidence_mode !== "source_only" ||
		value.trust !== "compatibility_unverified" ||
		value.cost_coverage !== "partial"
	) {
		fail("connection_unverified");
	}
	return {
		schema_version: 1,
		kind: "codex_window_connection",
		status: "connected",
		project_id: value.project_id,
		task_id: value.task_id,
		session_id: value.session_id,
		automatic_children: false,
		collection_active: true,
		evidence_mode: "source_only",
		trust: "compatibility_unverified",
		cost_coverage: "partial",
	};
}
export async function run(operation, options, transport = fetch) {
	if (
		!record(options, ["origin", "product", "project", "task", "receipt"]) ||
		options.product !== "codex" ||
		!["inspect", "connect"].includes(operation) ||
		!validId(options.project) || !validId(options.task)
	) fail("invalid_input");
	if (
		options.receipt !== undefined &&
		(typeof options.receipt !== "string" || !receipt.test(options.receipt))
	) fail("invalid_input");
	if (operation === "connect" && options.receipt === undefined) {
		fail("invalid_input");
	}
	const origin = localOrigin(options.origin);
	const route = "/api/tasks/" + encodeURIComponent(options.task);
	const request = async (suffix, action) => {
		const method = action === undefined ? "GET" : "POST";
		const signal = AbortSignal.timeout(10000);
		let reply;
		let value;
		try {
			reply = await transport(origin + route + suffix, {
				method,
				redirect: "error",
				signal,
				headers: {
					Accept: "application/json",
					...(action === undefined ? {} : {
						"Content-Type": "application/json",
						Origin: origin,
						"X-Harness-CSRF": action.csrf,
						"Idempotency-Key": randomUUID(),
						"If-Match": action.version,
					}),
				},
				...(action === undefined
					? {}
					: {
						body: JSON.stringify({
							project_id: options.project,
							product: "codex",
							receipt: options.receipt,
						}),
					}),
			});
			value = await reply.json();
		} catch {
			fail(
				method === "POST"
					? "ui_action_uncertain"
					: "local_ui_unavailable",
			);
		}
		if (reply.redirected) fail("unsupported_ui_contract");
		if (!reply.ok) {
			fail(
				reasons.has(value?.error)
					? value.error
					: "local_ui_request_failed",
			);
		}
		return value;
	};
	const before = taskView(await request("/codex-window-v1"), options);
	if (operation === "inspect") {
		return {
			status:
				before.task.state === "active" && before.task.connection_enabled
					? "ready"
					: "blocked",
			project_id: options.project,
			task_id: options.task,
			automatic_children: false,
			reason_code: before.task.state !== "active"
				? "task_closed"
				: before.task.reason ?? (before.task.connection_enabled
					? null
					: "connection_not_available"),
		};
	}
	requireLive(before.task);
	const result = connectionResult(
		await request("/codex-window-connect-v1", {
			csrf: before.csrf,
			version: before.task.version,
		}),
		options,
	);
	const after = taskView(await request("/codex-window-v1"), options);
	requireLive(after.task);
	if (after.task.selected_root_id !== result.session_id) {
		fail("connection_unverified");
	}
	return result;
}
async function main() {
	try {
		const { values } = parseArgs({
			args: process.argv.slice(3),
			options: {
				origin: { type: "string" },
				project: { type: "string" },
				task: { type: "string" },
				receipt: { type: "string" },
				product: { type: "string" },
			},
			strict: true,
			allowPositionals: false,
		});
		process.stdout.write(
			JSON.stringify(
				await run(process.argv[2], {
					...values,
					product: values.product ?? "codex",
				}),
			) + "\n",
		);
	} catch (error) {
		process.stdout.write(
			JSON.stringify({
				status: "blocked",
				reason_code: error instanceof ConnectError
					? error.code
					: "invalid_input",
				verified: false,
			}) + "\n",
		);
		process.exitCode = 1;
	}
}
if (import.meta.main) await main();
