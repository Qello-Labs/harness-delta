import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { hashFile, snapshotWindowPins } from "./fixtures.mjs";
import { revalidateNativeWindowInputs } from "./codex-window-native.mjs";
import {
	ownedWindowDirectory,
	planSchema,
	reserveSyntheticWindowEmission,
	WindowConformanceError,
	windowRequire,
	writeWindowEmissionControl,
} from "./codex-window-conformance.mjs";

const sha = z.string().regex(/^[0-9a-f]{64}$/);
const caseSchema = z.enum([
	"version_probe",
	"normal",
	"sigint",
	"flush",
	"source_receipt_loading",
	"correlation",
	"termination",
	"replacement",
]);
const absolute = z.string().max(4096).refine((path) =>
	isAbsolute(path) && resolve(path) === path && !path.includes("\0")
);
const consentSchema = z.strictObject({
	schema_version: z.literal(1),
	kind: z.literal("codex_window_b1_consent"),
	consent_id: z.uuid(),
	approval_reference: sha,
	issued_at: z.number().int().nonnegative(),
	expires_at: z.number().int().nonnegative(),
	intent_sha256: sha,
	case_id: caseSchema,
	case_root: absolute,
	product: z.literal("codex"),
	version: z.literal("0.167.0"),
	operation: z.literal("collect"),
	topology: z.literal("root"),
	pins: planSchema.shape.pins,
});
const intentSchema = z.strictObject({
	schema_version: z.literal(1),
	kind: z.literal("codex_window_disabled_intent"),
	authority: z.literal("none"),
	execution_enabled: z.literal(false),
	actual_qualification: z.literal(false),
	case_id: caseSchema,
	case_root: absolute,
	plan_digest: sha,
	plan: planSchema,
	owner_ms: z.number().int().min(10000).max(180000),
	cleanup_ms: z.literal(5000),
	audit_reserve_ms: z.literal(10000),
	containment_qualified: z.literal(false),
});
const capabilities = new WeakMap();
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

function samePins(expected, observed) {
	const parsed = planSchema.shape.pins.safeParse(observed);
	return parsed.success &&
		Object.keys(expected).every((name) =>
			expected[name] === parsed.data[name]
		);
}

export function verifyWindowConsent(input, context) {
	const parsed = consentSchema.safeParse(input);
	windowRequire(parsed.success, "consent_invalid");
	const packet = parsed.data;
	windowRequire(
		packet.issued_at <= context.now && packet.expires_at > context.now &&
			packet.expires_at - packet.issued_at <= 1200000,
		"consent_expired",
	);
	windowRequire(
		packet.intent_sha256 === context.intentSha256 &&
			packet.case_root === context.caseRoot &&
			packet.case_id === context.caseId &&
			samePins(packet.pins, context.pins),
		"consent_mismatch",
	);
	return packet;
}

