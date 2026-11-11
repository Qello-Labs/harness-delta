import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	realpathSync,
	statfsSync,
	statSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import {
	ownedWindowDirectory,
	WindowConformanceError,
	windowRequire,
} from "./codex-window-conformance.mjs";

export const windowVolumeBytes = 4294967296;
export const windowGuardOverheadBytes = 134217728;
const absolutePath = z.string().max(4096).refine((path) =>
	isAbsolute(path) && resolve(path) === path && !/[\0\r\n]/.test(path)
);
const profileInput = z.strictObject({
	caseRoots: z.array(absolutePath).min(1).max(8),
	vendorPrefix: absolutePath,
	runtimePaths: z.array(absolutePath).min(1).max(64),
	runtimeLinks: z.array(absolutePath).max(128).default([]),
	executables: z.array(absolutePath).min(1).max(2),
	port: z.number().int().min(1).max(65535),
	home: absolutePath,
});

export function buildWindowSandboxProfile(input) {
	const parsed = profileInput.safeParse(input);
	windowRequire(parsed.success, "containment_input_invalid");
	const policy = parsed.data;
	const vendorExecutables = ["codex", "codex-code-mode-host"].map((name) =>
		join(
			policy.vendorPrefix,
			"node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin",
			name,
		)
	);
	windowRequire(
		policy.executables.every((path) => vendorExecutables.includes(path)),
		"containment_exec_unapproved",
	);
	const systemReads = [
		"/System/Library",
		"/System/Volumes/Preboot/Cryptexes/OS",
		"/usr/lib",
		"/private/var/db/dyld",
	];
	const readPaths = [
		...new Set([
			...policy.caseRoots,
			policy.vendorPrefix,
			...systemReads,
		]),
	].sort();
	const literalReads = [
		...new Set([
			...policy.runtimePaths,
			...policy.executables,
		]),
	].sort();
	const ancestors = new Set();
	for (
		const path of [...readPaths, ...literalReads, ...policy.runtimeLinks]
	) {
		for (let parent = dirname(path);; parent = dirname(parent)) {
			ancestors.add(parent);
			if (parent === dirname(parent)) break;
		}
	}
	const literal = (path) => `(literal ${JSON.stringify(path)})`;
	const subpath = (path) => `(subpath ${JSON.stringify(path)})`;
	const denyUnselected = (operation, allowed) => {
		const filter = allowed.length
			? `(require-all ${
				subpath(policy.vendorPrefix)
			} (require-not (require-any ${allowed.map(literal).join(" ")})))`
			: subpath(policy.vendorPrefix);
		return `(deny ${operation} ${filter})`;
	};
	const selectedVendor = policy.executables;
	const bytes = [
		"(version 1)",
		"(deny default)",
		"(allow process-fork)",
		`(allow process-exec ${policy.executables.map(literal).join(" ")})`,
		denyUnselected("process-exec", selectedVendor),
		"(allow sysctl-read)",
		"(allow process-info* (target self))",
		`(allow file-read-metadata ${
			[...ancestors].sort().map(literal).join(" ")
		})`,
		`(allow file-read* ${readPaths.map(subpath).join(" ")} ${
			[...literalReads, ...policy.runtimeLinks].map(literal).join(" ")
		})`,
		`(allow file-map-executable ${systemReads.map(subpath).join(" ")} ${
			literalReads.map(literal).join(" ")
		})`,
		denyUnselected("file-map-executable", selectedVendor),
		`(deny file-map-executable ${policy.caseRoots.map(subpath).join(" ")})`,
		'(allow file-read-data (literal "/") (literal "/dev/urandom") (literal "/dev/random"))',
		`(allow file-write* ${policy.caseRoots.map(subpath).join(" ")})`,
		`(allow network-outbound (remote tcp4 "localhost:${policy.port}"))`,
		`(deny file-read* ${
			[".codex", ".claude", "Library/Keychains"].map((path) =>
				subpath(join(policy.home, path))
			).join(" ")
		})`,
		"(deny mach-lookup)",
		"(deny mach-register)",
		"",
	].join("\n");
	windowRequire(
		Buffer.byteLength(bytes) <= 32768,
		"containment_input_invalid",
	);
	return Object.freeze({
		bytes,
		sha256: createHash("sha256").update(bytes).digest("hex"),
	});
}

