import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { z } from "zod";

const natural = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const nanos = z.string().regex(/^[0-9]{1,20}$/);
const receiptControlIdentity = z.strictObject({
	dev: natural,
	ino: natural,
	uid: natural,
	birthSec: natural,
	birthNsec: natural.max(999999999),
});
const identity = z.strictObject({
	pid: natural.min(2),
	parent: natural.min(1),
	pgid: natural.min(2),
	uid: natural,
	start_sec: natural,
	start_usec: natural.max(999999),
});
const counts = {
	execs: natural,
	live: natural,
	receipts: natural,
	lower_bound: z.literal(true),
};
const record = z.discriminatedUnion("kind", [
	z.strictObject({
		kind: z.literal("ready"),
		mode: z.enum(["watch", "clock"]),
		now_ns: nanos,
		owner: identity.optional(),
		seq: natural,
	}),
	z.strictObject({
		kind: z.literal("clock"),
		id: natural,
		now_ns: nanos,
		seq: natural,
	}),
	z.strictObject({
		kind: z.literal("process"),
		id: natural,
		now_ns: nanos,
		identity: identity.nullable(),
		seq: natural,
	}),
	z.strictObject({
		kind: z.literal("signal"),
		id: natural,
		now_ns: nanos,
		outcome: z.enum(["sent", "absent"]),
		seq: natural,
	}),
	z.strictObject({
		kind: z.literal("phase"),
		phase: z.enum(["root-suspended", "running"]),
		seq: natural,
	}),
	z.strictObject({ kind: z.literal("identity"), identity, seq: natural }),
	z.strictObject({
		kind: z.literal("count"),
		...counts,
		exec_overshoot: natural,
		live_overshoot: natural,
		receipt_overshoot: natural,
		seq: natural,
	}),
	z.strictObject({
		kind: z.literal("dispatch"),
		signal: z.enum(["TERM", "KILL"]),
		latency_ms: z.number().nonnegative().finite(),
		seq: natural,
	}),
	z.strictObject({
		kind: z.literal("loss"),
		code: z.enum([
			"guard_loss",
			"overrun",
			"deadline",
			"coordinator_lost",
			"protocol",
			"unaccounted",
		]),
		seq: natural,
	}),
	z.strictObject({
		kind: z.literal("final"),
		...counts,
		unaccounted: natural,
		failed: z.boolean(),
		stop_batch: z.boolean(),
		cleanup_verified: z.boolean(),
		term_ms: z.number().nonnegative().finite().nullable(),
		kill_ms: z.number().nonnegative().finite().nullable(),
		disappearance_ms: z.number().nonnegative().finite().nullable(),
		seq: natural,
	}),
]);

export class WindowWatchError extends Error {
	constructor(code) {
		super(code);
		this.code = code;
	}
}

// Exit is delivered after pipe drainage, not the earlier child_process exit event.
export function windowNativeTransport(file, args, options) {
	const child = spawn(file, args, {
		env: options.env,
		stdio: ["pipe", "pipe", "pipe", ...(options.targetStdio ?? [])],
	});
	const peer = Object.assign(new EventEmitter(), {
		stdin: child.stdin,
		stdout: child.stdout,
		stderr: child.stderr,
		targetStdio: child.stdio.slice(3),
	});
	child.once("error", (error) => peer.emit("error", error));
	child.once("close", (code, signal) => peer.emit("exit", code, signal));
	return peer;
}

export function createWindowWatch(options) {
	return createWindowNativeService("watch", options);
}

class WindowNativeSession {
	ready = Promise.withResolvers();
	completed = Promise.withResolvers();
	launched = Promise.withResolvers();
	pending = new Map();
	nextId = 0;
	sequence = 0;
	buffer = Buffer.alloc(0);
	ended = false;
	finished = false;
	rootIdentitySeen = false;
	rootPhaseSeen = false;
	resourcePending = 0;
	armed = false;
	launchSent = false;
	stopped = false;
	failed = false;
	final;
	stopTimer;
	lastClockNs = 0n;
	resources = Promise.resolve();

	constructor(mode, options) {
		this.mode = mode;
		this.options = options;
		this.deadlineNs = options.deadlineNs;
		this.observed = {
			execs: options.priorExecs ?? 0,
			live: 0,
			receipts: 0,
		};
		// Result retains refusals even when a caller does not await readiness.
		void this.ready.promise.catch(() => this.completed.promise);
		void this.launched.promise.catch(() => this.completed.promise);
		if (
			mode === "watch" &&
			(!Number.isInteger(options.priorExecs) || options.priorExecs < 0 ||
				options.priorExecs > 15 ||
				!nanos.safeParse(options.deadlineNs).success ||
				options.receiptControl !== undefined &&
					!receiptControlIdentity.safeParse(options.receiptControl)
						.success)
		) throw new WindowWatchError("watch_options");
		const args = mode === "clock" ? ["--clock"] : [
			"--watch",
			options.receiptDirectory,
			String(options.priorExecs),
			options.deadlineNs,
			...(options.targetStdio ? ["--stdio-fds"] : []),
			...(options.receiptControl
				? [
					"--receipt-control",
					[
						options.receiptControl.dev,
						options.receiptControl.ino,
						options.receiptControl.uid,
						options.receiptControl.birthSec,
						options.receiptControl.birthNsec,
					].join(" "),
				]
				: []),
			"--",
			options.executable,
			...(options.args ?? []),
		];
		this.peer = (options.transport ?? windowNativeTransport)(
			options.nativePath,
			args,
			options,
		);
		this.startup = setTimeout(() => this.loss("watch_ready_timeout"), 5000);
		this.peer.stdout.on("data", (chunk) => this.read(chunk));
		this.peer.stdin.on("error", () => this.loss("watch_pipe"));
		this.peer.stderr.on("data", () => this.loss("watch_stderr"));
		this.peer.once("error", () => this.loss("watch_transport"));
		this.peer.once("exit", (code, signal) => this.finish(code, signal));
	}

