import { fork } from "node:child_process";
import { existsSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { windowImageIdentity } from "./codex-window-containment.mjs";
import {
	ownedWindowDirectory,
	WindowConformanceError,
	windowRequire,
} from "./codex-window-conformance.mjs";
import {
	createOwnedWindowQuota,
	windowCaseQuotaBytes,
} from "./codex-window-quota.mjs";

const script = fileURLToPath(import.meta.url);
const identitySchema = z.strictObject({
	root_dev: z.number().int(),
	root_ino: z.number().int(),
	image_dev: z.number().int(),
	image_ino: z.number().int(),
});
const evidenceSchema = z.object({
	identity: identitySchema,
	quotaBytes: z.literal(windowCaseQuotaBytes),
	caseIdentity: z.object({
		dev: z.number().int(),
		ino: z.number().int(),
		uid: z.number().int(),
		mode: z.literal(448),
	}),
	container: z.object({
		ContainerReference: z.string().regex(/^disk[0-9]+$/),
		APFSContainerUUID: z.string(),
		CapacityCeiling: z.number().int().positive().max(4294967296),
		Volumes: z.array(z.object({
			Name: z.string(),
			APFSVolumeUUID: z.string(),
			CapacityQuota: z.number().int(),
			DeviceIdentifier: z.string().regex(/^disk[0-9]+(?:s[0-9]+)*$/),
		})).length(2),
	}),
	capacityBytes: z.number().int().positive().max(4294967296),
	entities: z.array(z.object({
		"dev-entry": z.string().regex(/^\/dev\/disk[0-9]+(?:s[0-9]+)*$/),
		"mount-point": z.string().optional(),
	})).min(1).max(16),
	writablePaths: z.array(z.string()).min(1).max(64),
});
const cleanupSchema = z.strictObject({
	detached: z.literal(true),
	ownedImageDeleted: z.literal(true),
	identity: identitySchema,
});
const responseSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("created"), record: identitySchema }),
	z.strictObject({ kind: z.literal("mounted"), evidence: evidenceSchema }),
	z.strictObject({
		kind: z.literal("verified"),
		id: z.number().int(),
		evidence: evidenceSchema,
	}),
	z.strictObject({
		kind: z.literal("closed"),
		cleanup: cleanupSchema.nullable(),
		failure: z.string().nullable(),
	}),
]);
const requestSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("authorize-attach") }),
	z.strictObject({ kind: z.literal("stop") }),
	z.strictObject({
		kind: z.literal("verify"),
		id: z.number().int(),
		paths: z.array(z.string()).min(1).max(64),
	}),
]);
const sameIdentity = (a, b) => Object.keys(a).every((key) => a[key] === b[key]);
const failureCode = (error) =>
	error instanceof WindowConformanceError ? error.code : "quota_owner_failed";

function saveReceipt(root, name, packet) {
	const pending = join(root, name + ".pending");
	writeFileSync(pending, JSON.stringify(packet, null, 2) + "\n", {
		flag: "wx",
		mode: 0o600,
	});
	renameSync(pending, join(root, name + ".json"));
}

function send(port, message) {
	if (!port.connected) return Promise.resolve();
	return new Promise((sent, reject) =>
		port.send(message, (error) => error ? reject(error) : sent())
	);
}

// The owner holds the quota object: coordinator EOF never discards the detach authority.
export async function ownWindowQuota(root, port = process, options = {}) {
	ownedWindowDirectory(root);
	const attach = Promise.withResolvers();
	const stop = Promise.withResolvers();
	let stopping = false, quota, mounted, cleanup = null, failure = null;
	let work = Promise.resolve();
	const lost = () => {
		stopping = true;
		attach.resolve();
		stop.resolve();
	};
	const message = (input) => {
		const parsed = requestSchema.safeParse(input);
		if (!parsed.success) {
			failure = "quota_owner_protocol";
			lost();
			return;
		}
		const request = parsed.data;
		switch (request.kind) {
			case "authorize-attach":
				attach.resolve();
				break;
			case "stop":
				lost();
				break;
			case "verify":
				work = work.then(async () => {
					windowRequire(
						quota && !stopping,
						"quota_owner_unavailable",
					);
					const evidence = await quota.verifyWritablePaths(
						request.paths,
					);
					await send(port, {
						kind: "verified",
						id: request.id,
						evidence,
					});
				}).catch((error) => {
					failure = failureCode(error);
					lost();
				});
				break;
		}
	};
	port.once("disconnect", lost);
	port.once("SIGTERM", lost);
	port.once("SIGINT", lost);
	port.on("message", message);
	const timer = setTimeout(lost, 180000);
	try {
		quota = await createOwnedWindowQuota(root, {
			...options,
			async onCreated(record) {
				await send(port, { kind: "created", record });
				await attach.promise;
				windowRequire(!stopping && port.connected, "quota_owner_lost");
			},
		});
		windowRequire(!stopping, "quota_owner_lost");
		mounted = await quota.verifyWritablePaths([quota.caseRoot]);
		saveReceipt(root, "quota-owner-mounted", {
			owner_pid: process.pid,
			coordinator_pid: process.ppid,
			image_path: quota.imagePath,
			case_root: quota.caseRoot,
			evidence: mounted,
			actual_target_qualified: false,
		});
		await send(port, { kind: "mounted", evidence: mounted });
		await stop.promise;
	} catch (error) {
		failure ??= failureCode(error);
	} finally {
		clearTimeout(timer);
		await work;
		try {
			if (quota) cleanup = await quota.close();
		} catch (error) {
			failure ??= failureCode(error);
		}
		const receipt = {
			owner_pid: process.pid,
			cleanup,
			failure,
			mounted: mounted ?? null,
			actual_target_qualified: false,
			limitations: [
				"interrupted_initialization_not_universally_covered",
				"loss_of_all_cleanup_owners_not_covered",
			],
		};
		try {
			saveReceipt(root, "quota-owner-cleanup", receipt);
			await send(port, { kind: "closed", cleanup, failure });
		} finally {
			port.removeListener("disconnect", lost);
			port.removeListener("SIGTERM", lost);
			port.removeListener("SIGINT", lost);
			port.removeListener("message", message);
			if (port.connected) port.disconnect();
		}
	}
	return { cleanup, failure };
}

