import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	realpathSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runWindowTool } from "./codex-window-containment.mjs";
import {
	ownedWindowDirectory,
	windowRequire,
} from "./codex-window-conformance.mjs";
import { windowCaseQuotaBytes } from "./codex-window-quota.mjs";
import { createWindowQuotaGuardian } from "./codex-window-quota-owner.mjs";

const script = fileURLToPath(import.meta.url);
const chunkBytes = 1048576;
const half = 33554432;

function writeBounded(target, limit, expectedDev) {
	windowRequire(
		Number.isSafeInteger(limit) && limit > 0 &&
			limit <= windowCaseQuotaBytes + 1,
		"qualification_write_limit",
	);
	ownedWindowDirectory(dirname(target));
	windowRequire(
		lstatSync(dirname(target)).dev === expectedDev,
		"qualification_write_device",
	);
	const fd = openSync(
		target,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
			constants.O_NOFOLLOW,
		0o600,
	);
	const bytes = Buffer.alloc(chunkBytes, 0x5a);
	const deadline = Date.now() + 10000;
	let written = 0, attempted = 0, errorCode = null;
	const quotaError = (error) => {
		if (
			!(error instanceof Error) || !("code" in error) ||
			!["ENOSPC", "EDQUOT"].includes(error.code)
		) throw error;
		errorCode = error.code;
	};
	try {
		windowRequire(
			fstatSync(fd).dev === expectedDev,
			"qualification_write_device",
		);
		while (attempted < limit) {
			windowRequire(
				Date.now() < deadline,
				"qualification_write_deadline",
			);
			const length = Math.min(bytes.length, limit - attempted);
			attempted += length;
			try {
				const count = writeSync(fd, bytes, 0, length);
				windowRequire(count > 0, "qualification_write_stalled");
				written += count;
			} catch (error) {
				quotaError(error);
				break;
			}
		}
		try {
			fsyncSync(fd);
		} catch (error) {
			quotaError(error);
		}
		const stat = fstatSync(fd);
		return {
			written,
			attempted,
			limit,
			errorCode,
			file: {
				dev: stat.dev,
				ino: stat.ino,
				uid: stat.uid,
				mode: stat.mode & 0o777,
				nlink: stat.nlink,
				bytes: stat.size,
			},
		};
	} finally {
		closeSync(fd);
	}
}