	write(command) {
		if (!this.ended && !this.peer.stdin.destroyed) {
			this.peer.stdin.write(command + "\n");
		}
	}

	stop(originNs) {
		if (
			originNs !== undefined &&
			(typeof originNs !== "bigint" || originNs <= 0n)
		) throw new WindowWatchError("watch_stop_origin");
		if (!this.stopped) {
			this.stopped = true;
			this.write(originNs === undefined ? "STOP" : `STOP ${originNs}`);
			if (!this.ended) {
				this.stopTimer = setTimeout(
					() => this.finish(null, "guard_timeout"),
					5500,
				);
			}
		}
		return this.completed.promise;
	}

	loss(code) {
		this.failed = true;
		this.ready.reject(new WindowWatchError(code));
		this.launched.reject(new WindowWatchError(code));
		for (const entry of this.pending.values()) {
			clearTimeout(entry.timer);
			entry.reject(new WindowWatchError(code));
		}
		this.pending.clear();
		this.stop();
	}

	acceptReady(event) {
		if (this.armed || event.mode !== this.mode) {
			return this.loss("watch_protocol");
		}
		this.armed = true;
		this.lastClockNs = BigInt(event.now_ns);
		if (this.options.onOwnerResource) {
			if (!event.owner) return this.loss("watch_protocol");
			this.resourcePending++;
			this.resources = this.resources.then(() =>
				this.options.onOwnerResource(event.owner)
			).finally(() => {
				this.resourcePending--;
			});
		}
		this.resources.then(() => {
			if (!this.failed && !this.ended) {
				clearTimeout(this.startup);
				this.ready.resolve(event);
			}
		}, () => this.loss("watch_registry_refused"));
	}

	acceptIdentity(event) {
		if (!this.armed || this.mode === "watch" && !this.launchSent) {
			return this.loss("watch_protocol");
		}
		this.rootIdentitySeen = true;
		if (++this.resourcePending > 256) return this.loss("watch_protocol");
		this.resources = this.resources.then(() =>
			this.options.onResource?.(event.identity)
		).finally(() => {
			this.resourcePending--;
		});
		this.resources.catch(() => this.loss("watch_registry_refused"));
	}

	acceptPhase(event) {
		if (!this.armed || !this.launchSent) return this.loss("watch_protocol");
		if (event.phase !== "root-suspended") {
			if (!this.rootPhaseSeen) this.loss("watch_protocol");
			return;
		}
		if (!this.rootIdentitySeen || this.rootPhaseSeen) {
			return this.loss("watch_protocol");
		}
		this.rootPhaseSeen = true;
		this.resources.then(() => {
			if (!this.failed && !this.stopped && !this.ended) {
				this.write("RESUME");
				this.launched.resolve();
			}
		}, () => this.loss("watch_registry_refused"));
	}

	acceptReply(event) {
		const request = this.pending.get(event.id);
		if (!request || request.kind !== event.kind) {
			return this.loss("watch_protocol");
		}
		const nowNs = BigInt(event.now_ns);
		if (nowNs < this.lastClockNs) {
			return this.loss("watch_clock_regression");
		}
		this.lastClockNs = nowNs;
		clearTimeout(request.timer);
		this.pending.delete(event.id);
		switch (event.kind) {
			case "clock":
				return request.resolve(nowNs);
			case "process":
				return request.resolve(event.identity);
			case "signal":
				return request.resolve(event);
		}
	}

	acceptFinal(event) {
		this.final = event;
		if (
			!this.armed || event.execs < this.observed.execs ||
			event.receipts < this.observed.receipts ||
			event.execs > 15 || event.live !== 0 || event.receipts > 16 ||
			!event.cleanup_verified || event.unaccounted > 0 ||
			event.disappearance_ms === null ||
			event.term_ms > 250 || event.kill_ms > 2250 ||
			event.disappearance_ms > 5000
		) this.failed = true;
	}

