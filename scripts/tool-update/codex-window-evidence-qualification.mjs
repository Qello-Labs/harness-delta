import {
	closeSync,
	existsSync,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	realpathSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createWindowQuotaGuardian } from "./codex-window-quota-owner.mjs";
import {
	windowCaseQuotaBytes,
	windowOverheadBytes,
} from "./codex-window-quota.mjs";
import {
	ownedWindowDirectory,
	WindowConformanceError,
	windowRequire,
} from "./codex-window-conformance.mjs";

function fillEvidence(root) {
	const path = join(root, "quota-fill.bin");
	const fd = openSync(path, "wx", 0o600);
	const chunk = Buffer.alloc(1048576, 0x5a);
	let bytes = 0, quotaError = null;
	try {
		while (bytes <= windowCaseQuotaBytes) {
			try {
				bytes += writeSync(fd, chunk);
			} catch (error) {
				if (
					error instanceof Error && "code" in error &&
					["ENOSPC", "EDQUOT"].includes(error.code)
				) {
					quotaError = error.code;
					break;
				}
				throw error;
			}
		}
	} finally {
		closeSync(fd);
	}
	windowRequire(
		quotaError && bytes <= windowCaseQuotaBytes,
		"evidence_quota_not_enforced",
	);
	return { bytes, quota_error: quotaError };
}

function overheadWitness(root, amount) {
	const path = join(root, "guard-overhead.bin");
	const fd = openSync(path, "wx", 0o600);
	let identity;
	try {
		const chunk = Buffer.alloc(1048576, 0x47);
		let bytes = 0;
		while (bytes < amount) {
			bytes += writeSync(
				fd,
				chunk,
				0,
				Math.min(chunk.length, amount - bytes),
			);
		}
		identity = fstatSync(fd);
	} finally {
		closeSync(fd);
	}
	return () => {
		const current = lstatSync(path);
		windowRequire(
			current.dev === identity.dev && current.ino === identity.ino &&
				current.uid === process.getuid() && current.nlink === 1 &&
				current.isFile(),
			"quota_ownership_unverified",
		);
		unlinkSync(path);
		windowRequire(!existsSync(path), "quota_cleanup_unverified");
	};
}

async function boundedClosure(promise) {
	let timer;
	try {
		return await Promise.race([
			promise,
			new Promise((_resolve, reject) => {
				timer = setTimeout(
					() =>
						reject(
							new WindowConformanceError(
								"evidence_cleanup_deadline",
							),
						),
					5000,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

export async function qualifyWindowEvidence(out) {
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
	const root = join(out, "owned-quota");
	mkdirSync(root, { mode: 0o700 });
	const guardian = createWindowQuotaGuardian(root);
	const packet = {
		origin: "local_nonvendor",
		scope: "evidence_quota_and_measured_guard_overhead",
		evidence_quota_bytes: windowCaseQuotaBytes,
		overhead_limit_bytes: windowOverheadBytes,
		passed: false,
		failure: null,
		actual_target_qualified: false,
	};
	let cleanupWitness;
	try {
		const quota = await guardian.start();
		packet.startup_journal = quota.startupJournal;
		packet.volume_evidence = await quota.verifyWritablePaths([
			quota.caseRoot,
		]);
		packet.writer = await quota.writeEvidence(
			"numeric.json",
			Buffer.from('{"count":1}\n'),
		);
		packet.evidence_fill = fillEvidence(quota.evidenceRoot);
		packet.after_fill = await quota.measureOverhead();
		const witnessBytes =
			Math.ceil(
				(windowOverheadBytes - packet.after_fill.chargedBytes + 4096) /
					4096,
			) * 4096;
		const closed = boundedClosure(guardian.closed);
		cleanupWitness = overheadWitness(root, witnessBytes);
		const measurement = await quota.measureOverhead().then(
			(result) => ({ result, rejected: false }),
			() => ({ result: null, rejected: true }),
		);
		const closure = await closed;
		packet.overhead_witness_bytes = witnessBytes;
		packet.hard_stop = {
			request_rejected: measurement.rejected,
			failure: closure.failure,
			cleanup: closure.cleanup,
		};
		packet.cleanup = closure;
		packet.passed = measurement.rejected &&
			closure.failure === "quota_overhead_exceeded" &&
			closure.cleanup?.detached === true &&
			closure.cleanup?.ownedImageDeleted === true &&
			!existsSync(quota.imagePath);
		windowRequire(packet.passed, "evidence_overhead_stop_unverified");
	} catch (error) {
		packet.failure = error instanceof WindowConformanceError
			? error.code
			: "evidence_qualification_failed";
		try {
			await guardian.close();
			packet.cleanup = await guardian.closed;
		} catch (cleanupError) {
			packet.cleanup_failure =
				cleanupError instanceof WindowConformanceError
					? cleanupError.code
					: "quota_cleanup_unverified";
			packet.cleanup = await guardian.closed;
		}
	} finally {
		if (cleanupWitness) {
			try {
				cleanupWitness();
				packet.guard_witness_deleted = true;
			} catch (error) {
				packet.passed = false;
				packet.failure = error instanceof WindowConformanceError
					? error.code
					: "quota_cleanup_unverified";
			}
		}
		writeFileSync(
			join(out, "qualification.json"),
			JSON.stringify(packet, null, 2) + "\n",
			{ flag: "wx", mode: 0o600 },
		);
	}
	return packet;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	try {
		if (process.argv[2] !== "qualify" || process.argv.length !== 4) {
			throw new WindowConformanceError("qualification_arguments_invalid");
		}
		const packet = await qualifyWindowEvidence(process.argv[3]);
		process.stdout.write(JSON.stringify(packet) + "\n");
		if (!packet.passed) process.exitCode = 2;
	} catch (error) {
		process.stdout.write(
			JSON.stringify({
				passed: false,
				code: error instanceof WindowConformanceError
					? error.code
					: "evidence_qualification_failed",
			}) + "\n",
		);
		process.exitCode = 2;
	}
}
