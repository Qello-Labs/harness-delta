import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	appendFileSync,
	lstatSync,
	mkdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createWindowClock } from "./codex-window-clock.mjs";
import { hashFile } from "./fixtures.mjs";
import { createWindowWatch } from "./codex-window-watch.mjs";
import { createWindowQuotaGuardian } from "./codex-window-quota-owner.mjs";
import {
	createWindowResourceRegistry,
	verifyWindowResourceRegistry,
} from "./codex-window-registry.mjs";
import { createSyntheticWindowCollection } from "./codex-window-collection.mjs";
import { exportWindowEvidence } from "./codex-window-evidence-export.mjs";
import { revalidateWindowConsent } from "./codex-window-consent.mjs";
import {
	ownedWindowDirectory,
	WindowConformanceError,
	windowRequire,
} from "./codex-window-conformance.mjs";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const milliseconds = (nanos) => Number(nanos / 1000000n);
const birth = (identity) => `${identity.start_sec}:${identity.start_usec}`;
const codeOf = (error) =>
	error instanceof Error && "code" in error
		? String(error.code)
		: error instanceof Error
		? error.message
		: "case_guard_failure";
const samePathIdentity = (a, b) =>
	a.dev === b.dev && a.ino === b.ino && a.uid === b.uid;

class SyntheticWindowCaseGuards {
	constructor(options) {
		this.options = Object.freeze({ ...options });
		ownedWindowDirectory(options.root);
		windowRequire(
			options.caseId === "normal",
			"synthetic_case_unsupported",
		);
		windowRequire(
			Number.isSafeInteger(options.batchStartedMs) &&
				options.batchStartedMs >= 0,
			"clock_invalid",
		);
		windowRequire(
			Number.isSafeInteger(options.priorExecs) &&
				options.priorExecs >= 0 && options.priorExecs <= 15,
			"count_invalid",
		);
		this.registry = createWindowResourceRegistry({
			root: options.root,
			caseId: options.caseId,
			batchStartedMs: options.batchStartedMs,
		});
		this.completed = Promise.withResolvers();
		this.aborted = Promise.withResolvers();
		this.result = this.completed.promise;
		this.targets = new Map();
		this.signalEvidence = [];
		this.paths = new Map();
		this.errors = [];
		this.controller = new AbortController();
		this.guardRoot = join(options.root, "guards");
		this.quotaRoot = join(options.root, "quota");
		this.fixturePath = join(this.guardRoot, "watch-fixture");
		this.guardRoots = [
			...new Set([
				options.root,
				dirname(options.nativePath),
				...options.guardRoots ?? [],
			]),
		];
		this.failed = false;
		this.reason = null;
		this.stopping = false;
		this.watchLost = false;
		this.lastNs = BigInt(options.batchStartedMs) * 1000000n;
		options.auditClock.result.then(() => {
			if (!this.finished) this.fail("audit_clock_loss");
		}, (error) => {
			if (!this.finished) this.fail(codeOf(error));
		});
	}

	registerPid = async (identity) => {
		this.registry.recordPid({
			pid: identity.pid,
			uid: identity.uid,
			started: birth(identity),
		});
	};

	registerPath(path) {
		const distance = relative(this.options.root, path);
		windowRequire(
			distance && distance !== ".." && !distance.startsWith(`..${sep}`) &&
				!isAbsolute(distance),
			"resource_scope_invalid",
		);
		const stat = lstatSync(path);
		windowRequire(
			!stat.isSymbolicLink() && stat.uid === process.getuid(),
			"resource_scope_invalid",
		);
		this.registry.recordPath(path);
		this.paths.set(path, stat);
	}

