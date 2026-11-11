import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	opendirSync,
	openSync,
	readSync,
	realpathSync,
	writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
	ownedWindowDirectory,
	WindowConformanceError,
	windowRequire,
} from "./codex-window-conformance.mjs";
import { runWindowTool } from "./codex-window-containment.mjs";
import { hashFile } from "./fixtures.mjs";

const maximumBytes = 1048576;
const registryName = ".codex-window-resources.jsonl";
const sha = z.string().regex(/^[0-9a-f]{64}$/);
const absolute = z.string().max(4096).refine((path) =>
	isAbsolute(path) && resolve(path) === path && !/[\0\r\n]/.test(path)
);
const caseId = z.enum([
	"version_probe",
	"normal",
	"sigint",
	"flush",
	"source_receipt_loading",
	"correlation",
	"termination",
	"replacement",
]);
const identity = z.strictObject({
	dev: z.number().int(),
	ino: z.number().int(),
	uid: z.number().int().nonnegative(),
});
const pidEntry = z.strictObject({
	kind: z.literal("pid"),
	pid: z.number().int().min(2),
	uid: z.number().int().nonnegative(),
	started: z.string().min(1).max(128),
});
const pathEntry = z.strictObject({
	kind: z.literal("path"),
	path: absolute,
	identity,
});
const imageEntry = z.strictObject({
	kind: z.literal("image"),
	path: absolute,
	identity,
	devices: z.array(z.string().regex(/^\/dev\/disk[0-9]+(?:s[0-9]+)*$/)).min(1)
		.max(16),
});
const entrySchema = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("header"),
		schema_version: z.literal(1),
		case_id: caseId,
		root: absolute,
		batch_started_continuous_ms: z.number().int().nonnegative(),
		identity,
	}),
	pidEntry,
	pathEntry,
	imageEntry,
	z.strictObject({ kind: z.literal("sealed") }),
]);
const lineSchema = z.strictObject({
	sequence: z.number().int().nonnegative(),
	previous: sha,
	entry: entrySchema,
	sha256: sha,
});
const referenceSchema = z.strictObject({
	schema_version: z.literal(1),
	case_id: caseId,
	case_root: absolute,
	batch_started_continuous_ms: z.number().int().nonnegative(),
	registry_path: absolute,
	identity,
	file_sha256: sha,
	head_sha256: sha,
	entries: z.number().int().min(2).max(258),
});
const cleanupSchema = z.strictObject({
	schema_version: z.literal(1),
	kind: z.literal("codex_window_cleanup_consent"),
	consent_id: z.uuid(),
	approval_reference: sha,
	issued_at: z.number().int().nonnegative(),
	expires_at: z.number().int().nonnegative(),
	batch_root: absolute,
	batch_started_continuous_ms: z.number().int().nonnegative(),
	batch_deadline_continuous_ms: z.number().int().nonnegative(),
	clock_native: z.strictObject({ path: absolute, sha256: sha }).optional(),
	registries: z.array(referenceSchema).min(1).max(8),
});
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const identify = (stat) => ({ dev: stat.dev, ino: stat.ino, uid: stat.uid });
const sameIdentity = (a, b) =>
	["dev", "ino", "uid"].every((key) => a[key] === b[key]);
const inside = (root, path) => {
	const distance = relative(root, path);
	return isAbsolute(path) && resolve(path) === path && distance !== "" &&
		distance !== ".." && !distance.startsWith(".." + sep) &&
		!isAbsolute(distance);
};

