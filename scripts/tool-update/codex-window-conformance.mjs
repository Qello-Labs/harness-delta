#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	ftruncateSync,
	lstatSync,
	mkdirSync,
	opendirSync,
	openSync,
	readSync,
	realpathSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

export class WindowConformanceError extends Error {
	constructor(code) {
		super(code);
		this.code = code;
	}
}
export function windowRequire(condition, code) {
	if (!condition) throw new WindowConformanceError(code);
}

const owners = Object.freeze({
	version_probe: 10000,
	normal: 120000,
	sigint: 120000,
	flush: 120000,
	source_receipt_loading: 120000,
	correlation: 180000,
	termination: 120000,
	replacement: 120000,
});

export function createWindowBudget(start) {
	windowRequire(
		Number.isSafeInteger(start) && start >= 0 &&
			Number.isSafeInteger(start + 1200000),
		"clock_invalid",
	);
	const batchDeadline = start + 1200000;
	const reservations = new Set();
	let batchStopped = false;
	let active = false, cleanupVerified = false;
	let lastCase = null;
	return Object.freeze({
		reserve(caseId, now, consentExpiry) {
			windowRequire(!reservations.has(caseId), "reservation_reused");
			windowRequire(
				!batchStopped && lastCase !== "replacement",
				"batch_stopped",
			);
			windowRequire(!active, "case_active");
			windowRequire(Object.hasOwn(owners, caseId), "case_invalid");
			windowRequire(
				Number.isSafeInteger(now) && now >= start &&
					Number.isSafeInteger(consentExpiry) && consentExpiry > now,
				"clock_invalid",
			);
			if (now + owners[caseId] + 15000 > batchDeadline) {
				batchStopped = true;
				throw new WindowConformanceError("admission_reserve");
			}
			reservations.add(caseId);
			active = true;
			cleanupVerified = false;
			lastCase = caseId;
			let deadline = Math.min(
				now + owners[caseId],
				batchDeadline - 15000,
				consentExpiry,
			);
			let state = "running";
			let stoppedAt;
			let negativeArmed = false;
			return Object.freeze({
				get deadline() {
					return deadline;
				},
				remaining(at) {
					windowRequire(
						state === "running" && !batchStopped,
						"case_stopped",
					);
					windowRequire(
						Number.isSafeInteger(at) && at >= now,
						"clock_invalid",
					);
					if (at >= deadline) {
						batchStopped = true;
						throw new WindowConformanceError("deadline_exceeded");
					}
					return deadline - at;
				},
				bindTrialExpiry(expiry) {
					windowRequire(state === "running", "case_stopped");
					windowRequire(
						Number.isSafeInteger(expiry) && expiry <= deadline,
						"deadline_extension",
					);
					deadline = expiry;
				},
				scheduleNegative(token, barrier, at) {
					windowRequire(
						state === "running" && !negativeArmed &&
							caseId === "termination" &&
							token === "termination-control-eof" &&
							barrier === "request-start" && at >= now &&
							at < deadline,
						"fault_mismatch",
					);
					negativeArmed = true;
				},
				stop(at, reason = "normal") {
					windowRequire(
						state === "running" && at >= now,
						"case_stopped",
					);
					windowRequire(
						reason === "normal" ||
							(reason === "scheduled" && negativeArmed),
						"fault_mismatch",
					);
					stoppedAt = at;
					state = reason === "scheduled"
						? "case_revoked_control_closed"
						: "stopped";
					if (at > deadline || at + 5000 > batchDeadline - 10000) {
						batchStopped = true;
					}
				},
				loss(kind, at) {
					windowRequire(
						[
							"observer",
							"owner",
							"guardian",
							"containment",
							"suspension",
						].includes(kind) && at >= now,
						"loss_invalid",
					);
					batchStopped = true;
					state = "lost";
					stoppedAt = at;
				},
				verifyCleanup(at, proof) {
					const positive = stoppedAt !== undefined &&
						at >= stoppedAt && at <= stoppedAt + 5000 &&
						at <= batchDeadline - 10000 &&
						proof.identitiesGone === true &&
						proof.resourcesClosed === true &&
						proof.terminalRestored === true;
					if (!positive) {
						batchStopped = true;
						throw new WindowConformanceError("cleanup_unverified");
					}
					windowRequire(
						state === "stopped" ||
							state === "case_revoked_control_closed" ||
							state === "lost",
						"case_stopped",
					);
					state = state === "case_revoked_control_closed"
						? "case_complete_expected_negative"
						: "cleanup_verified";
					cleanupVerified = true;
					active = false;
				},
			});
		},
		auditDeadline(now, cleanupConsentExpiry) {
			windowRequire(cleanupVerified && !active, "cleanup_unverified");
			windowRequire(
				Number.isSafeInteger(now) &&
					Number.isSafeInteger(cleanupConsentExpiry) &&
					now >= start && now <= batchDeadline - 10000 &&
					cleanupConsentExpiry > now,
				"audit_deadline",
			);
			return Math.min(now + 10000, batchDeadline, cleanupConsentExpiry);
		},
	});
}