async function qualify(out) {
	windowRequire(
		process.platform === "darwin" && process.arch === "arm64" &&
			process.versions.node.startsWith("24.") && process.getuid() !== 0,
		"qualification_runtime_invalid",
	);
	windowRequire(
		resolve(out) === out && realpathSync(dirname(out)) === dirname(out),
		"owned_path_invalid",
	);
	mkdirSync(out, { mode: 0o700 });
	ownedWindowDirectory(out);
	const packet = {
		origin: "local_nonvendor",
		scope: "finite_case_state_quota",
		passed: false,
		actual_target_qualified: false,
		quotaBytes: windowCaseQuotaBytes,
		runtime: process.version,
		uid: process.getuid(),
	};
	const guardian = createWindowQuotaGuardian(out);
	const stop = () => {
		packet.interrupted = true;
		packet.passed = false;
		void guardian.close().catch(() => {
			packet.passed = false;
		});
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
	let quota;
	try {
		quota = await guardian.start();
		if (process.send) {
			await quotaCoordinatorWitness(guardian, quota);
		}
		const descendantRoot = join(quota.caseRoot, "descendant");
		mkdirSync(descendantRoot, { mode: 0o700 });
		packet.before = await quota.verifyWritablePaths([
			quota.caseRoot,
			descendantRoot,
		]);
		packet.parent = writeBounded(
			join(quota.caseRoot, "parent.bin"),
			half,
			packet.before.caseIdentity.dev,
		);
		windowRequire(
			packet.parent.written === half && packet.parent.errorCode === null,
			"qualification_parent_write",
		);
		const descendant = await runWindowTool(realpathSync(process.execPath), [
			script,
			"--quota-writer",
			descendantRoot,
			String(packet.before.caseIdentity.dev),
			"--local-nonvendor",
		], { root: descendantRoot, timeoutMs: 15000 });
		windowRequire(descendant.code === 0, "qualification_descendant_failed");
		packet.descendant = JSON.parse(descendant.stdout);
		windowRequire(
			Number.isSafeInteger(packet.descendant.written) &&
				packet.descendant.written > 0 &&
				packet.descendant.written <= windowCaseQuotaBytes + 1 - half &&
				Number.isSafeInteger(packet.descendant.attempted) &&
				packet.descendant.attempted >= packet.descendant.written &&
				packet.descendant.attempted <=
					windowCaseQuotaBytes + 1 - half &&
				packet.descendant.file.dev === packet.before.caseIdentity.dev &&
				packet.descendant.file.uid === process.getuid() &&
				packet.descendant.file.mode === 0o600 &&
				["ENOSPC", "EDQUOT"].includes(packet.descendant.errorCode),
			"qualification_descendant_write",
		);
		packet.overflow = writeBounded(
			join(quota.caseRoot, "overflow.bin"),
			chunkBytes,
			packet.before.caseIdentity.dev,
		);
		windowRequire(
			["ENOSPC", "EDQUOT"].includes(packet.overflow.errorCode),
			"qualification_overflow_missing",
		);
		packet.totalAttemptedBytes = packet.parent.attempted +
			packet.descendant.attempted + packet.overflow.attempted;
		packet.totalWrittenBytes = packet.parent.written +
			packet.descendant.written + packet.overflow.written;
		windowRequire(
			packet.totalAttemptedBytes <= windowCaseQuotaBytes + 1 + chunkBytes,
			"qualification_attempt_budget",
		);
		packet.after = await quota.verifyWritablePaths([
			quota.caseRoot,
			descendantRoot,
		]);
		const image = lstatSync(quota.imagePath);
		packet.image = {
			dev: image.dev,
			ino: image.ino,
			uid: image.uid,
			mode: image.mode & 0o777,
			nlink: image.nlink,
			fileBytes: image.size,
			allocatedBytes: image.blocks * 512,
		};
		packet.passed = !packet.interrupted;
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		packet.failure = error.message;
	} finally {
		try {
			packet.cleanup = await guardian.close();
		} catch (error) {
			packet.passed = false;
			packet.cleanup = {
				verified: false,
				failure: error instanceof Error
					? error.message
					: "quota_cleanup_unverified",
			};
		}
		process.removeListener("SIGINT", stop);
		process.removeListener("SIGTERM", stop);
		writeFileSync(
			join(out, "qualification.json"),
			JSON.stringify(packet, null, 2) + "\n",
			{ flag: "wx", mode: 0o600 },
		);
	}
	return packet;
}

async function quotaCoordinatorWitness(guardian, quota) {
	const witness = await quota.verifyWritablePaths([quota.caseRoot]);
	await new Promise((resolveWitness, reject) => {
		const finish = (error) => {
			clearTimeout(timer);
			process.removeListener("message", receive);
			process.removeListener("disconnect", disconnected);
			if (error) reject(error);
			else resolveWitness();
		};
		const receive = (input) => {
			if (input && input.kind === "quota-continue") finish();
			else finish(new Error("qualification_witness_protocol"));
		};
		const disconnected = () =>
			finish(new Error("qualification_witness_disconnected"));
		const timer = setTimeout(
			() => finish(new Error("qualification_witness_deadline")),
			15000,
		);
		process.on("message", receive);
		process.once("disconnect", disconnected);
		process.send({
			kind: "quota-mounted",
			coordinator_pid: process.pid,
			owner_pid: guardian.owner.pid,
			image_path: quota.imagePath,
			evidence: witness,
		}, (error) => {
			if (error) finish(error);
		});
	});
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	try {
		if (process.argv.length === 6 && process.argv[2] === "--quota-writer") {
			const target = process.argv[3],
				expectedDev = Number(process.argv[4]);
			windowRequire(
				process.argv[5] === "--local-nonvendor",
				"qualification_opt_in_required",
			);
			process.stdout.write(
				JSON.stringify(
					writeBounded(
						join(target, "fill.bin"),
						windowCaseQuotaBytes + 1 - half,
						expectedDev,
					),
				) + "\n",
			);
		} else {
			windowRequire(
				process.argv.length === 5 &&
					process.argv[2] === "--local-nonvendor" &&
					process.argv[3] === "--out",
				"qualification_opt_in_required",
			);
			const result = await qualify(process.argv[4]);
			process.stdout.write(JSON.stringify(result) + "\n");
			if (!result.passed) process.exitCode = 2;
		}
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		process.stdout.write(
			JSON.stringify({
				passed: false,
				failure: error.message,
				actual_target_qualified: false,
			}) + "\n",
		);
		process.exitCode = 2;
	}
	if (process.connected) process.disconnect();
}
