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
	windowOverheadBytes,
} from "./codex-window-quota.mjs";
import { createWindowStartupJournal } from "./codex-window-startup-journal.mjs";
import { recoverWindowQuota } from "./codex-window-quota-recovery.mjs";

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
		})).length(3),
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
const journalSchema = z.strictObject({
	path: z.string(),
	head: z.string().regex(/^[a-f0-9]{64}$/),
	entries: z.number().int().positive(),
});
const overheadSchema = z.strictObject({
	limitBytes: z.literal(windowOverheadBytes),
	chargedBytes: z.number().int().nonnegative().max(windowOverheadBytes),
	guardBytes: z.number().int().nonnegative(),
	imageAllocatedBytes: z.number().int().nonnegative(),
	mountMetadataBytes: z.number().int().nonnegative(),
	accounting: z.literal("allocated_guard_and_whole_image_upper_bound"),
});
const responseSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("owner-ready") }),
	z.strictObject({ kind: z.literal("loss"), code: z.string().max(128) }),
	z.strictObject({ kind: z.literal("created"), record: identitySchema }),
	z.strictObject({
		kind: z.literal("mounted"),
		evidence: evidenceSchema,
		journal: journalSchema,
	}),
	z.strictObject({
		kind: z.literal("verified"),
		id: z.number().int(),
		evidence: evidenceSchema,
	}),
	z.strictObject({
		kind: z.literal("closed"),
		cleanup: cleanupSchema.nullable(),
		failure: z.string().nullable(),
		journal: journalSchema,
	}),
	z.strictObject({
		kind: z.literal("evidence-written"),
		id: z.number().int(),
		result: z.strictObject({
			quotaBytes: z.literal(windowCaseQuotaBytes),
			bytes: z.number().int().nonnegative().max(65536),
			overhead: overheadSchema,
		}),
	}),
	z.strictObject({
		kind: z.literal("overhead"),
		id: z.number().int(),
		result: overheadSchema,
	}),
]);
const requestSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("authorize-create") }),
	z.strictObject({ kind: z.literal("authorize-attach") }),
	z.strictObject({ kind: z.literal("stop") }),
	z.strictObject({
		kind: z.literal("verify"),
		id: z.number().int(),
		paths: z.array(z.string()).min(1).max(64),
	}),
	z.strictObject({
		kind: z.literal("write-evidence"),
		id: z.number().int(),
		name: z.string().max(128),
		bytes: z.string().max(87384),
	}),
	z.strictObject({
		kind: z.literal("measure-overhead"),
		id: z.number().int(),
		paths: z.array(z.string()).max(64),
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

async function answerQuotaRequest(quota, port, request) {
	switch (request.kind) {
		case "verify": {
			await quota.measureOverhead();
			const evidence = await quota.verifyWritablePaths(request.paths);
			await send(port, { kind: "verified", id: request.id, evidence });
			break;
		}
		case "write-evidence": {
			const bytes = Buffer.from(request.bytes, "base64");
			windowRequire(
				bytes.length <= 65536 &&
					bytes.toString("base64") === request.bytes,
				"evidence_bytes_invalid",
			);
			const result = await quota.writeEvidence(request.name, bytes);
			await send(port, {
				kind: "evidence-written",
				id: request.id,
				result,
			});
			break;
		}
		case "measure-overhead": {
			const result = await quota.measureOverhead(request.paths);
			await send(port, { kind: "overhead", id: request.id, result });
			break;
		}
	}
}

function watchQuotaOverhead(current, isStopping, fail) {
	let sampling = false;
	return setInterval(() => {
		const quota = current();
		if (!quota || isStopping() || sampling) return;
		sampling = true;
		void quota.measureOverhead().catch(fail).finally(() => {
			sampling = false;
		});
	}, 25);
}

function reportQuotaLoss(port, code) {
	void send(port, { kind: "loss", code }).catch(() => {
		if (port.connected) port.disconnect();
	});
}

function quotaJournalHooks(journal, options, isStopping, port, onFailure) {
	return {
		async onPhase(phase, identity) {
			try {
				journal.append(phase, identity);
			} catch (error) {
				if (!phase.startsWith("cleanup-")) throw error;
				onFailure(error);
			}
			await options.onPhase?.(phase, identity);
			if (phase.endsWith("-begin") && phase !== "cleanup-begin") {
				windowRequire(
					!isStopping() && port.connected,
					"quota_owner_lost",
				);
			}
		},
	};
}

// The owner holds the quota object: coordinator EOF never discards the detach authority.
export async function ownWindowQuota(root, port = process, options = {}) {
	ownedWindowDirectory(root);
	const creation = Promise.withResolvers();
	if (!options.waitForRegistration) creation.resolve();
	const attach = Promise.withResolvers();
	const stop = Promise.withResolvers();
	let stopping = false, quota, mounted, cleanup = null, failure = null;
	let work = Promise.resolve();
	const journal = createWindowStartupJournal(root);
	const lost = () => {
		stopping = true;
		creation.resolve();
		attach.resolve();
		stop.resolve();
	};
	const fail = (error) => {
		failure ??= failureCode(error);
		reportQuotaLoss(port, failure);
		lost();
	};
	const interrupted = () => {
		reportQuotaLoss(port, "quota_owner_lost");
		lost();
	};
	const message = (input) => {
		const parsed = requestSchema.safeParse(input);
		if (!parsed.success) {
			fail(new WindowConformanceError("quota_owner_protocol"));
			return;
		}
		const request = parsed.data;
		switch (request.kind) {
			case "authorize-create":
				creation.resolve();
				break;
			case "authorize-attach":
				attach.resolve();
				break;
			case "stop":
				lost();
				break;
			case "verify":
			case "write-evidence":
			case "measure-overhead":
				work = work.then(async () => {
					windowRequire(
						quota && !stopping,
						"quota_owner_unavailable",
					);
					await answerQuotaRequest(quota, port, request);
				}).catch(fail);
				break;
		}
	};
	port.once("disconnect", lost);
	port.once("SIGTERM", interrupted);
	port.once("SIGINT", interrupted);
	port.on("message", message);
	const timer = setTimeout(interrupted, 180000);
	const overheadTimer = watchQuotaOverhead(() => quota, () => stopping, fail);
	try {
		journal.append("guardian-ready");
		if (options.waitForRegistration) {
			await send(port, { kind: "owner-ready" });
		}
		await creation.promise;
		windowRequire(port.connected && !stopping, "quota_owner_lost");
		quota = await createOwnedWindowQuota(root, {
			...options,
			...quotaJournalHooks(
				journal,
				options,
				() => stopping,
				port,
				(error) => {
					failure ??= failureCode(error);
				},
			),
			async onCleanup(result) {
				cleanup = result;
			},
			async onCreated(record) {
				await send(port, { kind: "created", record });
				await attach.promise;
				windowRequire(!stopping && port.connected, "quota_owner_lost");
			},
		});
		windowRequire(!stopping, "quota_owner_lost");
		mounted = await quota.verifyWritablePaths([quota.caseRoot]);
		await quota.measureOverhead();
		saveReceipt(root, "quota-owner-mounted", {
			owner_pid: process.pid,
			coordinator_pid: process.ppid,
			image_path: quota.imagePath,
			case_root: quota.caseRoot,
			evidence: mounted,
			actual_target_qualified: false,
			startup_journal: journal.summary(),
		});
		await send(port, {
			kind: "mounted",
			evidence: mounted,
			journal: journal.summary(),
		});
		await stop.promise;
	} catch (error) {
		fail(error);
	} finally {
		clearTimeout(timer);
		clearInterval(overheadTimer);
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
			startup_journal: journal.summary(),
			actual_target_qualified: false,
			limitations: [
				"loss_of_all_cleanup_owners_not_covered",
			],
		};
		try {
			saveReceipt(root, "quota-owner-cleanup", receipt);
			await send(port, {
				kind: "closed",
				cleanup,
				failure,
				journal: journal.summary(),
			});
		} finally {
			journal.close();
			port.removeListener("disconnect", lost);
			port.removeListener("SIGTERM", interrupted);
			port.removeListener("SIGINT", interrupted);
			port.removeListener("message", message);
			if (port.connected) port.disconnect();
		}
	}
	return { cleanup, failure };
}

function launchQuotaOwner(root, launch, registeredStart) {
	const opensslConf = join(root, "quota-owner-openssl.cnf");
	writeFileSync(opensslConf, "", { flag: "wx", mode: 0o600 });
	return launch ? launch(root) : fork(script, [
		"own-quota",
		root,
		...(registeredStart ? ["--registered-start"] : []),
	], {
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

function quotaHandle(root, startupJournal, requestOwner, close) {
	return {
		imagePath: join(root, "volume.sparseimage"),
		caseRoot: join(root, "mounts", "HarnessQuotaState", "private"),
		evidenceRoot: join(root, "mounts", "HarnessQuotaEvidence", "private"),
		startupJournal,
		verifyWritablePaths: (paths) => requestOwner("verify", { paths }),
		writeEvidence: (name, bytes) => {
			windowRequire(
				Buffer.isBuffer(bytes) && bytes.length <= 65536,
				"evidence_bytes_invalid",
			);
			return requestOwner("write-evidence", {
				name,
				bytes: bytes.toString("base64"),
			});
		},
		measureOverhead: (paths = []) =>
			requestOwner("measure-overhead", { paths }),
		close,
	};
}

function verifyQuotaCleanup(root, identity, cleanup) {
	windowRequire(
		identity && cleanup && sameIdentity(identity, cleanup.identity),
		"quota_cleanup_unverified",
	);
	windowRequire(
		!existsSync(join(root, "volume.sparseimage")),
		"quota_cleanup_unverified",
	);
}

class WindowQuotaGuardian {
	stopSent = false;
	ownerReady = false;
	registered = false;
	createAuthorized = false;
	ready = Promise.withResolvers();
	completion = Promise.withResolvers();
	pending = new Map();
	child;
	identity;
	mounted;
	receipt;
	startupJournal;
	failure;
	timer;
	closing = false;
	sequence = 0;

	constructor(root, options) {
		ownedWindowDirectory(root);
		this.root = root;
		this.options = options;
		void this.ready.promise.catch(() => this.completion.promise);
	}

	fail(code) {
		const first = this.failure === undefined;
		this.failure ??= code;
		this.ready.reject(new WindowConformanceError(code));
		for (const request of this.pending.values()) {
			request.reject(new WindowConformanceError(code));
		}
		this.pending.clear();
		try {
			if (first) this.options.onLoss?.(this.failure);
		} finally {
			this.sendStop();
		}
	}

	send(input) {
		this.child.send(input, (error) => {
			if (error) this.fail("quota_owner_unavailable");
		});
	}

	sendStop() {
		if (!this.stopSent && this.child?.connected) {
			this.stopSent = true;
			this.send({ kind: "stop" });
		}
	}

	acknowledge(callback, release) {
		void Promise.resolve().then(callback).then(() => {
			if (!this.failure && !this.closing) release();
		}).catch((error) => this.fail(failureCode(error)));
	}

	releaseCreation() {
		if (
			this.ownerReady && this.registered && !this.createAuthorized &&
			!this.failure && !this.closing && this.child.connected
		) {
			this.createAuthorized = true;
			this.send({ kind: "authorize-create" });
		}
	}

	created(message) {
		windowRequire(!this.identity && !this.closing, "quota_owner_protocol");
		this.identity = windowImageIdentity(this.root);
		windowRequire(
			sameIdentity(this.identity, message.record),
			"quota_ownership_unverified",
		);
		const release = () => this.send({ kind: "authorize-attach" });
		if (this.options.onCreated) {
			this.acknowledge(
				() =>
					this.options.onCreated(
						join(this.root, "volume.sparseimage"),
						this.identity,
					),
				release,
			);
		} else release();
	}

	mount(message) {
		windowRequire(
			this.identity && !this.mounted && !this.closing,
			"quota_owner_protocol",
		);
		windowRequire(
			sameIdentity(this.identity, message.evidence.identity),
			"quota_ownership_unverified",
		);
		this.mounted = message.evidence;
		this.startupJournal = message.journal;
		if (this.options.onMounted) {
			this.acknowledge(
				() => this.options.onMounted(this.mounted),
				() => this.ready.resolve(),
			);
		} else this.ready.resolve();
	}

	answer(id, value) {
		const request = this.pending.get(id);
		windowRequire(request, "quota_owner_protocol");
		this.pending.delete(id);
		request.resolve(value);
	}

	message(input) {
		const parsed = responseSchema.safeParse(input);
		if (!parsed.success) return this.fail("quota_owner_protocol");
		const message = parsed.data;
		try {
			switch (message.kind) {
				case "owner-ready":
					windowRequire(
						!this.ownerReady && Boolean(this.options.onOwner),
						"quota_owner_protocol",
					);
					this.ownerReady = true;
					return this.releaseCreation();
				case "loss":
					return this.fail(message.code);
				case "created":
					return this.created(message);
				case "mounted":
					return this.mount(message);
				case "verified":
					windowRequire(
						this.identity &&
							sameIdentity(
								this.identity,
								message.evidence.identity,
							),
						"quota_ownership_unverified",
					);
					return this.answer(message.id, message.evidence);
				case "evidence-written":
				case "overhead":
					return this.answer(message.id, message.result);
				case "closed":
					verifyQuotaCleanup(
						this.root,
						this.identity,
						message.cleanup,
					);
					this.receipt = message.cleanup;
					this.startupJournal = message.journal;
					if (message.failure) this.fail(message.failure);
			}
		} catch (error) {
			this.fail(failureCode(error));
		}
	}

	// The guardian is gone without a receipt: only the journal and the pinned
	// root remain, and they are enough to detach and delete what was recorded.
	async recoverFromJournal() {
		try {
			return await (this.options.recover ?? recoverWindowQuota)(
				this.root,
				{ run: this.options.run, fs: this.options.fs },
			);
		} catch (error) {
			return { recovered: false, code: failureCode(error) };
		}
	}

	exit() {
		clearTimeout(this.timer);
		if (!this.receipt) this.fail("quota_cleanup_unverified");
		if (!this.mounted) {
			this.ready.reject(
				new WindowConformanceError(
					this.failure ?? "quota_owner_unavailable",
				),
			);
		}
		for (const request of this.pending.values()) {
			request.reject(
				new WindowConformanceError("quota_owner_unavailable"),
			);
		}
		this.pending.clear();
		const settle = (recovery) =>
			this.completion.resolve({
				cleanup: this.receipt ??
					(recovery?.recovered && recovery.identity
						? {
							detached: true,
							ownedImageDeleted: true,
							identity: recovery.identity,
						}
						: null),
				failure: this.failure ?? null,
				startupJournal: this.startupJournal ?? null,
				...(recovery ? { recovery } : {}),
			});
		if (this.receipt) settle(null);
		else void this.recoverFromJournal().then(settle);
	}

	async close() {
		if (!this.child) return null;
		this.closing = true;
		this.sendStop();
		const result = await this.completion.promise;
		windowRequire(
			result.cleanup && !result.failure,
			result.failure ?? "quota_cleanup_unverified",
		);
		return result.cleanup;
	}

	request(kind, fields = {}) {
		windowRequire(
			!this.closing && this.child?.connected && this.mounted,
			"quota_owner_unavailable",
		);
		const id = ++this.sequence;
		const request = Promise.withResolvers();
		this.pending.set(id, request);
		this.send({ kind, id, ...fields });
		return request.promise;
	}

	async start() {
		windowRequire(!this.child, "reservation_reused");
		this.child = launchQuotaOwner(
			this.root,
			this.options.launch,
			Boolean(this.options.onOwner),
		);
		this.child.on("message", (input) => this.message(input));
		this.child.once("error", () => this.fail("quota_owner_unavailable"));
		this.child.once("exit", () => this.exit());
		this.timer = setTimeout(() => {
			this.fail("quota_owner_deadline");
			this.completion.resolve({ cleanup: null, failure: this.failure });
		}, 210000);
		if (this.options.onOwner) {
			try {
				windowRequire(
					Number.isSafeInteger(this.child.pid) && this.child.pid > 1,
					"quota_owner_unavailable",
				);
				await this.options.onOwner(this.child.pid);
				this.registered = true;
				this.releaseCreation();
			} catch (error) {
				this.fail(failureCode(error));
			}
		}
		await this.ready.promise;
		return quotaHandle(
			this.root,
			this.startupJournal,
			(kind, fields) => this.request(kind, fields),
			() => this.close(),
		);
	}
}

export function createWindowQuotaGuardian(root, options = {}) {
	const guardian = new WindowQuotaGuardian(root, options);
	return Object.freeze({
		get owner() {
			return guardian.child;
		},
		closed: guardian.completion.promise,
		start: () => guardian.start(),
		close: () => guardian.close(),
	});
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	if (
		(process.argv.length === 4 ||
			process.argv.length === 5 &&
				process.argv[4] === "--registered-start") &&
		process.argv[2] === "own-quota" &&
		process.send
	) {
		try {
			const result = await ownWindowQuota(process.argv[3], process, {
				waitForRegistration: process.argv.length === 5,
			});
			if (result.failure || !result.cleanup) process.exitCode = 2;
		} catch {
			process.exitCode = 2;
		}
	} else process.exitCode = 2;
}