const sha = z.string().regex(/^[0-9a-f]{64}$/);
const pinNames = [
	"native",
	"host",
	"source",
	"build",
	"instrument",
	"runtime",
	"lockfile",
	"config",
	"environment",
	"egress",
	"quota",
];
export const planSchema = z.strictObject({
	schema_version: z.literal(1),
	product: z.literal("codex"),
	version: z.literal("0.167.0"),
	commit: z.literal("086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a"),
	route: z.literal("codex_binding"),
	policy_id: z.literal("codex-binding-root-window-v1"),
	operation: z.literal("collect"),
	topology: z.literal("root"),
	runtime: z.literal("node24"),
	platform: z.literal("darwin_arm64"),
	model: z.literal("gpt-6.1-sol"),
	effort: z.literal("high"),
	pins: z.strictObject(
		Object.fromEntries(pinNames.map((name) => [name, sha])),
	),
	inputs: z.strictObject({
		batch_root: z.string().max(4096),
		prefix_root: z.string().max(4096),
		native_path: z.string().max(4096),
		host_path: z.string().max(4096),
		config_path: z.string().max(4096),
		environment_path: z.string().max(4096),
		profile_path: z.string().max(4096),
		quota_packet_path: z.string().max(4096),
		native_manifest_path: z.string().max(4096),
		native_manifest_sha256: sha,
		native_manifest_identity: z.string().max(128).regex(
			/^\d+:\d+:\d+:\d+$/,
		),
	}).optional(),
});

export function ownedWindowDirectory(path) {
	windowRequire(
		typeof path === "string" && isAbsolute(path) &&
			resolve(path) === path && !path.includes("\0"),
		"owned_path_invalid",
	);
	const ancestors = [];
	for (let current = path;; current = dirname(current)) {
		ancestors.push(current);
		if (current === dirname(current)) break;
	}
	for (const current of ancestors.reverse()) {
		const stat = lstatSync(current);
		windowRequire(
			stat.isDirectory() && !stat.isSymbolicLink(),
			"owned_path_invalid",
		);
		if (current === path) {
			windowRequire(
				stat.uid === process.getuid() && (stat.mode & 0o777) === 0o700,
				"owned_mode_invalid",
			);
		}
	}
	windowRequire(realpathSync(path) === path, "owned_path_invalid");
	return path;
}

function privatePlan(path) {
	windowRequire(isAbsolute(path) && resolve(path) === path, "plan_invalid");
	ownedWindowDirectory(dirname(path));
	const fd = openSync(
		path,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const stat = fstatSync(fd);
		windowRequire(
			stat.isFile() && stat.uid === process.getuid() &&
				(stat.mode & 0o777) === 0o600 &&
				stat.size <= 16384 && stat.nlink === 1,
			"plan_invalid",
		);
		const buffer = Buffer.alloc(16385);
		const length = readSync(fd, buffer, 0, buffer.length, 0);
		windowRequire(
			length === stat.size && length <= 16384 &&
				fstatSync(fd).size === stat.size,
			"plan_invalid",
		);
		const bytes = buffer.subarray(0, length);
		const parsed = planSchema.safeParse(JSON.parse(bytes.toString("utf8")));
		windowRequire(parsed.success, "plan_invalid");
		return {
			plan: parsed.data,
			digest: createHash("sha256").update(bytes).digest("hex"),
		};
	} finally {
		closeSync(fd);
	}
}

const emissionReservations = new WeakMap();
const syntheticEmissionConsent = z.strictObject({
	origin: z.literal("synthetic"),
	case_id: z.literal("source_receipt_loading"),
	project_root: z.string().max(4096),
	expires_at: z.number().int().nonnegative(),
});

