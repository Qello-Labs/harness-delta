import { fork } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import {
	createOwnedWindowImage,
	detachOwnedWindowImage,
	windowImageIdentity,
} from "./codex-window-containment.mjs";
import {
	ownedWindowDirectory,
	WindowConformanceError,
	windowRequire,
} from "./codex-window-conformance.mjs";

const script = fileURLToPath(import.meta.url);
const identitySchema = z.strictObject({
	root_dev: z.number().int(),
	root_ino: z.number().int(),
	image_dev: z.number().int(),
	image_ino: z.number().int(),
});
const messageSchema = z.discriminatedUnion("kind", [
	z.strictObject({ kind: z.literal("ready") }),
	z.strictObject({ kind: z.literal("created"), record: identitySchema }),
	z.strictObject({ kind: z.literal("mounted") }),
	z.strictObject({ kind: z.literal("closed"), detached: z.boolean() }),
]);

function wireImageOwner(child, root, state, events, ready, closed, recover) {
	const fail = (code) => {
		state.failure ??= code;
		ready.reject(new WindowConformanceError(code));
		if (child.connected) child.send({ kind: "stop" });
	};
	child.on("message", (input) => {
		const parsed = messageSchema.safeParse(input);
		if (!parsed.success) {
			fail("image_owner_protocol");
			return;
		}
		const message = parsed.data;
		try {
			switch (message.kind) {
				case "ready":
					windowRequire(!state.booted, "image_owner_protocol");
					state.booted = true;
					child.send({
						kind: "start",
						root,
						deadline: state.authorizedDeadline,
					});
					break;
				case "created": {
					windowRequire(
						state.booted && !state.record,
						"image_owner_protocol",
					);
					const actual = windowImageIdentity(root);
					windowRequire(
						Object.keys(actual).every((key) =>
							actual[key] === message.record[key]
						),
						"image_ownership_unverified",
					);
					state.record = actual;
					state.attachAuthorized = true;
					child.send({ kind: "authorize-attach" });
					break;
				}
				case "mounted":
					windowRequire(
						state.attachAuthorized && !state.mounted &&
							Date.now() < state.authorizedDeadline,
						"image_owner_protocol",
					);
					state.mounted = true;
					clearTimeout(state.timer);
					state.timer = setTimeout(() => {
						state.failure = "image_owner_deadline";
						child.kill("SIGKILL");
					}, state.authorizedDeadline - Date.now());
					ready.resolve();
					events.emit("mounted");
					break;
				case "closed":
					state.ownerDetached = message.detached;
					break;
			}
		} catch (error) {
			fail(
				error instanceof WindowConformanceError
					? error.code
					: "image_owner_protocol",
			);
		}
	});
	child.once("error", () => fail("image_owner_unavailable"));
	child.once("disconnect", () => {
		if (!state.closeRequested && !state.lossReported) {
			state.lossReported = true;
			events.emit("owner_lost");
		}
		state.deadline ??= Date.now() + 5000;
		clearTimeout(state.timer);
		state.timer = setTimeout(
			() => child.kill("SIGKILL"),
			Math.max(1, state.deadline - Date.now()),
		);
	});
	// A disconnected fork can emit exit without close; no stdio payload is consumed here.
	child.once("exit", () => {
		clearTimeout(state.timer);
		if (!state.closeRequested && !state.lossReported) {
			state.lossReported = true;
			events.emit("owner_lost");
		}
		void (async () => {
			try {
				windowRequire(
					state.record,
					state.failure ?? "image_cleanup_unverified",
				);
				const result = await recover(
					root,
					state.record,
					state.deadline ?? Date.now() + 5000,
				);
				// A recorded image can be detached positively before its mount was acknowledged.
				windowRequire(
					result.detached,
					"image_cleanup_unverified",
				);
				state.detached = true;
			} catch (error) {
				state.failure ??= error instanceof WindowConformanceError
					? error.code
					: "image_cleanup_unverified";
			}
			if (!state.mounted) {
				ready.reject(
					new WindowConformanceError(
						state.failure ?? "image_owner_unavailable",
					),
				);
			}
			closed.resolve({
				detached: state.detached,
				code: state.failure ?? null,
			});
			events.emit("closed");
		})();
	});
}