function snapshot(path, code = "registry_invalid") {
	let fd;
	try {
		ownedWindowDirectory(dirname(path));
		fd = openSync(
			path,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
		const before = fstatSync(fd);
		windowRequire(
			before.isFile() && before.nlink === 1 &&
				before.uid === process.getuid() &&
				(before.mode & 0o777) === 0o600 && before.size <= maximumBytes,
			code,
		);
		const bytes = Buffer.alloc(before.size + 1);
		const length = readSync(fd, bytes, 0, bytes.length, 0);
		const after = fstatSync(fd), current = lstatSync(path);
		windowRequire(
			length === before.size &&
				["dev", "ino", "size", "mtimeMs", "ctimeMs"].every((key) =>
					before[key] === after[key]
				) && sameIdentity(before, current),
			code,
		);
		return { bytes: bytes.subarray(0, length), identity: identify(before) };
	} catch (error) {
		if (error instanceof WindowConformanceError && error.code === code) {
			throw error;
		}
		throw new WindowConformanceError(code);
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function resourceIdentity(root, path) {
	try {
		windowRequire(
			inside(root, path) && realpathSync(path) === path &&
				path !== join(root, registryName),
			"resource_scope_invalid",
		);
		const stat = lstatSync(path);
		windowRequire(
			(stat.isDirectory() || stat.isFile()) && !stat.isSymbolicLink() &&
				stat.uid === process.getuid() &&
				(!stat.isFile() || stat.nlink === 1),
			"resource_scope_invalid",
		);
		return identify(stat);
	} catch (error) {
		if (error instanceof WindowConformanceError) throw error;
		throw new WindowConformanceError("resource_scope_invalid");
	}
}

export function createWindowResourceRegistry(
	{ root, caseId: inputCaseId, batchStartedMs },
) {
	ownedWindowDirectory(root);
	windowRequire(
		Number.isSafeInteger(batchStartedMs) && batchStartedMs >= 0 &&
			Number.isSafeInteger(batchStartedMs + 1200000),
		"clock_invalid",
	);
	const parsedCase = caseId.safeParse(inputCaseId);
	windowRequire(parsedCase.success, "case_invalid");
	const path = join(root, registryName);
	const fd = openSync(
		path,
		constants.O_RDWR | constants.O_APPEND | constants.O_CREAT |
			constants.O_EXCL | constants.O_NOFOLLOW,
		0o600,
	);
	const fileIdentity = identify(fstatSync(fd)),
		rootIdentity = identify(lstatSync(root));
	let bytes = Buffer.alloc(0),
		previous = "0".repeat(64),
		sequence = 0,
		closed = false;
	const append = (input) => {
		windowRequire(!closed && sequence < 258, "registry_invalid");
		try {
			const current = snapshot(path);
			windowRequire(
				sameIdentity(current.identity, fileIdentity) &&
					current.bytes.equals(bytes) &&
					sameIdentity(rootIdentity, lstatSync(root)),
				"registry_invalid",
			);
			const entry = entrySchema.parse(input);
			const record = {
				sequence,
				previous,
				entry,
				sha256: hash(JSON.stringify([sequence, previous, entry])),
			};
			const line = Buffer.from(JSON.stringify(record) + "\n");
			windowRequire(
				bytes.length + line.length <= maximumBytes &&
					writeSync(fd, line) === line.length,
				"registry_invalid",
			);
			fsyncSync(fd);
			bytes = Buffer.concat([bytes, line]);
			previous = record.sha256;
			sequence++;
		} catch (error) {
			closed = true;
			closeSync(fd);
			if (error instanceof WindowConformanceError) throw error;
			throw new WindowConformanceError("registry_invalid");
		}
	};
	append({
		kind: "header",
		schema_version: 1,
		case_id: parsedCase.data,
		root,
		batch_started_continuous_ms: batchStartedMs,
		identity: rootIdentity,
	});
	return Object.freeze({
		recordPid(input) {
			const parsed = pidEntry.safeParse({ kind: "pid", ...input });
			windowRequire(
				parsed.success && parsed.data.uid === process.getuid(),
				"resource_scope_invalid",
			);
			append(parsed.data);
		},
		recordPath(resourcePath) {
			append({
				kind: "path",
				path: resourcePath,
				identity: resourceIdentity(root, resourcePath),
			});
		},
		recordImage(input) {
			const parsed = imageEntry.safeParse({
				kind: "image",
				...input,
				identity: resourceIdentity(root, input.path),
			});
			windowRequire(parsed.success, "resource_scope_invalid");
			append(parsed.data);
		},
		seal() {
			append({ kind: "sealed" });
			closed = true;
			closeSync(fd);
			const current = snapshot(path);
			windowRequire(
				current.bytes.equals(bytes) &&
					sameIdentity(current.identity, fileIdentity),
				"registry_invalid",
			);
			return Object.freeze({
				schema_version: 1,
				case_id: parsedCase.data,
				case_root: root,
				batch_started_continuous_ms: batchStartedMs,
				registry_path: path,
				identity: Object.freeze(fileIdentity),
				file_sha256: hash(bytes),
				head_sha256: previous,
				entries: sequence,
			});
		},
		close() {
			if (!closed) {
				closed = true;
				closeSync(fd);
			}
		},
	});
}

function readRegistry(reference) {
	try {
		windowRequire(
			reference.registry_path === join(reference.case_root, registryName),
			"registry_invalid",
		);
		const current = snapshot(reference.registry_path);
		windowRequire(
			sameIdentity(current.identity, reference.identity) &&
				hash(current.bytes) === reference.file_sha256,
			"registry_invalid",
		);
		const text = current.bytes.toString("utf8");
		windowRequire(text.endsWith("\n"), "registry_invalid");
		const lines = text.slice(0, -1).split("\n");
		windowRequire(lines.length === reference.entries, "registry_invalid");
		let previous = "0".repeat(64);
		const entries = lines.map((line, sequence) => {
			const record = lineSchema.parse(JSON.parse(line));
			windowRequire(
				record.sequence === sequence && record.previous === previous &&
					record.sha256 ===
						hash(
							JSON.stringify([sequence, previous, record.entry]),
						),
				"registry_invalid",
			);
			previous = record.sha256;
			return record.entry;
		});
		const header = entries[0];
		windowRequire(
			header.batch_started_continuous_ms ===
				reference.batch_started_continuous_ms,
			"registry_invalid",
		);
		windowRequire(
			header.kind === "header" && header.case_id === reference.case_id &&
				header.root === reference.case_root &&
				sameIdentity(header.identity, lstatSync(reference.case_root)),
			"registry_invalid",
		);
		windowRequire(
			previous === reference.head_sha256 &&
				entries.at(-1).kind === "sealed",
			"registry_invalid",
		);
		const resources = entries.slice(1, -1);
		windowRequire(
			resources.every((entry) =>
				!["header", "sealed"].includes(entry.kind)
			),
			"registry_invalid",
		);
		return resources;
	} catch (error) {
		if (error instanceof WindowConformanceError) throw error;
		throw new WindowConformanceError("registry_invalid");
	}
}

function pathAbsent(path) {
	try {
		lstatSync(path);
		return false;
	} catch (error) {
		if (error?.code === "ENOENT") return true;
		throw new WindowConformanceError("cleanup_unverified");
	}
}

function pidAbsent(pid) {
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		if (error?.code === "ESRCH") return true;
		if (error?.code === "EPERM") return false;
		throw new WindowConformanceError("cleanup_unverified");
	}
}

async function attachedImages() {
	const result = await runWindowTool("/usr/bin/hdiutil", ["info", "-plist"], {
		timeoutMs: 2000,
	});
	windowRequire(result.code === 0, "cleanup_unverified");
	const converted = await runWindowTool("/usr/bin/plutil", [
		"-convert",
		"json",
		"-o",
		"-",
		"-",
	], { input: result.stdout, timeoutMs: 2000 });
	windowRequire(converted.code === 0, "cleanup_unverified");
	const parsed = z.object({
		images: z.array(z.object({ "image-path": absolute })).max(64),
	}).safeParse(JSON.parse(converted.stdout));
	windowRequire(parsed.success, "cleanup_unverified");
	return parsed.data.images.map((image) => image["image-path"]);
}

export async function verifyWindowResourceRegistry(input, options = {}) {
	const parsed = referenceSchema.safeParse(input);
	windowRequire(parsed.success, "registry_invalid");
	const reference = parsed.data;
	const resources = readRegistry(reference);
	for (const entry of resources) {
		await options.checkDeadline?.();
		switch (entry.kind) {
			case "pid":
				windowRequire(
					entry.uid === process.getuid() && pidAbsent(entry.pid),
					"cleanup_unverified",
				);
				break;
			case "path":
				windowRequire(
					inside(reference.case_root, entry.path) &&
						pathAbsent(entry.path),
					"cleanup_unverified",
				);
				break;
			case "image":
				windowRequire(
					inside(reference.case_root, entry.path) &&
						pathAbsent(entry.path) &&
						entry.devices.every(pathAbsent),
					"cleanup_unverified",
				);
				windowRequire(
					!(await (options.attachedImages ?? attachedImages)())
						.includes(entry.path),
					"cleanup_unverified",
				);
				break;
		}
	}
	readRegistry(reference);
	await options.checkDeadline?.();
	return { closedResources: resources.length, caseId: reference.case_id };
}

function verifyBatchRegistryInventory(batchRoot, references) {
	const casesRoot = join(batchRoot, "cases");
	ownedWindowDirectory(casesRoot);
	const directory = opendirSync(casesRoot);
	let entry, count = 0;
	try {
		while ((entry = directory.readSync())) {
			count++;
			windowRequire(
				count <= 8 && caseId.safeParse(entry.name).success &&
					entry.isDirectory(),
				"registry_invalid",
			);
			const root = join(casesRoot, entry.name);
			ownedWindowDirectory(root);
			const consumed = !pathAbsent(join(root, registryName)) ||
				!pathAbsent(
					join(root, ".codex-window-launch-reservation.json"),
				);
			windowRequire(
				!consumed || references.some((reference) =>
					reference.case_id === entry.name
				),
				"registry_invalid",
			);
		}
	} finally {
		directory.closeSync();
	}
}

function cleanupClockIdentity(batchRoot, reference) {
	windowRequire(
		reference &&
			reference.path === join(batchRoot, "guards", "codex-window-guard"),
		"clock_unavailable",
	);
	ownedWindowDirectory(dirname(reference.path));
	const stat = lstatSync(reference.path);
	windowRequire(
		stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 &&
			stat.uid === process.getuid() && stat.size <= maximumBytes &&
			(stat.mode & 0o022) === 0 && (stat.mode & 0o100) !== 0 &&
			realpathSync(reference.path) === reference.path &&
			hashFile(reference.path) === reference.sha256,
		"clock_unavailable",
	);
	return identify(stat);
}

export async function cleanupWindowBatch({ batchRoot, consentFile }) {
	let clock, initialIdentity;
	const continuousNow = async (reference) => {
		const current = cleanupClockIdentity(batchRoot, reference);
		if (!clock) {
			initialIdentity = current;
			const { createWindowClock } = await import(
				"./codex-window-clock.mjs"
			);
			clock = createWindowClock({
				nativePath: reference.path,
				env: {
					PATH: "/usr/bin:/bin",
					HOME: batchRoot,
					TMPDIR: batchRoot,
					LC_ALL: "C",
					TZ: "UTC",
				},
			});
			await clock.ready;
		}
		windowRequire(
			sameIdentity(current, initialIdentity),
			"clock_unavailable",
		);
		const value = Number(await clock.clock() / 1000000n);
		windowRequire(
			Number.isSafeInteger(value) && value >= 0,
			"clock_unavailable",
		);
		return value;
	};
	try {
		return await verifyWindowCleanup({
			batchRoot,
			consentFile,
			continuousNow,
		});
	} finally {
		if (clock) {
			const result = await clock.stop();
			windowRequire(!result.failed, "clock_unavailable");
		}
	}
}

export async function verifyWindowCleanup(
	{ batchRoot, consentFile, now = Date.now, continuousNow },
) {
	ownedWindowDirectory(batchRoot);
	windowRequire(
		consentFile === join(batchRoot, "cleanup-consent.json"),
		"cleanup_consent_invalid",
	);
	const original = snapshot(consentFile, "cleanup_consent_invalid");
	let parsed;
	try {
		parsed = cleanupSchema.safeParse(
			JSON.parse(original.bytes.toString("utf8")),
		);
	} catch {
		throw new WindowConformanceError("cleanup_consent_invalid");
	}
	windowRequire(parsed.success, "cleanup_consent_invalid");
	const packet = parsed.data, utc = now();
	windowRequire(
		packet.batch_root === batchRoot && packet.issued_at <= utc &&
			utc < packet.expires_at &&
			packet.expires_at - packet.issued_at <= 1200000,
		"cleanup_consent_invalid",
	);
	windowRequire(
		new Set(packet.registries.map((reference) => reference.case_id))
					.size === packet.registries.length &&
			packet.registries.every((reference) =>
				reference.case_root ===
					join(batchRoot, "cases", reference.case_id)
			),
		"cleanup_consent_invalid",
	);
	windowRequire(typeof continuousNow === "function", "clock_unavailable");
	windowRequire(
		packet.batch_deadline_continuous_ms ===
				packet.batch_started_continuous_ms + 1200000 &&
			packet.registries.every((reference) =>
				reference.batch_started_continuous_ms ===
					packet.batch_started_continuous_ms
			),
		"cleanup_consent_invalid",
	);
	const started = await continuousNow(packet.clock_native);
	windowRequire(
		started <= packet.batch_deadline_continuous_ms - 10000,
		"audit_deadline",
	);
	const deadline = Math.min(
		started + 10000,
		packet.batch_deadline_continuous_ms,
		started + packet.expires_at - utc,
	);
	const checkDeadline = async () => {
		windowRequire(
			now() < packet.expires_at &&
				await continuousNow(packet.clock_native) <= deadline,
			"audit_deadline",
		);
		const current = snapshot(consentFile, "cleanup_consent_invalid");
		windowRequire(
			sameIdentity(current.identity, original.identity) &&
				current.bytes.equals(original.bytes),
			"cleanup_consent_invalid",
		);
		verifyBatchRegistryInventory(batchRoot, packet.registries);
	};
	let closedResources = 0;
	for (const reference of packet.registries) {
		await checkDeadline();
		const result = await verifyWindowResourceRegistry(reference, {
			checkDeadline,
		});
		closedResources += result.closedResources;
	}
	await checkDeadline();
	return {
		status: "cleanup_verified",
		registries: packet.registries.length,
		closed_resources: closedResources,
		execution_attempted: false,
		actual_qualification: false,
	};
}