	consume(input) {
		const parsed = record.safeParse(input);
		if (
			!parsed.success || parsed.data.seq !== this.sequence + 1 ||
			this.final
		) {
			return this.loss("watch_protocol");
		}
		const event = parsed.data;
		this.sequence = event.seq;
		try {
			this.options.onRecord?.(event);
		} catch {
			return this.loss("watch_record_refused");
		}
		switch (event.kind) {
			case "ready":
				return this.acceptReady(event);
			case "identity":
				return this.acceptIdentity(event);
			case "phase":
				return this.acceptPhase(event);
			case "clock":
			case "process":
			case "signal":
				return this.acceptReply(event);
			case "final":
				return this.acceptFinal(event);
			case "loss":
				return this.loss(event.code);
			case "dispatch":
				if (event.latency_ms > (event.signal === "TERM" ? 250 : 2250)) {
					this.loss("watch_timing");
				}
				return;
			case "count":
				if (
					event.execs < this.observed.execs ||
					event.receipts < this.observed.receipts
				) return this.loss("watch_counter_regression");
				this.observed = event;
				if (
					event.execs > 15 || event.live > 16 || event.receipts > 16
				) {
					this.loss("watch_overrun");
				}
		}
	}

	read(chunk) {
		if (
			this.ended ||
			this.failed && !this.final && this.buffer.length > 4096
		) return;
		if (chunk.length > 65536) return this.loss("watch_protocol");
		this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
		if (this.buffer.length > 65536) {
			this.buffer = Buffer.alloc(0);
			return this.loss("watch_protocol");
		}
		let end;
		while ((end = this.buffer.indexOf(10)) !== -1) {
			const line = this.buffer.subarray(0, end);
			this.buffer = this.buffer.subarray(end + 1);
			if (line.length > 4096) {
				this.loss("watch_protocol");
				continue;
			}
			try {
				this.consume(JSON.parse(line.toString("utf8")));
			} catch {
				this.loss("watch_protocol");
			}
		}
		if (this.buffer.length > 4096) this.loss("watch_protocol");
	}

	finish(code, signal) {
		if (this.finished) return;
		this.finished = true;
		this.ended = true;
		clearTimeout(this.startup);
		clearTimeout(this.stopTimer);
		if (!this.final || this.buffer.length || code !== 0 || signal) {
			this.failed = true;
		}
		if (
			!this.final || !this.armed || this.resourcePending ||
			this.pending.size
		) {
			this.loss("watch_lost");
		}
		this.completed.resolve({
			...(this.final ?? {
				...this.observed,
				lower_bound: true,
				unaccounted: 0,
				cleanup_verified: false,
				term_ms: null,
				kill_ms: null,
				disappearance_ms: null,
			}),
			failed: this.failed || this.final?.failed === true,
			stop_batch: this.failed || this.final?.stop_batch === true,
			cleanup_verified: !signal &&
				(this.final?.cleanup_verified ?? false) &&
				this.final?.unaccounted === 0,
		});
	}

	async launch() {
		await this.ready.promise;
		if (
			this.mode !== "watch" || this.launchSent || this.failed ||
			this.stopped
		) {
			throw new WindowWatchError("watch_launch_refused");
		}
		this.launchSent = true;
		this.write("LAUNCH");
		return this.launched.promise;
	}

	async request(kind, command, fields = []) {
		await this.ready.promise;
		if (
			this.failed || this.stopped || this.ended ||
			this.pending.size >= 16 ||
			this.nextId >= 1000000
		) throw new WindowWatchError("watch_clock_refused");
		const request = Promise.withResolvers();
		const id = ++this.nextId;
		const timer = setTimeout(() => this.loss("watch_clock_timeout"), 5000);
		this.pending.set(id, { ...request, timer, kind });
		this.write([command, id, ...fields].join(" "));
		return request.promise;
	}

	async inspect(pid) {
		if (!Number.isSafeInteger(pid) || pid < 2 || pid > 2147483647) {
			throw new WindowWatchError("watch_identity_request");
		}
		return this.request("process", "PID", [pid]);
	}

	async signal(value, signalName) {
		const parsed = identity.safeParse(value);
		if (!parsed.success || !["TERM", "KILL"].includes(signalName)) {
			throw new WindowWatchError("watch_signal_request");
		}
		const owned = parsed.data;
		return this.request("signal", "SIGNAL", [
			owned.pid,
			owned.uid,
			owned.start_sec,
			owned.start_usec,
			signalName === "TERM" ? 15 : 9,
		]);
	}

	async shortenDeadline(value) {
		await this.ready.promise;
		if (
			this.mode !== "watch" || this.failed || this.stopped ||
			this.ended ||
			!nanos.safeParse(value).success ||
			BigInt(value) > BigInt(this.deadlineNs)
		) {
			throw new WindowWatchError("watch_deadline_extension");
		}
		this.deadlineNs = value;
		this.write(`DEADLINE ${value}`);
	}
}

export function createWindowNativeService(mode, options) {
	const session = new WindowNativeSession(mode, options);
	return {
		ready: session.ready.promise,
		result: session.completed.promise,
		targetStdio: session.peer.targetStdio,
		launch: () => session.launch(),
		stop: (originNs) => session.stop(originNs),
		clock: () => session.request("clock", "NOW"),
		inspect: (pid) => session.inspect(pid),
		signal: (identity, signalName) => session.signal(identity, signalName),
		shortenDeadline: (value) => session.shortenDeadline(value),
	};
}