export function runWindowTool(command, args, options = {}) {
	return new Promise((resolveResult, reject) => {
		const child = spawn(command, args, {
			cwd: options.root,
			env: {
				PATH: "/usr/bin:/bin",
				LC_ALL: "C",
				TZ: "UTC",
				HOME: options.root ?? "/",
				TMPDIR: options.root ?? "/private/tmp",
				...(options.opensslConf
					? { OPENSSL_CONF: options.opensslConf }
					: {}),
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		const chunks = [];
		let size = 0, failure;
		const stop = (code) => {
			failure ??= code;
			child.kill("SIGKILL");
		};
		const timer = setTimeout(
			() => stop("local_tool_deadline"),
			options.timeoutMs ?? 60000,
		);
		const abort = () => stop("local_tool_cancelled");
		options.signal?.addEventListener("abort", abort, { once: true });
		if (options.signal?.aborted) abort();
		child.stdout.on("data", (bytes) => {
			size += bytes.length;
			if (size > 131072) stop("local_tool_output_limit");
			else chunks.push(bytes);
		});
		child.stderr.resume();
		child.stdin.on("error", () => stop("local_tool_input_failed"));
		child.once("error", () => {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
			reject(new WindowConformanceError("local_tool_unavailable"));
		});
		child.once("close", (code) => {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", abort);
			if (failure) reject(new WindowConformanceError(failure));
			else {resolveResult({
					code,
					stdout: Buffer.concat(chunks).toString("utf8"),
				});}
		});
		child.stdin.end(options.input);
	});
}

async function plistJson(run, args, root) {
	const result = await run("/usr/bin/hdiutil", args, {
		root,
		timeoutMs: 10000,
	});
	windowRequire(result.code === 0, "image_inspection_failed");
	const converted = await run("/usr/bin/plutil", [
		"-convert",
		"json",
		"-o",
		"-",
		"-",
	], { root, input: result.stdout, timeoutMs: 10000 });
	windowRequire(converted.code === 0, "image_inspection_failed");
	return JSON.parse(converted.stdout);
}

async function inspectImage(root, run) {
	const imagePath = join(root, "volume.sparseimage");
	const mountPath = join(root, "mount");
	const info = await plistJson(run, ["info", "-plist"], root);
	windowRequire(
		Array.isArray(info.images) && info.images.length <= 64,
		"image_inspection_failed",
	);
	const images = info.images.filter((row) => row["image-path"] === imagePath);
	const onOtherDevice = statSync(mountPath).dev !== statSync(root).dev;
	if (!images.length) {
		return {
			mounted: onOtherDevice,
			owned: !onOtherDevice,
			capacityBytes: 0,
		};
	}
	windowRequire(
		images.length === 1 && Array.isArray(images[0]["system-entities"]),
		"image_inspection_failed",
	);
	const owned = images[0]["system-entities"].some((row) =>
		row["mount-point"] === mountPath
	);
	const stat = statfsSync(mountPath, { bigint: true });
	return {
		mounted: onOtherDevice,
		owned,
		capacityBytes: Number(stat.bsize * stat.blocks),
	};
}

export function windowImageIdentity(root) {
	ownedWindowDirectory(root);
	const directory = lstatSync(root);
	const image = lstatSync(join(root, "volume.sparseimage"));
	windowRequire(
		image.isFile() && !image.isSymbolicLink() &&
			image.uid === process.getuid() &&
			(image.mode & 0o777) === 0o600 && image.nlink === 1,
		"image_ownership_unverified",
	);
	return Object.freeze({
		root_dev: directory.dev,
		root_ino: directory.ino,
		image_dev: image.dev,
		image_ino: image.ino,
	});
}

export async function detachOwnedWindowImage(root, identity, options = {}) {
	const current = windowImageIdentity(root);
	windowRequire(
		Object.keys(current).every((key) => current[key] === identity[key]),
		"image_ownership_unverified",
	);
	const run = options.run ?? runWindowTool;
	const deadline = options.deadline ?? Date.now() + 5000;
	const boundedRun = (command, args, settings) => {
		const remaining = deadline - Date.now();
		windowRequire(remaining > 0, "image_cleanup_unverified");
		return run(command, args, {
			...settings,
			timeoutMs: Math.min(settings.timeoutMs ?? 5000, remaining),
		});
	};
	const inspect = options.inspect ?? (() => inspectImage(root, boundedRun));
	const before = await inspect();
	windowRequire(before.owned, "image_ownership_unverified");
	if (before.mounted) {
		const result = await boundedRun("/usr/bin/hdiutil", [
			"detach",
			join(root, "mount"),
		], { root });
		windowRequire(result.code === 0, "image_cleanup_unverified");
	}
	const after = await inspect();
	windowRequire(
		!after.mounted && after.owned && Date.now() <= deadline,
		"image_cleanup_unverified",
	);
	return { detached: true };
}

export async function createOwnedWindowImage(root, options = {}) {
	ownedWindowDirectory(root);
	const run = options.run ?? runWindowTool;
	const inspect = options.inspect ?? (() => inspectImage(root, run));
	const imagePath = join(root, "volume.sparseimage");
	const mountPath = join(root, "mount");
	mkdirSync(mountPath, { mode: 0o700 });
	let created = false, detached = false, lossObserved = false, closing;
	let imageIdentity;
	const close = () => {
		closing ??= (async () => {
			if (!created) return;
			await detachOwnedWindowImage(root, imageIdentity, { run, inspect });
			detached = true;
		})();
		return closing;
	};
	const loss = () => {
		lossObserved = true;
		void close().catch(() => {
			detached = false;
		});
	};
	try {
		const result = await run("/usr/bin/hdiutil", [
			"create",
			"-size",
			"4g",
			"-fs",
			"APFS",
			"-type",
			"SPARSE",
			"-volname",
			"HarnessWindow",
			"-nospotlight",
			imagePath,
		], { root, signal: options.signal });
		windowRequire(result.code === 0, "image_create_failed");
		chmodSync(imagePath, 0o600);
		imageIdentity = windowImageIdentity(root);
		created = true;
		await options.onCreated?.(imageIdentity);
		const attached = await run("/usr/bin/hdiutil", [
			"attach",
			imagePath,
			"-mountpoint",
			mountPath,
			"-nobrowse",
			"-owners",
			"on",
			"-plist",
		], { root, signal: options.signal });
		windowRequire(attached.code === 0, "image_attach_failed");
		const state = await inspect();
		windowRequire(
			state.mounted && state.owned,
			"image_ownership_unverified",
		);
		windowRequire(
			state.capacityBytes > 0 && state.capacityBytes <= windowVolumeBytes,
			"image_quota_unverified",
		);
		chmodSync(mountPath, 0o700);
		windowRequire(
			realpathSync(mountPath) === mountPath,
			"image_ownership_unverified",
		);
		options.signal?.addEventListener("abort", loss, { once: true });
		if (options.signal?.aborted) {
			await close();
			throw new WindowConformanceError("local_tool_cancelled");
		}
		return Object.freeze({
			imagePath,
			mountPath,
			async close() {
				options.signal?.removeEventListener("abort", loss);
				await close();
			},
			summary() {
				return {
					detached,
					quota_bytes: windowVolumeBytes,
					loss_observed: lossObserved,
				};
			},
		});
	} catch (error) {
		if (created) await close();
		throw error;
	}
}