	fail(reason) {
		if (this.stopping) {
			if (!this.failed) this.failed = true;
			this.reason ??= reason;
			return;
		}
		if (this.failed) return;
		this.failed = true;
		this.reason = reason;
		this.controller.abort();
		this.aborted.resolve();
		this.beginNativeStop();
		// Revocation is synchronous; any in-flight public read must fail its commit fence.
		try {
			this.collection?.close();
		} catch (error) {
			this.errors.push(codeOf(error));
		}
		this.watch?.targetStdio?.[0]?.destroy();
		queueMicrotask(() => {
			void this.stop(reason);
		});
	}

	beginNativeStop() {
		this.originPromise ??= this.options.auditClock.clock();
		this.originPromise.catch((error) => this.errors.push(codeOf(error)));
		if (this.watch) {
			this.watchStopPromise ??= this.originPromise.then((origin) =>
				this.watch.stop(origin)
			);
			this.watchStopPromise.catch((error) =>
				this.errors.push(codeOf(error))
			);
		}
		if (this.watchLost) {
			this.fallbackPromise ??= this.signalTargets();
		}
	}

	async signalTargets() {
		const origin = await this.attempt(() => this.originPromise) ??
			this.lastNs;
		for (const identity of this.targets.values()) {
			for (const signal of ["TERM", "KILL"]) {
				await this.attempt(async () => {
					const receipt = await this.clock.signal(identity, signal);
					const latencyMs = Number(BigInt(receipt.now_ns) - origin) /
						1000000;
					this.signalEvidence.push({
						identity,
						signal,
						receipt,
						latency_ms: latencyMs,
					});
					windowRequire(
						latencyMs >= 0 &&
							latencyMs <= (signal === "TERM" ? 250 : 2250),
						"fallback_dispatch_latency",
					);
				});
			}
		}
	}

	check() {
		windowRequire(
			!this.controller.signal.aborted && !this.stopping,
			this.reason ?? "case_stopped",
		);
		if (this.capability) {
			revalidateWindowConsent(this.capability, this.pins);
		}
	}

	async work(operation) {
		this.check();
		const value = await Promise.race([
			operation(),
			this.aborted.promise.then(() => {
				throw new WindowConformanceError(this.reason ?? "case_stopped");
			}),
		]);
		this.check();
		return value;
	}

	async now() {
		const value = await this.clock.clock();
		windowRequire(value >= this.lastNs, "clock_invalid");
		this.lastNs = value;
		return value;
	}

	async compileFixture() {
		const child = spawn("/usr/bin/cc", [
			"-O2",
			"-Wall",
			"-Wextra",
			"-Werror",
			join(sourceDirectory, "codex-window-watch-fixture.c"),
			"-o",
			this.fixturePath,
		], {
			cwd: this.guardRoot,
			env: {
				PATH: "/usr/bin:/bin",
				HOME: this.guardRoot,
				TMPDIR: this.guardRoot,
				LC_ALL: "C",
				TZ: "UTC",
			},
			stdio: "ignore",
		});
		this.compiler = child;
		const spawned = Promise.withResolvers();
		const closed = Promise.withResolvers();
		child.once("spawn", spawned.resolve);
		child.once("error", (error) => {
			spawned.reject(error);
			closed.reject(error);
		});
		child.once("close", (code) => closed.resolve(code));
		this.compilerClosed = closed.promise;
		this.compilerClosed.catch((error) => this.fail(codeOf(error)));
		await this.work(() => spawned.promise);
		const identity = await this.work(() => this.clock.inspect(child.pid));
		windowRequire(identity !== null, "compiler_identity_missing");
		await this.registerPid(identity);
		this.compilerIdentity = identity;
		windowRequire(
			await this.work(() => closed.promise) === 0,
			"fixture_compile_failed",
		);
		const stat = lstatSync(this.fixturePath);
		windowRequire(
			stat.isFile() && !stat.isSymbolicLink() &&
				stat.uid === process.getuid() && !(stat.mode & 0o022),
			"fixture_identity_invalid",
		);
		this.fixtureIdentity = stat;
		this.fixtureSha256 = hashFile(this.fixturePath);
	}