function privateSnapshot(path) {
	let fd;
	try {
		windowRequire(
			isAbsolute(path) && resolve(path) === path,
			"consent_storage_invalid",
		);
		ownedWindowDirectory(dirname(path));
		const parent = lstatSync(dirname(path));
		fd = openSync(
			path,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
		const before = fstatSync(fd);
		windowRequire(
			before.isFile() && before.uid === process.getuid() &&
				before.nlink === 1 &&
				(before.mode & 0o777) === 0o600 && before.size <= 65536,
			"consent_storage_invalid",
		);
		const buffer = Buffer.alloc(65537);
		const size = readSync(fd, buffer, 0, buffer.length, 0);
		const after = fstatSync(fd);
		windowRequire(
			size === before.size && size <= 65536 &&
				["dev", "ino", "size", "mtimeMs", "ctimeMs"].every((key) =>
					before[key] === after[key]
				),
			"consent_storage_invalid",
		);
		const current = lstatSync(path);
		const currentParent = lstatSync(dirname(path));
		windowRequire(
			current.dev === before.dev && current.ino === before.ino &&
				currentParent.dev === parent.dev &&
				currentParent.ino === parent.ino,
			"consent_storage_invalid",
		);
		return {
			bytes: buffer.subarray(0, size),
			identity: [before.dev, before.ino, parent.dev, parent.ino].join(
				":",
			),
		};
	} catch (error) {
		if (error instanceof WindowConformanceError) throw error;
		throw new WindowConformanceError("consent_storage_invalid");
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function inside(root, path) {
	const distance = relative(root, path);
	return isAbsolute(path) && resolve(path) === path && distance !== "" &&
		distance !== ".." &&
		!distance.startsWith(`..${sep}`) && !isAbsolute(distance) &&
		realpathSync(path) === path;
}

export function snapshotWindowExecutorPins(intent) {
	const inputs = intent.plan.inputs;
	windowRequire(inputs, "input_preflight_unavailable");
	ownedWindowDirectory(inputs.batch_root);
	ownedWindowDirectory(inputs.prefix_root);
	windowRequire(
		inputs.prefix_root === join(inputs.batch_root, "prefix") &&
			intent.case_root ===
				join(inputs.batch_root, "cases", intent.case_id),
		"input_scope_invalid",
	);
	for (const key of ["native_path", "host_path"]) {
		windowRequire(
			inside(inputs.prefix_root, inputs[key]),
			"input_scope_invalid",
		);
	}
	for (const key of ["config_path", "environment_path"]) {
		windowRequire(
			inside(intent.case_root, inputs[key]),
			"input_scope_invalid",
		);
	}
	for (const key of ["profile_path", "quota_packet_path"]) {
		windowRequire(
			inside(inputs.batch_root, inputs[key]),
			"input_scope_invalid",
		);
	}
	windowRequire(lstatSync(inputs.host_path).size <= 134217728, "pin_drift");
	revalidateNativeWindowInputs(inputs, intent.case_root);
	const windowPins = snapshotWindowPins({
		product: "codex",
		executionMode: "source",
	});
	return {
		native: hashFile(inputs.native_path),
		host: hashFile(inputs.host_path),
		source: windowPins.source,
		build: windowPins.build,
		instrument: windowPins.instrument,
		runtime: windowPins.runtime,
		lockfile: windowPins.lockfile,
		config: hashFile(inputs.config_path),
		environment: hashFile(inputs.environment_path),
		egress: hashFile(inputs.profile_path),
		quota: hashFile(inputs.quota_packet_path),
	};
}

export function reserveWindowConsent(
	{ intentFile, consentFile, now = Date.now(), observedPins },
) {
	const intentSnapshot = privateSnapshot(intentFile);
	const intentBytes = intentSnapshot.bytes;
	let intent, packetInput;
	try {
		intent = intentSchema.parse(JSON.parse(intentBytes.toString("utf8")));
	} catch {
		throw new WindowConformanceError("consent_invalid");
	}
	const caseRoot = dirname(intentFile);
	windowRequire(
		intent.case_root === caseRoot && dirname(consentFile) === caseRoot,
		"consent_mismatch",
	);
	const consentSnapshot = privateSnapshot(consentFile);
	const consentBytes = consentSnapshot.bytes;
	try {
		packetInput = JSON.parse(consentBytes.toString("utf8"));
	} catch {
		throw new WindowConformanceError("consent_invalid");
	}
	const context = {
		intentSha256: hash(intentBytes),
		caseRoot,
		caseId: intent.case_id,
		pins: intent.plan.pins,
		now,
	};
	const packet = verifyWindowConsent(packetInput, context);
	let fd;
	try {
		fd = openSync(
			join(caseRoot, ".codex-window-launch-reservation.json"),
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
				constants.O_NOFOLLOW,
			0o600,
		);
	} catch (error) {
		if (error && error.code === "EEXIST") {
			throw new WindowConformanceError("consent_reused");
		}
		throw new WindowConformanceError("consent_storage_invalid");
	}
	try {
		writeFileSync(
			fd,
			JSON.stringify({
				intent_sha256: context.intentSha256,
				consent_id: packet.consent_id,
				consumed_at: now,
			}),
		);
	} finally {
		closeSync(fd);
	}
	const currentPins = observedPins ?? snapshotWindowExecutorPins(intent);
	windowRequire(samePins(packet.pins, currentPins), "pin_drift");
	const capability = Object.freeze({});
	const reservationFile = join(
		caseRoot,
		".codex-window-launch-reservation.json",
	);
	const reservationSnapshot = privateSnapshot(reservationFile);
	capabilities.set(capability, {
		intentFile,
		consentFile,
		intent,
		reservationFile,
		snapshots: [intentSnapshot, consentSnapshot, reservationSnapshot],
		packet,
		caseRoot,
		origin: observedPins ? "synthetic" : "local_verified_inputs",
	});
	return capability;
}

export function revalidateWindowConsent(capability, observedPins) {
	const state = capabilities.get(capability);
	windowRequire(state, "consent_invalid");
	windowRequire(Date.now() < state.packet.expires_at, "consent_expired");
	const files = [state.intentFile, state.consentFile, state.reservationFile];
	for (const [index, path] of files.entries()) {
		const current = privateSnapshot(path);
		const previous = state.snapshots[index];
		windowRequire(
			current.identity === previous.identity &&
				current.bytes.equals(previous.bytes),
			"consent_mismatch",
		);
	}
	const currentPins = state.origin === "synthetic"
		? observedPins
		: snapshotWindowExecutorPins(state.intent);
	windowRequire(samePins(state.packet.pins, currentPins), "pin_drift");
	return {
		caseRoot: state.caseRoot,
		expiresAt: state.packet.expires_at,
		origin: state.origin,
		authority: "none",
	};
}

export function writeConsentedWindowEmission(capability, observedPins) {
	const verified = revalidateWindowConsent(capability, observedPins);
	const state = capabilities.get(capability);
	windowRequire(state.packet.case_id !== "version_probe", "case_invalid");
	const projectRoot = join(verified.caseRoot, "project");
	const control = writeWindowEmissionControl(reserveSyntheticWindowEmission({
		root: verified.caseRoot,
		projectRoot,
		consent: {
			origin: "synthetic",
			case_id: "source_receipt_loading",
			project_root: projectRoot,
			expires_at: verified.expiresAt,
		},
	}));
	return Object.freeze({
		authority: "none",
		origin: verified.origin,
		actual_qualification: false,
		check() {
			try {
				revalidateWindowConsent(capability, observedPins);
				control.check();
			} catch (error) {
				control.close();
				throw error;
			}
		},
		close: control.close,
	});
}