export function reserveSyntheticWindowEmission({ root, projectRoot, consent }) {
	const parsed = syntheticEmissionConsent.safeParse(consent);
	windowRequire(
		parsed.success && parsed.data.project_root === projectRoot &&
			parsed.data.expires_at > Date.now() &&
			parsed.data.expires_at - Date.now() <= 1200000,
		"consent_invalid",
	);
	ownedWindowDirectory(root);
	windowRequire(projectRoot === join(root, "project"), "owned_path_invalid");
	ownedWindowDirectory(projectRoot);
	const capability = Object.freeze({});
	emissionReservations.set(capability, {
		root,
		projectRoot,
		expiresAt: parsed.data.expires_at,
	});
	return capability;
}

function sameEmissionIdentity(expected, observed) {
	return ["dev", "ino", "mode", "uid", "gid"].every((key) =>
		expected[key] === observed[key]
	);
}

function revalidateEmissionStorage(storage) {
	try {
		for (const [path, expected] of storage.directories) {
			ownedWindowDirectory(path);
			windowRequire(
				sameEmissionIdentity(expected, lstatSync(path)),
				"receipt_storage_changed",
			);
		}
	} catch {
		throw new WindowConformanceError("receipt_storage_changed");
	}
	let fd;
	try {
		fd = openSync(
			storage.path,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
		const before = fstatSync(fd);
		windowRequire(
			before.isFile() && sameEmissionIdentity(storage.identity, before) &&
				before.nlink === 1 &&
				before.size === storage.bytes.length && before.size <= 4096,
			"control_storage_changed",
		);
		const buffer = Buffer.alloc(4097);
		const size = readSync(fd, buffer, 0, buffer.length, 0);
		const after = fstatSync(fd);
		windowRequire(
			size === storage.bytes.length &&
				buffer.subarray(0, size).equals(storage.bytes) &&
				sameEmissionIdentity(before, after) &&
				before.size === after.size &&
				sameEmissionIdentity(after, lstatSync(storage.path)),
			"control_storage_changed",
		);
	} catch {
		throw new WindowConformanceError("control_storage_changed");
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function emissionControlLifetime(storage, control, expiresAt) {
	let closed = false, failure, timer;
	const validate = () => {
		if (failure) throw failure;
		try {
			revalidateEmissionStorage(storage);
		} catch (error) {
			failure = error;
			clearTimeout(timer);
			if (!closed) closeSync(storage.fd);
			closed = true;
			throw error;
		}
	};
	const close = () => {
		validate();
		if (closed) return;
		closed = true;
		clearTimeout(timer);
		try {
			const inactive = Buffer.from(
				JSON.stringify({ ...control, state: "inactive" }),
			);
			writeSync(storage.fd, inactive, 0, inactive.length, 0);
			ftruncateSync(storage.fd, inactive.length);
			storage.bytes = inactive;
			storage.identity = fstatSync(storage.fd);
		} catch {
			failure = new WindowConformanceError("control_inactivation_failed");
			throw failure;
		} finally {
			closeSync(storage.fd);
		}
	};
	try {
		windowRequire(expiresAt > Date.now(), "consent_expired");
		timer = setTimeout(() => {
			try {
				close();
			} catch (error) {
				failure = error;
			}
		}, expiresAt - Date.now());
		timer.unref();
		return Object.freeze({
			authority: "none",
			origin: "synthetic",
			check() {
				validate();
				windowRequire(expiresAt > Date.now(), "consent_expired");
				windowRequire(!closed, "control_closed");
				const entries = opendirSync(storage.directory);
				let receipts = 0;
				try {
					validate();
					for (let entry; (entry = entries.readSync()) !== null;) {
						if (entry.name === "ordinary-window-control.json") {
							continue;
						}
						receipts += 1;
						if (receipts > 16) {
							close();
							throw new WindowConformanceError("receipt_limit");
						}
					}
				} finally {
					entries.closeSync();
				}
			},
			close,
		});
	} catch (error) {
		close();
		throw error;
	}
}

export function writeWindowEmissionControl(capability) {
	const reservation = emissionReservations.get(capability);
	windowRequire(reservation, "consent_invalid");
	emissionReservations.delete(capability);
	const { root, projectRoot, expiresAt } = reservation;
	windowRequire(expiresAt > Date.now(), "consent_expired");
	ownedWindowDirectory(root);
	ownedWindowDirectory(projectRoot);
	const metadata = join(projectRoot, ".harness-delta");
	mkdirSync(metadata, { mode: 0o700 });
	ownedWindowDirectory(metadata);
	const directory = join(metadata, "window-receipts");
	mkdirSync(directory, { mode: 0o700 });
	ownedWindowDirectory(directory);
	const control = {
		schemaVersion: 1,
		projectRoot,
		product: "codex",
		policyId: "codex-binding-root-window-v1",
		policyRevision: "codex-ordinary-root-window-v1",
		evidenceMode: "source_only",
		state: "active",
	};
	const bytes = Buffer.from(JSON.stringify(control));
	windowRequire(bytes.length <= 4096, "control_limit");
	const path = join(directory, "ordinary-window-control.json");
	const fd = openSync(
		path,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
			constants.O_NOFOLLOW,
		0o600,
	);
	try {
		writeFileSync(fd, bytes);
	} catch (error) {
		closeSync(fd);
		throw error;
	}
	return emissionControlLifetime(
		{
			fd,
			path,
			directory,
			directories: [root, projectRoot, metadata, directory].map((
				entry,
			) => [entry, lstatSync(entry)]),
			identity: fstatSync(fd),
			bytes,
		},
		control,
		expiresAt,
	);
}

export function prepareWindowCase({ planFile, caseId, out }) {
	windowRequire(Object.hasOwn(owners, caseId), "case_invalid");
	const { plan, digest } = privatePlan(planFile);
	ownedWindowDirectory(out);
	const contents = opendirSync(out);
	try {
		windowRequire(contents.readSync() === null, "case_not_fresh");
	} finally {
		contents.closeSync();
	}
	const intent = {
		schema_version: 1,
		kind: "codex_window_disabled_intent",
		authority: "none",
		execution_enabled: false,
		actual_qualification: false,
		case_id: caseId,
		case_root: out,
		plan_digest: digest,
		plan,
		owner_ms: owners[caseId],
		cleanup_ms: 5000,
		audit_reserve_ms: 10000,
		containment_qualified: false,
	};
	const fd = openSync(
		join(out, "intent.json"),
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
			constants.O_NOFOLLOW,
		0o600,
	);
	try {
		writeFileSync(fd, JSON.stringify(intent) + "\n");
	} finally {
		closeSync(fd);
	}
	return {
		status: "prepared_execution_disabled",
		authority: "none",
		actual_qualification: false,
	};
}

async function command(args) {
	if (args[0] === "execute") {
		throw new WindowConformanceError("b1_execution_disabled");
	}
	if (args[0] === "verify-cleanup") {
		windowRequire(
			args.length === 5 && args[1] === "--batch" &&
				args[3] === "--consent",
			"cleanup_consent_unavailable",
		);
		const { cleanupWindowBatch } = await import(
			"./codex-window-registry.mjs"
		);
		return cleanupWindowBatch({ batchRoot: args[2], consentFile: args[4] });
	}
	if (args[0] === "verify-consent") {
		windowRequire(
			args.length === 5 && args[1] === "--intent" &&
				args[3] === "--consent",
			"command_invalid",
		);
		const { reserveWindowConsent } = await import(
			"./codex-window-consent.mjs"
		);
		reserveWindowConsent({ intentFile: args[2], consentFile: args[4] });
		return {
			status: "reserved_execution_disabled",
			authority: "none",
			execution_attempted: false,
			actual_qualification: false,
		};
	}
	windowRequire(
		args[0] === "prepare" && args.length === 7,
		"command_invalid",
	);
	const flags = new Map();
	for (let index = 1; index < args.length; index += 2) {
		windowRequire(
			["--plan", "--case", "--out"].includes(args[index]) &&
				!flags.has(args[index]),
			"command_invalid",
		);
		flags.set(args[index], args[index + 1]);
	}
	return prepareWindowCase({
		planFile: flags.get("--plan"),
		caseId: flags.get("--case"),
		out: flags.get("--out"),
	});
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	command(process.argv.slice(2)).then((result) => {
		process.stdout.write(JSON.stringify(result) + "\n");
	}).catch((error) => {
		const code = error instanceof WindowConformanceError
			? error.code
			: "private_input_invalid";
		process.stdout.write(
			JSON.stringify({
				status: "refused",
				code,
				execution_attempted: false,
				actual_qualification: false,
			}) + "\n",
		);
		process.exitCode = 2;
	});
}