function launchQuotaOwner(root, launch) {
	const opensslConf = join(root, "quota-owner-openssl.cnf");
	writeFileSync(opensslConf, "", { flag: "wx", mode: 0o600 });
	return launch ? launch(root) : fork(script, ["own-quota", root], {
		cwd: root,
		execPath: realpathSync(process.execPath),
		execArgv: [],
		env: {
			PATH: "/usr/bin:/bin",
			HOME: root,
			TMPDIR: root,
			LC_ALL: "C",
			TZ: "UTC",
			OPENSSL_CONF: opensslConf,
		},
		stdio: ["ignore", "ignore", "ignore", "ipc"],
	});
}

export function createWindowQuotaGuardian(root, options = {}) {
	ownedWindowDirectory(root);
	const ready = Promise.withResolvers();
	const closed = Promise.withResolvers();
	const pending = new Map();
	let child,
		identity,
		mounted,
		receipt,
		failure,
		timer,
		closing = false,
		sequence = 0;
	const fail = (code) => {
		failure ??= code;
		ready.reject(new WindowConformanceError(code));
		for (const request of pending.values()) {
			request.reject(new WindowConformanceError(code));
		}
		pending.clear();
		if (child?.connected) child.send({ kind: "stop" });
	};
	const onMessage = (input) => {
		const parsed = responseSchema.safeParse(input);
		if (!parsed.success) return fail("quota_owner_protocol");
		const message = parsed.data;
		try {
			switch (message.kind) {
				case "created":
					windowRequire(
						!identity && !closing,
						"quota_owner_protocol",
					);
					identity = windowImageIdentity(root);
					windowRequire(
						sameIdentity(identity, message.record),
						"quota_ownership_unverified",
					);
					child.send({ kind: "authorize-attach" });
					break;
				case "mounted":
					windowRequire(
						identity && !mounted && !closing,
						"quota_owner_protocol",
					);
					windowRequire(
						sameIdentity(identity, message.evidence.identity),
						"quota_ownership_unverified",
					);
					mounted = message.evidence;
					ready.resolve();
					break;
				case "verified": {
					windowRequire(
						identity &&
							sameIdentity(identity, message.evidence.identity),
						"quota_ownership_unverified",
					);
					const request = pending.get(message.id);
					windowRequire(request, "quota_owner_protocol");
					pending.delete(message.id);
					request.resolve(message.evidence);
					break;
				}
				case "closed":
					windowRequire(
						identity && message.cleanup &&
							sameIdentity(identity, message.cleanup.identity),
						"quota_cleanup_unverified",
					);
					windowRequire(
						!existsSync(join(root, "volume.sparseimage")),
						"quota_cleanup_unverified",
					);
					receipt = message.cleanup;
					failure ??= message.failure;
					break;
			}
		} catch (error) {
			fail(failureCode(error));
		}
	};
	const close = async () => {
		if (!child) return null;
		closing = true;
		if (child.connected) child.send({ kind: "stop" });
		const result = await closed.promise;
		windowRequire(
			result.cleanup && !result.failure,
			result.failure ?? "quota_cleanup_unverified",
		);
		return result.cleanup;
	};
	return Object.freeze({
		get owner() {
			return child;
		},
		closed: closed.promise,
		async start() {
			windowRequire(!child, "reservation_reused");
			child = launchQuotaOwner(root, options.launch);
			child.on("message", onMessage);
			child.once("error", () => fail("quota_owner_unavailable"));
			child.once("exit", () => {
				clearTimeout(timer);
				if (!receipt) fail("quota_cleanup_unverified");
				if (!mounted) {
					ready.reject(
						new WindowConformanceError(
							failure ?? "quota_owner_unavailable",
						),
					);
				}
				for (const request of pending.values()) {
					request.reject(
						new WindowConformanceError("quota_owner_unavailable"),
					);
				}
				pending.clear();
				closed.resolve({
					cleanup: receipt ?? null,
					failure: failure ?? null,
				});
			});
			timer = setTimeout(() => {
				fail("quota_owner_deadline");
				closed.resolve({ cleanup: null, failure });
			}, 210000);
			await ready.promise;
			return {
				imagePath: join(root, "volume.sparseimage"),
				caseRoot: join(root, "mounts", "HarnessQuotaState", "private"),
				verifyWritablePaths: async (paths) => {
					windowRequire(
						!closing && child.connected,
						"quota_owner_unavailable",
					);
					const id = ++sequence;
					const request = Promise.withResolvers();
					pending.set(id, request);
					child.send({ kind: "verify", id, paths });
					return request.promise;
				},
				close,
			};
		},
		close,
	});
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	if (
		process.argv.length === 4 && process.argv[2] === "own-quota" &&
		process.send
	) {
		try {
			const result = await ownWindowQuota(process.argv[3]);
			if (result.failure || !result.cleanup) process.exitCode = 2;
		} catch {
			process.exitCode = 2;
		}
	} else process.exitCode = 2;
}
