import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	watch,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { runWindowTool } from "./codex-window-containment.mjs";
import { ownWindowQuota } from "./codex-window-quota-owner.mjs";
import {
	ownedWindowDirectory,
	WindowConformanceError,
	windowRequire,
} from "./codex-window-conformance.mjs";

const script = fileURLToPath(import.meta.url);
const points = [
	"create-begin",
	"create-inflight",
	"create-complete",
	"attach-begin",
	"attach-inflight",
	"attach-complete",
	"state-volume-begin",
	"state-volume-complete",
	"evidence-volume-begin",
	"evidence-volume-complete",
	"remount-begin",
	"mount-begin",
	"mount-inflight",
	"mount-complete",
	"startup-complete",
];
const phaseSchema = z.strictObject({
	kind: z.literal("qualification-phase"),
	phase: z.string(),
});
const cleanupSchema = z.object({
	cleanup: z.object({
		detached: z.literal(true),
		ownedImageDeleted: z.literal(true),
	}).nullable(),
	failure: z.string().nullable(),
	startup_journal: z.object({
		head: z.string(),
		entries: z.number().int().positive(),
	}),
});

function childAt(root, args) {
	return fork(script, args, {
		cwd: root,
		execPath: realpathSync(process.execPath),
		execArgv: [],
		env: {
			PATH: "/usr/bin:/bin",
			HOME: root,
			TMPDIR: root,
			LC_ALL: "C",
			TZ: "UTC",
		},
		stdio: ["ignore", "ignore", "ignore", "ipc"],
	});
}

function cleanupWatch(root) {
	const path = join(root, "quota-owner-cleanup.json");
	let timer, watcher;
	const promise = new Promise((resolveReceipt, reject) => {
		timer = setTimeout(
			() =>
				reject(
					new WindowConformanceError(
						"startup_qualification_deadline",
					),
				),
			180000,
		);
		watcher = watch(root, (_event, name) => {
			if (name === "quota-owner-cleanup.json" && existsSync(path)) {
				try {
					resolveReceipt(
						cleanupSchema.parse(
							JSON.parse(readFileSync(path, "utf8")),
						),
					);
				} catch (error) {
					reject(error);
				}
			}
		});
		watcher.once("error", reject);
	});
	return {
		promise,
		close() {
			clearTimeout(timer);
			watcher?.close();
		},
	};
}

async function noAttachment(root) {
	const info = await runWindowTool("/usr/bin/hdiutil", ["info", "-plist"], {
		root,
		timeoutMs: 5000,
	});
	windowRequire(info.code === 0, "startup_cleanup_unverified");
	const json = await runWindowTool("/usr/bin/plutil", [
		"-convert",
		"json",
		"-o",
		"-",
		"-",
	], {
		root,
		input: info.stdout,
		timeoutMs: 5000,
	});
	windowRequire(json.code === 0, "startup_cleanup_unverified");
	const parsed = z.object({
		images: z.array(z.object({ "image-path": z.string() })).max(64),
	}).parse(JSON.parse(json.stdout));
	return !parsed.images.some((row) =>
		row["image-path"] === join(root, "volume.sparseimage")
	);
}

function verifyJournal(root, reference) {
	const bytes = readFileSync(join(root, "startup-journal.jsonl"), "utf8");
	windowRequire(
		Buffer.byteLength(bytes) <= 524288 && bytes.endsWith("\n"),
		"startup_journal_changed",
	);
	let head = "0".repeat(64), entries = 0;
	const directory = lstatSync(root);
	for (const line of bytes.trimEnd().split("\n")) {
		const row = z.object({
			hash: z.string(),
			previous_hash: z.string(),
			sequence: z.number(),
			root_identity: z.object({ dev: z.number(), ino: z.number() }),
		}).passthrough().parse(JSON.parse(line));
		const { hash, ...entry } = JSON.parse(line);
		windowRequire(
			row.previous_hash === head && row.sequence === ++entries &&
				row.root_identity.dev === directory.dev &&
				row.root_identity.ino === directory.ino &&
				hash ===
					createHash("sha256").update(JSON.stringify(entry)).digest(
						"hex",
					),
			"startup_journal_changed",
		);
		head = hash;
	}
	windowRequire(
		head === reference.head && entries === reference.entries,
		"startup_journal_changed",
	);
	return { head, entries };
}

