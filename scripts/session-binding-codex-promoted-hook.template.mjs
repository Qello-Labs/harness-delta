#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	opendirSync,
	openSync,
	readSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

const product = "__PROMOTED_PRODUCT__";
const producerContract = "promoted-payload-v1";
const invalid = () => {
	throw new Error("promoted_hook_metadata_unavailable");
};
const hint = (value) =>
	typeof value === "string" && value.length > 0 && value.length <= 4096 &&
	!/[\0\r\n]/.test(value);
const id = (value) =>
	typeof value === "string" &&
	/^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(value);
const privateOwned = (stat) =>
	stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0;

async function configuration() {
	const args = process.argv.slice(2);
	let directory;
	let projectRoot;
	let productVersion;
	if (product === "claude_code" && args.length === 0) {
		await import("./claude-promoted-connect-config.mjs");
		directory = process.env.HARNESS_DELTA_PROMOTED_RECEIPT_DIR;
		projectRoot = process.env.HARNESS_DELTA_PROMOTED_PROJECT_ROOT;
		productVersion = process.env.HARNESS_DELTA_PROMOTED_PRODUCT_VERSION;
	} else {
		if (args.length !== 6) invalid();
		const values = new Map();
		for (let index = 0; index < args.length; index += 2) {
			if (
				!["--receipt-directory", "--project-root", "--product-version"]
					.includes(args[index]) || values.has(args[index])
			) invalid();
			values.set(args[index], args[index + 1]);
		}
		directory = values.get("--receipt-directory");
		projectRoot = values.get("--project-root");
		productVersion = values.get("--product-version");
	}
	if (
		!hint(projectRoot) ||
		!isAbsolute(projectRoot) ||
		resolve(projectRoot) !== projectRoot ||
		!hint(directory) ||
		directory !==
			join(
				projectRoot,
				".harness-delta",
				product === "codex"
					? "codex-promoted-receipts"
					: "claude-promoted-receipts",
			) ||
		typeof productVersion !== "string" ||
		!/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(
			productVersion,
		)
	) {
		invalid();
	}
	return { directory, projectRoot, productVersion };
}
function ownedStorage({ directory, projectRoot }) {
	const ancestors = [];
	for (let current = directory;; current = dirname(current)) {
		ancestors.push(current);
		if (current === dirname(current)) break;
	}
	// Validate ancestors before descending so control access cannot traverse a symlink.
	for (const current of ancestors.reverse()) {
		const stat = lstatSync(current);
		if (!stat.isDirectory() || stat.isSymbolicLink()) invalid();
		if (
			(current === directory || current === dirname(directory)) &&
			!privateOwned(stat)
		) invalid();
		if (
			current === projectRoot &&
			(stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0)
		) invalid();
	}
}
function activeControl(config) {
	ownedStorage(config);
	let fd;
	try {
		fd = openSync(
			join(config.directory, "promotion-control.json"),
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
	} catch (error) {
		if (
			error instanceof Error && "code" in error && error.code === "ENOENT"
		) return false;
		throw error;
	}
	try {
		const stat = fstatSync(fd);
		if (
			!stat.isFile() || !privateOwned(stat) || stat.nlink !== 1 ||
			stat.size > 4096
		) invalid();
		const buffer = Buffer.alloc(4097);
		const size = readSync(fd, buffer, 0, buffer.length, 0);
		if (size > 4096) invalid();
		const control = JSON.parse(buffer.subarray(0, size).toString("utf8"));
		const expected = {
			schemaVersion: 1,
			producerContract,
			projectRoot: config.projectRoot,
			product,
			productVersion: config.productVersion,
			state: "active",
		};
		return (
			control !== null &&
			typeof control === "object" &&
			!Array.isArray(control) &&
			Object.keys(control).length === Object.keys(expected).length &&
			Object.entries(expected).every(([key, value]) =>
				control[key] === value
			)
		);
	} finally {
		closeSync(fd);
	}
}
function metadata(input, config) {
	if (
		input === null || typeof input !== "object" || Array.isArray(input) ||
		!id(input.session_id) || !hint(input.cwd)
	) invalid();
	let event;
	switch (input.hook_event_name) {
		case "SessionStart":
			event = "connect";
			break;
		case "SubagentStart":
			event = "subagent_start";
			break;
		case "SubagentStop":
			event = "subagent_stop";
			break;
		default:
			invalid();
	}
	if (
		(input.agent_id != null && !id(input.agent_id)) ||
		(input.transcript_path != null && !hint(input.transcript_path))
	) invalid();
	if (event === "connect" && input.agent_id != null) invalid();
	const pid = input.process_id ?? input.pid;
	if (pid != null && (!Number.isSafeInteger(pid) || pid <= 0)) invalid();
	// These are local payload hints, not canonical identity or collection authority.
	return {
		schemaVersion: 3,
		kind: "promotion_pending",
		producerContract,
		receipt: randomUUID(),
		product,
		productVersion: config.productVersion,
		event,
		nativeSessionId: input.session_id,
		nativeRootSessionId: input.session_id,
		agentId: input.agent_id ?? null,
		sourceRef: input.transcript_path ?? null,
		cwd: input.cwd,
		processIdHint: pid ?? null,
		recordedAt: new Date().toISOString(),
	};
}
async function payload(config) {
	let bytes = 0;
	const chunks = [];
	const timer = setTimeout(
		() =>
			process.stdin.destroy(
				new Error("promoted_hook_metadata_unavailable"),
			),
		2000,
	);
	try {
		for await (const chunk of process.stdin) {
			bytes += chunk.length;
			if (bytes > 65536) invalid();
			chunks.push(chunk);
		}
	} finally {
		clearTimeout(timer);
	}
	return metadata(JSON.parse(Buffer.concat(chunks).toString("utf8")), config);
}
function emit(directory, record) {
	const entries = opendirSync(directory);
	try {
		let count = 0;
		while (entries.readSync() !== null) {
			count += 1;
			if (count >= 1024) invalid();
		}
	} finally {
		entries.closeSync();
	}
	const serialized = JSON.stringify(record);
	if (Buffer.byteLength(serialized) > 16384) invalid();
	const fd = openSync(
		join(directory, `${record.receipt}.json`),
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
			constants.O_NOFOLLOW,
		0o600,
	);
	try {
		writeFileSync(fd, serialized);
	} finally {
		closeSync(fd);
	}
	const hookEventName = {
		connect: "SessionStart",
		subagent_start: "SubagentStart",
		subagent_stop: "SubagentStop",
	}[record.event];
	process.stdout.write(
		JSON.stringify({
			hookSpecificOutput: {
				hookEventName,
				additionalContext:
					`Harness Delta pending promotion receipt: ${record.receipt}`,
			},
		}) + "\n",
	);
}
try {
	const config = await configuration();
	if (activeControl(config)) {
		const record = await payload(config);
		// A control only gates pending emission, including after asynchronous input.
		if (activeControl(config)) emit(config.directory, record);
	}
} catch {
	process.stderr.write("promoted_hook_metadata_unavailable\n");
	process.exitCode = 1;
}