export function createWindowImageGuardian(root, options = {}) {
	ownedWindowDirectory(root);
	const authorizedDeadline = options.deadline ?? Date.now() + 600000;
	windowRequire(
		Number.isSafeInteger(authorizedDeadline) &&
			authorizedDeadline > Date.now() &&
			authorizedDeadline <= Date.now() + 1200000,
		"image_owner_deadline_invalid",
	);
	const events = new EventEmitter();
	const ready = Promise.withResolvers();
	const closed = Promise.withResolvers();
	const state = {
		booted: false,
		attachAuthorized: false,
		mounted: false,
		detached: false,
		authorizedDeadline,
	};
	const opensslConf = join(root, "owner-openssl.cnf");
	writeFileSync(opensslConf, "", { flag: "wx", mode: 0o600 });
	let child;
	const recover = options.recover ??
		((ownedRoot, identity, deadline) =>
			detachOwnedWindowImage(ownedRoot, identity, { deadline }));
	return Object.freeze({
		events,
		closed: closed.promise,
		get owner() {
			return child;
		},
		async start() {
			windowRequire(!child, "reservation_reused");
			child = options.launch
				? options.launch(root)
				: fork(script, ["own-image"], {
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
			wireImageOwner(child, root, state, events, ready, closed, recover);
			state.timer = setTimeout(() => {
				if (state.mounted) return;
				state.failure = "image_owner_startup_deadline";
				ready.reject(new WindowConformanceError(state.failure));
				child.kill("SIGKILL");
			}, Math.min(60000, authorizedDeadline - Date.now()));
			await ready.promise;
			return {
				imagePath: join(root, "volume.sparseimage"),
				mountPath: join(root, "mount"),
			};
		},
		async close() {
			if (!child) return;
			state.closeRequested = true;
			state.deadline ??= Date.now() + 5000;
			clearTimeout(state.timer);
			state.timer = setTimeout(
				() => child.kill("SIGKILL"),
				Math.max(1, state.deadline - Date.now()),
			);
			if (child.connected) child.send({ kind: "stop" });
			const result = await closed.promise;
			clearTimeout(state.timer);
			windowRequire(
				result.detached,
				result.code ?? "image_cleanup_unverified",
			);
		},
		summary() {
			return { detached: state.detached, code: state.failure ?? null };
		},
	});
}

async function sendOwnerMessage(message) {
	if (!process.connected) return;
	await new Promise((resolveSent, reject) =>
		process.send(message, (error) => error ? reject(error) : resolveSent())
	);
}

async function ownImage() {
	const start = Promise.withResolvers();
	const attach = Promise.withResolvers();
	const stop = Promise.withResolvers();
	const controller = new AbortController();
	let image, root, started = false, stopping = false;
	const lost = () => {
		controller.abort();
		start.resolve();
		attach.resolve();
		stop.resolve();
	};
	process.once("disconnect", lost);
	process.once("SIGTERM", lost);
	process.on("message", (input) => {
		const parsed = z.object({
			kind: z.enum(["start", "authorize-attach", "stop"]),
			root: z.string().optional(),
			deadline: z.number().int().optional(),
		}).safeParse(input);
		if (!parsed.success) {
			lost();
			return;
		}
		const message = parsed.data;
		if (
			message.kind === "start" && !started && message.root &&
			message.deadline > Date.now() &&
			message.deadline <= Date.now() + 1200000
		) {
			started = true;
			root = message.root;
			clearTimeout(timer);
			timer = setTimeout(lost, message.deadline - Date.now());
			start.resolve();
		} else if (message.kind === "authorize-attach") attach.resolve();
		else if (message.kind === "stop") {
			stopping = true;
			start.resolve();
			stop.resolve();
		} else lost();
	});
	let timer = setTimeout(lost, 60000);
	try {
		await sendOwnerMessage({ kind: "ready" });
		await start.promise;
		windowRequire(
			root && !stopping && !controller.signal.aborted,
			"image_owner_lost",
		);
		image = await createOwnedWindowImage(root, {
			signal: controller.signal,
			async onCreated(record) {
				await sendOwnerMessage({ kind: "created", record });
				await Promise.race([attach.promise, stop.promise]);
				windowRequire(
					!stopping && !controller.signal.aborted &&
						process.connected,
					"image_owner_lost",
				);
			},
		});
		await sendOwnerMessage({ kind: "mounted" });
		await stop.promise;
	} finally {
		clearTimeout(timer);
		try {
			if (image) await image.close();
			const detached = image?.summary().detached === true;
			if (root) {
				writeFileSync(
					join(root, "owner-cleanup.pending"),
					JSON.stringify({
						detached,
						actual_target_qualified: false,
					}),
					{ flag: "wx", mode: 0o600 },
				);
				renameSync(
					join(root, "owner-cleanup.pending"),
					join(root, "owner-cleanup.json"),
				);
			}
			await sendOwnerMessage({ kind: "closed", detached });
		} finally {
			if (process.connected) process.disconnect();
		}
	}
}

export async function qualifyWindowImageLoss(out) {
	windowRequire(
		process.platform === "darwin" && process.arch === "arm64" &&
			process.versions.node.startsWith("24."),
		"qualification_runtime_invalid",
	);
	windowRequire(
		isAbsolute(out) && resolve(out) === out &&
			realpathSync(dirname(out)) === dirname(out),
		"owned_path_invalid",
	);
	mkdirSync(out, { mode: 0o700 });
	ownedWindowDirectory(out);
	const cases = [];
	for (const fault of ["normal", "control_eof", "owner_sigkill"]) {
		const root = join(out, fault);
		mkdirSync(root, { mode: 0o700 });
		const guardian = createWindowImageGuardian(root);
		try {
			await guardian.start();
			const started = performance.now();
			if (fault === "control_eof") guardian.owner.disconnect();
			else if (fault === "owner_sigkill") guardian.owner.kill("SIGKILL");
			else await guardian.close();
			const closed = await guardian.closed;
			const elapsed = Math.ceil(performance.now() - started);
			cases.push({
				fault,
				detached: closed.detached,
				elapsed_ms: elapsed,
				within_cleanup_budget: elapsed <= 5000,
				actual_target_qualified: false,
			});
			windowRequire(
				closed.detached && elapsed <= 5000,
				"image_cleanup_unverified",
			);
		} finally {
			await guardian.close();
		}
	}
	const packet = {
		schema_version: 1,
		origin: "local_nonvendor",
		scope: "post_attach_image_loss",
		passed: cases.every((row) => row.detached && row.within_cleanup_budget),
		actual_target_qualified: false,
		cases,
	};
	writeFileSync(
		join(out, "loss-qualification.json"),
		JSON.stringify(packet, null, 2) + "\n",
		{ flag: "wx", mode: 0o600 },
	);
	return packet;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	if (
		process.argv[2] === "qualify-loss" && process.argv.length === 5 &&
		process.argv[3] === "--out"
	) {
		try {
			const packet = await qualifyWindowImageLoss(process.argv[4]);
			process.stdout.write(
				JSON.stringify({
					passed: packet.passed,
					actual_target_qualified: false,
					cases: packet.cases,
				}) + "\n",
			);
			if (!packet.passed) process.exitCode = 2;
		} catch (error) {
			process.stdout.write(
				JSON.stringify({
					passed: false,
					code: error instanceof WindowConformanceError
						? error.code
						: "image_loss_qualification_failed",
					actual_target_qualified: false,
				}) + "\n",
			);
			process.exitCode = 2;
		}
	} else if (process.argv[2] === "own-image" && process.send) {
		try {
			await ownImage();
		} catch {
			process.exitCode = 2;
		}
	} else process.exitCode = 2;
}