	prepare() {
		windowRequire(!this.preparing, "reservation_reused");
		this.preparing = this.prepareWork();
		return this.preparing.catch(async (error) => {
			this.fail(codeOf(error));
			await this.stop(this.reason);
			throw error;
		});
	}

	async prepareWork() {
		this.lastNs = await this.work(() => this.options.auditClock.clock());
		const now = milliseconds(this.lastNs);
		this.caseBudget = this.options.budget.reserve(
			this.options.caseId,
			now,
			now + 120000,
		);
		this.deadlineNs = BigInt(this.caseBudget.deadline) * 1000000n;
		this.deadlineTimer = setTimeout(
			() => this.fail("deadline"),
			Math.max(1, this.caseBudget.deadline - now),
		);
		for (const path of [this.guardRoot, this.quotaRoot]) {
			mkdirSync(path, { mode: 0o700 });
		}
		this.registerPath(this.guardRoot);
		this.clock = createWindowClock({
			nativePath: this.options.nativePath,
			env: {
				PATH: "/usr/bin:/bin",
				HOME: this.guardRoot,
				TMPDIR: this.guardRoot,
				LC_ALL: "C",
				TZ: "UTC",
			},
			onOwnerResource: this.registerPid,
			onResource: this.registerPid,
			onRecord: (event) => {
				if (event.kind === "loss") this.fail(event.code);
			},
		});
		this.clock.result.then((result) => {
			if (!this.stopping) {
				this.fail(result.failed ? "clock_loss" : "clock_eof");
			}
		}, (error) => this.fail(codeOf(error)));
		await this.work(() => this.clock.ready);
		this.caseBudget.remaining(
			milliseconds(await this.work(() => this.now())),
		);
		await this.compileFixture();
		this.guardian = createWindowQuotaGuardian(this.quotaRoot, {
			onOwner: async (pid) => {
				this.registerPath(
					join(this.quotaRoot, "quota-owner-openssl.cnf"),
				);
				windowRequire(
					this.guardian.owner?.pid === pid,
					"quota_owner_identity_missing",
				);
				const identity = await this.work(() => this.clock.inspect(pid));
				windowRequire(
					identity !== null && identity.pid === pid,
					"quota_owner_identity_missing",
				);
				await this.registerPid(identity);
			},
			onCreated: async (imagePath) => {
				this.check();
				this.mountRoot = join(this.quotaRoot, "mounts");
				this.registerPath(this.mountRoot);
				this.registerPath(imagePath);
				this.imagePath = imagePath;
			},
			onMounted: async (evidence) => {
				this.check();
				windowRequire(this.imagePath, "image_registration_missing");
				this.registry.recordImage({
					path: this.imagePath,
					devices: evidence.entities.map((entity) =>
						entity["dev-entry"]
					),
				});
				for (
					const path of new Set([
						...evidence.writablePaths,
						...evidence.entities.flatMap((entity) =>
							entity["mount-point"] ? [entity["mount-point"]] : []
						),
					])
				) this.registerPath(path);
			},
			onLoss: (code) => this.fail(code),
		});
		this.guardian.closed.then((result) => {
			if (!this.stopping) this.fail(result.failure ?? "quota_owner_eof");
		}, (error) => this.fail(codeOf(error)));
		this.quota = await this.work(() => this.guardian.start());
		await this.work(() => this.quota.measureOverhead(this.guardRoots));
		this.registerPath(this.quota.evidenceRoot);
		return Object.freeze({
			caseRoot: this.quota.caseRoot,
			evidenceRoot: this.quota.evidenceRoot,
			registryRoot: this.options.root,
			actual_qualification: false,
			execution_enabled: false,
		});
	}

	run(input) {
		windowRequire(this.preparing && !this.running, "reservation_reused");
		this.running = this.runWork(input);
		return this.running.then(() => this.stop("normal"), (error) => {
			this.fail(codeOf(error));
			return this.stop(this.reason);
		});
	}

