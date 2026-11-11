import { execFile, fork } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { runWindowTool } from "./codex-window-containment.mjs";
import { createWindowQuotaGuardian } from "./codex-window-quota-owner.mjs";
import {
	ownedWindowDirectory,
	WindowConformanceError,
	windowRequire,
} from "./codex-window-conformance.mjs";

const script = fileURLToPath(import.meta.url);
const recoveryScript = join(
	dirname(script),
	"codex-window-quota-recovery.mjs",
);

async function attached(root) {
	const info = await runWindowTool("/usr/bin/hdiutil", ["info", "-plist"], {
		root,
		timeoutMs: 15000,
	});
	windowRequire(info.code === 0, "recovery_qualification_unverified");
	const json = await runWindowTool("/usr/bin/plutil", [
		"-convert",
		"json",
		"-o",
		"-",
		"-",
	], { root, input: info.stdout, timeoutMs: 15000 });
	windowRequire(json.code === 0, "recovery_qualification_unverified");
	const parsed = z.object({
		images: z.array(z.object({ "image-path": z.string() })).max(64),
	}).parse(JSON.parse(json.stdout));
	return parsed.images.some((row) =>
		row["image-path"] === join(root, "volume.sparseimage")
	);
}

function alive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		if (
			error instanceof Error && "code" in error && error.code === "ESRCH"
		) return false;
		throw error;
	}
}

const bounded = (promise, code, ms = 60000) => {
	let timer;
	return Promise.race([
		promise,
		new Promise((_resolve, reject) => {
			timer = setTimeout(
				() => reject(new WindowConformanceError(code)),
				ms,
			);
		}),
	]).finally(() => clearTimeout(timer));
};

// The guardian dies while this coordinator lives: the coordinator itself must recover.
async function guardianKilled(root) {
	const guardian = createWindowQuotaGuardian(root);
	await bounded(guardian.start(), "recovery_start_deadline", 120000);
	const owner = guardian.owner.pid;
	const imageBefore = existsSync(join(root, "volume.sparseimage"));
	const attachedBefore = await attached(root);
	const killedAt = performance.now();
	process.kill(owner, "SIGKILL");
	const closed = await bounded(guardian.closed, "recovery_deadline");
	const elapsed = Math.ceil(performance.now() - killedAt);
	return {
		scenario: "guardian_killed_coordinator_alive",
		image_before: imageBefore,
		attached_before: attachedBefore,
		closed,
		elapsed_ms: elapsed,
		owner_absent: !alive(owner),
		image_absent: !existsSync(join(root, "volume.sparseimage")),
		attachment_absent: !(await attached(root)),
		passed: imageBefore && attachedBefore && !alive(owner) &&
			closed.recovery?.recovered === true &&
			closed.cleanup?.detached === true &&
			closed.cleanup?.ownedImageDeleted === true &&
			closed.failure !== null &&
			!existsSync(join(root, "volume.sparseimage")) &&
			!(await attached(root)) && elapsed <= 30000,
	};
}

async function standaloneRecover(root) {
	return new Promise((resolveRun) => {
		execFile(
			realpathSync(process.execPath),
			[recoveryScript, "recover", root],
			{
				cwd: root,
				env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" },
				timeout: 60000,
			},
			(error, stdout) =>
				resolveRun({
					exit: error && typeof error.code === "number"
						? error.code
						: error
						? -1
						: 0,
					packet: stdout.trim() ? JSON.parse(stdout) : null,
				}),
		);
	});
}

// Both the coordinator and the guardian die: only `recover` remains.
async function bothKilled(root) {
	const coordinator = fork(script, ["coordinator", root], {
		cwd: root,
		execPath: realpathSync(process.execPath),
		execArgv: [],
		env: { PATH: "/usr/bin:/bin", HOME: root, TMPDIR: root, LC_ALL: "C" },
		stdio: ["ignore", "ignore", "ignore", "ipc"],
	});
	const exited = new Promise((done) =>
		coordinator.once("exit", (code, signal) => done({ code, signal }))
	);
	const ready = await bounded(
		new Promise((resolveReady, reject) => {
			coordinator.on("message", (input) => {
				const parsed = z.strictObject({
					kind: z.literal("ready"),
					owner: z.number().int().positive(),
				}).safeParse(input);
				if (parsed.success) resolveReady(parsed.data);
			});
			coordinator.once("error", reject);
		}),
		"recovery_start_deadline",
		120000,
	);
	// Freeze the guardian first so it cannot react to the coordinator's death.
	process.kill(ready.owner, "SIGSTOP");
	coordinator.kill("SIGKILL");
	const coordinatorExit = await bounded(exited, "recovery_deadline");
	process.kill(ready.owner, "SIGKILL");
	const imageBefore = existsSync(join(root, "volume.sparseimage"));
	const attachedBefore = await attached(root);
	const ownerGone = await bounded(
		new Promise((done) => {
			const poll = setInterval(() => {
				if (!alive(ready.owner)) {
					clearInterval(poll);
					done(true);
				}
			}, 25);
		}),
		"recovery_deadline",
	);
	const startedAt = performance.now();
	const run = await standaloneRecover(root);
	const elapsed = Math.ceil(performance.now() - startedAt);
	return {
		scenario: "coordinator_and_guardian_killed_standalone_recover",
		coordinator_exit: coordinatorExit,
		owner_absent: ownerGone,
		image_before: imageBefore,
		attached_before: attachedBefore,
		recover: run,
		elapsed_ms: elapsed,
		image_absent: !existsSync(join(root, "volume.sparseimage")),
		attachment_absent: !(await attached(root)),
		receipt_written: existsSync(join(root, "startup-recovery.json")),
		passed: imageBefore && attachedBefore && ownerGone &&
			coordinatorExit.signal === "SIGKILL" && run.exit === 0 &&
			run.packet?.recovered === true && run.packet.detached === true &&
			run.packet.image_deleted === true &&
			!existsSync(join(root, "volume.sparseimage")) &&
			!(await attached(root)) &&
			existsSync(join(root, "startup-recovery.json")) &&
			elapsed <= 60000,
	};
}

export async function qualifyWindowQuotaRecovery(out) {
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
	for (
		const [name, run] of [
			["guardian-killed", guardianKilled],
			["both-killed", bothKilled],
		]
	) {
		const root = join(out, name);
		mkdirSync(root, { mode: 0o700 });
		try {
			const outcome = await run(root);
			cases.push(outcome);
			windowRequire(outcome.passed, "recovery_unverified");
		} catch (error) {
			failure = error instanceof WindowConformanceError
				? error.code
				: "recovery_qualification_failed";
			break;
		}
	}
	const packet = {
		origin: "local_nonvendor",
		scope: "guardian_loss_recovery_from_journal",
		passed: failure === null && cases.length === 2,
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

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	if (process.argv[2] === "coordinator" && process.send) {
		const guardian = createWindowQuotaGuardian(process.argv[3]);
		await guardian.start();
		process.send({ kind: "ready", owner: guardian.owner.pid });
		setInterval(() => undefined, 1000);
	} else {
		try {
			windowRequire(
				process.argv.length === 4 && process.argv[2] === "qualify",
				"qualification_arguments_invalid",
			);
			const packet = await qualifyWindowQuotaRecovery(process.argv[3]);
			process.stdout.write(JSON.stringify(packet) + "\n");
			if (!packet.passed) process.exitCode = 2;
		} catch (error) {
			process.stdout.write(
				JSON.stringify({
					passed: false,
					code: error instanceof WindowConformanceError
						? error.code
						: "recovery_qualification_failed",
				}) + "\n",
			);
			process.exitCode = 2;
		}
	}
}