export async function qualifyWindowStartupLoss(out) {
	windowRequire(
		process.platform === "darwin" && process.arch === "arm64" &&
			process.versions.node.startsWith("24."),
		"qualification_runtime_invalid",
	);
	windowRequire(
		resolve(out) === out && realpathSync(dirname(out)) === dirname(out),
		"owned_path_invalid",
	);
	mkdirSync(out, { mode: 0o700 });
	ownedWindowDirectory(out);
	const cases = [];
	let failure = null;
	for (const point of points) {
		const root = join(out, point);
		mkdirSync(root, { mode: 0o700 });
		const receipt = cleanupWatch(root);
		const coordinator = childAt(root, ["coordinator", root, point]);
		let triggered = false, killedAt;
		const exited = new Promise((resolveExit) =>
			coordinator.once(
				"exit",
				(code, signal) => resolveExit({ code, signal }),
			)
		);
		coordinator.on("message", (input) => {
			const phase = phaseSchema.safeParse(input);
			if (phase.success && phase.data.phase === point && !triggered) {
				triggered = true;
				killedAt = performance.now();
				coordinator.kill("SIGKILL");
			}
		});
		try {
			const cleanup = await receipt.promise;
			const exit = await exited;
			const elapsed = killedAt === undefined
				? null
				: Math.ceil(performance.now() - killedAt);
			const imageAbsent = !existsSync(join(root, "volume.sparseimage"));
			const attachmentAbsent = await noAttachment(root);
			const journal = verifyJournal(root, cleanup.startup_journal);
			const noImageCreated = point === "create-begin" &&
				cleanup.cleanup === null;
			const passed = triggered && imageAbsent && attachmentAbsent &&
				(cleanup.cleanup !== null || noImageCreated) &&
				elapsed !== null && elapsed <= 5000 &&
				cleanup.failure === "quota_owner_lost";
			cases.push({
				phase: point,
				passed,
				coordinator_exit: exit,
				cleanup: cleanup.cleanup,
				no_image_created: noImageCreated,
				image_absent: imageAbsent,
				attachment_absent: attachmentAbsent,
				elapsed_ms: elapsed,
				within_cleanup_budget: elapsed !== null && elapsed <= 5000,
				startup_journal: journal,
				actual_target_qualified: false,
			});
			windowRequire(passed, "startup_cleanup_unverified");
		} catch (error) {
			failure = error instanceof WindowConformanceError
				? error.code
				: "startup_qualification_failed";
			break;
		} finally {
			receipt.close();
			if (
				!triggered && coordinator.exitCode === null &&
				coordinator.signalCode === null
			) coordinator.kill("SIGTERM");
		}
	}
	const packet = {
		origin: "local_nonvendor",
		scope: "coordinator_loss_startup_phases",
		passed: failure === null,
		failure,
		cases,
		actual_target_qualified: false,
	};
	writeFileSync(
		join(out, "qualification.json"),
		JSON.stringify(packet, null, 2) + "\n",
		{ flag: "wx", mode: 0o600 },
	);
	return packet;
}

async function expose(point) {
	if (!process.connected) return;
	await new Promise((resolveLoss) => {
		process.once("disconnect", resolveLoss);
		process.send({ kind: "qualification-phase", phase: point });
	});
}

async function qualificationOwner(root, point) {
	const run = async (command, args, options) => {
		const pending = runWindowTool(command, args, options).then(
			(result) => ({ result }),
			(error) => ({ error }),
		);
		const phase = command === "/usr/bin/hdiutil"
			? args[0] === "create"
				? "create-inflight"
				: args[0] === "attach"
				? args.includes("-nomount")
					? "attach-inflight"
					: "mount-inflight"
				: null
			: null;
		if (phase === point) await expose(point);
		const settled = await pending;
		if ("error" in settled) throw settled.error;
		return settled.result;
	};
	return ownWindowQuota(root, process, {
		run,
		async onPhase(phase) {
			if (phase === point) await expose(point);
		},
	});
}

function qualificationCoordinator(root, point) {
	const owner = childAt(root, ["owner", root, point]);
	process.once("disconnect", () => {
		if (owner.connected) owner.disconnect();
	});
	owner.on("message", (input) => {
		const created = z.object({ kind: z.literal("created") }).safeParse(
			input,
		);
		if (created.success && owner.connected) {
			owner.send({ kind: "authorize-attach" });
		}
		const phase = phaseSchema.safeParse(input);
		if (phase.success && process.connected) process.send(phase.data);
	});
	owner.once("exit", () => {
		if (process.connected) process.disconnect();
	});
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	try {
		const [, , command, root, point] = process.argv;
		if (command === "owner" && process.send) {
			const result = await qualificationOwner(root, point);
			if (result.failure) process.exitCode = 2;
		} else if (command === "coordinator" && process.send) {
			qualificationCoordinator(root, point);
		} else if (command === "qualify" && root && process.argv.length === 4) {
			const result = await qualifyWindowStartupLoss(root);
			process.stdout.write(JSON.stringify(result) + "\n");
			if (!result.passed) process.exitCode = 2;
		} else process.exitCode = 2;
	} catch (error) {
		process.stdout.write(
			JSON.stringify({
				passed: false,
				code: error instanceof WindowConformanceError
					? error.code
					: "startup_qualification_failed",
			}) + "\n",
		);
		process.exitCode = 2;
	}
}