	async runWork({ capability, observedPins, scenario }) {
		await this.work(() => this.preparing);
		windowRequire(scenario === "hold", "synthetic_scenario_unsupported");
		const consent = revalidateWindowConsent(capability, observedPins);
		windowRequire(
			consent.origin === "synthetic" &&
				consent.caseRoot === this.quota.caseRoot,
			"synthetic_scope_mismatch",
		);
		this.capability = capability;
		this.pins = observedPins;
		await this.shorten(consent.expiresAt);
		this.collection = createSyntheticWindowCollection(
			capability,
			observedPins,
		);
		const controlPath = join(
			this.collection.receiptDirectory,
			"ordinary-window-control.json",
		);
		const control = lstatSync(controlPath),
			controlBirth = lstatSync(controlPath, { bigint: true });
		windowRequire(
			[control.dev, control.ino, control.uid].every(
				Number.isSafeInteger,
			) &&
				control.isFile() && !control.isSymbolicLink() &&
				controlBirth.dev === BigInt(control.dev) &&
				controlBirth.ino === BigInt(control.ino) &&
				controlBirth.uid === BigInt(control.uid) &&
				controlBirth.birthtimeNs >= 0n,
			"receipt_control_identity_invalid",
		);
		const receiptControl = {
			dev: control.dev,
			ino: control.ino,
			uid: control.uid,
			birthSec: Number(controlBirth.birthtimeNs / 1000000000n),
			birthNsec: Number(controlBirth.birthtimeNs % 1000000000n),
		};
		await this.work(() =>
			this.quota.verifyWritablePaths([
				this.collection.projectRoot,
				this.collection.sourceRoot,
				this.collection.receiptDirectory,
			])
		);
		const reported = Promise.withResolvers();
		const watch = createWindowWatch({
			nativePath: this.options.nativePath,
			env: {
				PATH: "/usr/bin:/bin",
				HOME: this.quota.caseRoot,
				TMPDIR: this.quota.caseRoot,
				LC_ALL: "C",
				TZ: "UTC",
			},
			receiptDirectory: this.collection.receiptDirectory,
			receiptControl,
			executable: this.fixturePath,
			args: ["hold", "0"],
			priorExecs: this.options.priorExecs,
			deadlineNs: String(this.deadlineNs),
			targetStdio: ["pipe", "pipe", "pipe"],
			onOwnerResource: this.registerPid,
			onResource: async (identity) => {
				await this.registerPid(identity);
				this.targets.set(
					`${identity.pid}:${birth(identity)}`,
					identity,
				);
			},
			onRecord: (event) => {
				switch (event.kind) {
					case "loss":
						this.watchLost = event.code === "guard_loss" ||
							event.code === "protocol";
						this.fail(event.code);
						break;
					case "count":
						if (
							event.execs > 15 || event.live > 16 ||
							event.receipts > 16
						) {
							this.overshoot ??= event;
							this.fail("overrun");
						}
						break;
					case "dispatch":
						if (
							event.latency_ms >
								(event.signal === "TERM" ? 250 : 2250)
						) this.fail("dispatch_latency");
						break;
				}
			},
		});
		this.watch = watch;
		watch.result.then((result) => {
			this.watchResult = result;
			if (!this.stopping) {
				this.watchLost ||= !result.cleanup_verified;
				this.fail(result.failed ? "watch_loss" : "watch_eof");
			}
		}, (error) => {
			this.watchLost = true;
			this.fail(codeOf(error));
		});
		const output = watch.targetStdio?.[1];
		windowRequire(output, "fixture_output_missing");
		let bytes = 0;
		output.on("data", (chunk) => {
			if (this.controller.signal.aborted) return;
			bytes += chunk.length;
			if (bytes !== 1 || chunk[0] !== 72) {
				return this.fail("fixture_protocol");
			}
			reported.resolve();
		});
		output.once("end", () => {
			if (!this.stopping) this.fail("fixture_eof");
		});
		output.once("error", () => this.fail("fixture_output_loss"));
		watch.targetStdio?.[2]?.on("data", () => this.fail("fixture_stderr"));
		await this.work(() => watch.ready);
		const receipt = this.writeSyntheticBaseline();
		windowRequire(
			samePathIdentity(
				this.fixtureIdentity,
				lstatSync(this.fixturePath),
			) && realpathSync(this.fixturePath) === this.fixturePath &&
				hashFile(this.fixturePath) === this.fixtureSha256,
			"fixture_identity_invalid",
		);
		await this.work(() => this.collection.connect(receipt));
		this.baselineWallMs = Date.now();
		const trial = this.collection.store.get(
			"SELECT trial_expires_at FROM ordinary_window_activations WHERE trial_task_id=? AND revoked_at IS NULL",
			[this.collection.taskId],
		);
		windowRequire(
			typeof trial?.trial_expires_at === "string",
			"trial_expiry_missing",
		);
		await this.shorten(Date.parse(trial.trial_expires_at));
		await this.work(() => this.quota.measureOverhead(this.guardRoots));
		await this.work(() => watch.launch());
		await this.work(() => reported.promise);
		await this.collectSyntheticUsage();
	}

	async collectSyntheticUsage() {
		this.appendSyntheticUsage();
		await this.work(() => this.collection.collect());
		this.collectionEvidence = {
			event_count: this.collection.store.eventCount(),
			trial_tokens_consumed: this.collection.store.get(
				"SELECT trial_tokens_consumed FROM ordinary_window_activations WHERE trial_task_id=?",
				[this.collection.taskId],
			)?.trial_tokens_consumed,
		};
		windowRequire(
			this.collectionEvidence.event_count === 1 &&
				this.collectionEvidence.trial_tokens_consumed === 120,
			"synthetic_collection_missing",
		);
		await this.work(() =>
			this.quota.writeEvidence(
				"synthetic-case.json",
				Buffer.from(JSON.stringify({
					origin: "synthetic",
					actual_qualification: false,
					...this.collectionEvidence,
				})),
			)
		);
	}

	async shorten(expiresAt) {
		const now = await this.work(() => this.now());
		const remaining = expiresAt - Date.now();
		windowRequire(remaining > 0, "consent_expired");
		const expiry = Math.min(
			this.caseBudget.deadline,
			milliseconds(now) + remaining,
		);
		this.caseBudget.bindTrialExpiry(expiry);
		this.deadlineNs = BigInt(expiry) * 1000000n;
		if (this.watch) {
			await this.work(() =>
				this.watch.shortenDeadline(String(this.deadlineNs))
			);
		}
		clearTimeout(this.deadlineTimer);
		this.deadlineTimer = setTimeout(
			() => this.fail("deadline"),
			Math.max(1, expiry - milliseconds(now)),
		);
	}

	writeSyntheticBaseline() {
		const nativeId = "synthetic-case-guards-root";
		this.source = join(this.collection.sourceRoot, "root.jsonl");
		writeFileSync(
			this.source,
			JSON.stringify({
				type: "session_meta",
				payload: {
					id: nativeId,
					session_id: nativeId,
					cli_version: "0.167.0",
					cwd: this.collection.projectRoot,
					source: "cli",
				},
			}) + "\n",
			{ flag: "wx", mode: 0o600 },
		);
		const receipt = {
			schemaVersion: 2,
			kind: "codex_window_pending",
			receipt: randomUUID(),
			product: "codex",
			event: "SessionStart",
			lifecycle: "startup",
			nativeSessionId: nativeId,
			nativeRootSessionId: nativeId,
			agentId: null,
			turnId: null,
			cwd: this.collection.projectRoot,
			sourceRef: this.source,
			recordedAt: new Date().toISOString(),
		};
		writeFileSync(
			join(this.collection.receiptDirectory, `${receipt.receipt}.json`),
			JSON.stringify(receipt),
			{ flag: "wx", mode: 0o600 },
		);
		return receipt;
	}

	appendSyntheticUsage() {
		this.check();
		windowRequire(
			Date.now() > this.baselineWallMs,
			"synthetic_clock_not_advanced",
		);
		const timestamp = new Date().toISOString();
		appendFileSync(
			this.source,
			[
				{
					type: "turn_context",
					timestamp,
					payload: {
						cwd: this.collection.projectRoot,
						turn_id: "turn",
						root_turn_id: "turn",
						model: "gpt-6.1-sol",
						effort: "high",
					},
				},
				{
					type: "token_usage_record",
					timestamp,
					payload: {
						thread_id: "synthetic-case-guards-root",
						session_id: "synthetic-case-guards-root",
						turn_id: "turn",
						root_turn_id: "turn",
						response_id: "synthetic-response",
						usage: {
							input_tokens: 100,
							cached_input_tokens: 10,
							output_tokens: 20,
							reasoning_output_tokens: 5,
							total_tokens: 120,
						},
					},
				},
			].map((row) => JSON.stringify(row)).join("\n") + "\n",
		);
	}

	// Each flag is evidence from this case, not a constant: the registry closure
	// checked every registered process by birth identity, the native guard found
	// nothing outside its tree, and the image detached before its bytes went.
	derivedCleanup(closure) {
		const watched = this.watch === undefined ||
			this.watchResult?.cleanup_verified === true &&
				this.watchResult.live === 0 &&
				this.watchResult.unaccounted === 0;
		const streams = this.watch?.targetStdio ?? [];
		return {
			identitiesGone: closure.closedResources > 0 && watched &&
				this.watchLost === false,
			resourcesClosed: closure.closedResources > 0 &&
				this.quotaClosed?.cleanup?.detached === true &&
				this.quotaClosed.cleanup.ownedImageDeleted === true,
			terminalRestored: streams.every((stream) => !stream?.isTTY),
		};
	}

	stop(reason = "normal") {
		if (reason !== "normal" && !this.failed) this.fail(reason);
		this.stopped ??= this.cleanup();
		return this.result;
	}

	async attempt(operation) {
		try {
			return await operation();
		} catch (error) {
			this.failed = true;
			this.reason ??= codeOf(error);
			this.errors.push(codeOf(error));
			return null;
		}
	}

	async settleWatch() {
		if (!this.watch) return;
		const result = await this.attempt(() => this.watchStopPromise);
		this.watchResult = result ?? this.watchResult;
		if (
			!result?.cleanup_verified || result.failed ||
			result.stop_batch || result.unaccounted !== 0
		) {
			this.failed = true;
			this.watchLost ||= !result?.cleanup_verified;
			this.reason ??= "watch_cleanup_unverified";
		}
	}

	// The evidence volume dies with the image, so its bounded JSON leaves first.
	async exportEvidence() {
		if (!this.options.evidenceExportRoot || !this.quota) return;
		this.evidenceExport = await this.attempt(async () =>
			exportWindowEvidence({
				evidenceRoot: this.quota.evidenceRoot,
				exportRoot: this.options.evidenceExportRoot,
			})
		);
	}

	async cleanup() {
		// Work races resolve on abort before any registry can be sealed.
		if (this.failed) this.aborted.resolve();
		await Promise.allSettled(
			[this.preparing, this.running].filter(Boolean),
		);
		this.stopping = true;
		clearTimeout(this.deadlineTimer);
		await this.attempt(async () => {
			this.collection?.close();
		});
		this.beginNativeStop();
		const origin = await this.attempt(() => this.originPromise);
		this.stopOriginNs = origin ?? this.lastNs;
		const stoppedAt = milliseconds(this.stopOriginNs);
		await this.attempt(async () => {
			if (this.caseBudget) {
				if (this.failed) this.caseBudget.loss("guardian", stoppedAt);
				else this.caseBudget.stop(stoppedAt);
			}
		});
		await this.settleWatch();
		if (this.watchLost) {
			this.fallbackPromise ??= this.signalTargets();
			await this.fallbackPromise;
		}
		if (this.compilerIdentity && !this.fixtureIdentity) {
			await this.attempt(() =>
				this.clock.signal(this.compilerIdentity, "KILL")
			);
			await this.attempt(() => this.compilerClosed);
		}
		await this.exportEvidence();
		if (this.guardian) {
			await this.attempt(() => this.guardian.close());
			this.quotaClosed = await this.attempt(() => this.guardian.closed);
		}
		for (const [path, identity] of this.paths) {
			await this.attempt(async () => {
				if (
					path === this.imagePath || path === this.mountRoot ||
					(this.mountRoot && path.startsWith(this.mountRoot + sep))
				) {
					windowRequire(
						this.quotaClosed?.cleanup?.detached === true,
						"cleanup_image_not_detached",
					);
				}
				let current;
				try {
					current = lstatSync(path);
				} catch (error) {
					if (error?.code === "ENOENT") return;
					throw error;
				}
				windowRequire(
					samePathIdentity(identity, current),
					"cleanup_path_identity_changed",
				);
				rmSync(path, { recursive: current.isDirectory() });
			});
		}
		// All service-owned registrations settle before stop() resolves and seal occurs.
		if (this.clock) {
			const clockResult = await this.attempt(() =>
				this.clock.stop(this.stopOriginNs)
			);
			if (!clockResult || clockResult.failed) {
				this.failed = true;
				this.reason ??= "clock_cleanup_unverified";
			}
		}
		this.reference = await this.attempt(async () => this.registry.seal());
		let closure = null;
		let finalNow = null;
		if (this.reference) {
			closure = await this.attempt(() =>
				verifyWindowResourceRegistry(this.reference, {
					checkDeadline: async () => {
						finalNow = await this.options.auditClock.clock();
						const upper = milliseconds(finalNow);
						windowRequire(
							upper <= stoppedAt + 5000 &&
								upper <=
									this.options.batchStartedMs + 1200000 -
										10000,
							"cleanup_deadline",
						);
					},
				})
			);
		}
		let cleanupBudgetVerified = false;
		if (closure && this.caseBudget) {
			await this.attempt(async () => {
				if (this.failed) this.caseBudget.loss("guardian", stoppedAt);
				this.caseBudget.verifyCleanup(
					milliseconds(finalNow),
					this.derivedCleanup(closure),
				);
				cleanupBudgetVerified = true;
			});
		}
		if (!closure) {
			this.failed = true;
			this.reason ??= "cleanup_unverified";
			await this.attempt(async () =>
				this.caseBudget?.loss("guardian", stoppedAt)
			);
		}
		await this.attempt(async () => this.registry.close());
		this.finished = true;
		this.completed.resolve(Object.freeze({
			origin: "synthetic",
			execution_enabled: false,
			actual_qualification: false,
			failed: this.failed,
			stop_batch: this.failed,
			reason: this.reason,
			cleanup_verified: cleanupBudgetVerified,
			closure,
			registry: this.reference,
			batch_started_continuous_ms: this.options.batchStartedMs,
			stop_origin_ns: String(this.stopOriginNs),
			watch: this.watchResult ?? null,
			observed_overshoot: this.overshoot ?? null,
			evidence_export: this.evidenceExport ?? null,
			fallback_signals: Object.freeze([...this.signalEvidence]),
			collection: this.collectionEvidence ?? null,
			errors: Object.freeze([...this.errors]),
			unqualified: Object.freeze([
				"vendor_containment",
				"pty_composition",
				"native_recipe_composition",
			]),
		}));
	}
}

export function createSyntheticWindowCaseGuards(options) {
	const coordinator = new SyntheticWindowCaseGuards(options);
	return Object.freeze({
		prepare: () => coordinator.prepare(),
		run: (input) => coordinator.run(input),
		stop: (reason) => coordinator.stop(reason),
		result: coordinator.result,
	});
}
