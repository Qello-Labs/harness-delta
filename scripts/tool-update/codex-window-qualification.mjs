#!/usr/bin/env node
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	statfsSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { hashFile } from "./fixtures.mjs";
import {
	ownedWindowDirectory,
	WindowConformanceError,
	windowRequire,
} from "./codex-window-conformance.mjs";
import { createWindowOracleServer } from "./codex-window-oracle.mjs";
import { createWindowImageGuardian } from "./codex-window-image-owner.mjs";
import {
	buildWindowSandboxProfile,
	runWindowTool,
	windowGuardOverheadBytes,
	windowImageIdentity,
	windowVolumeBytes,
} from "./codex-window-containment.mjs";

const probeNames = [
	"loopback",
	"external_tcp",
	"dns",
	"outside_read",
	"home_stat",
	"outside_write",
	"exec_denied",
	"quota",
];
const probeSchema = z.strictObject({
	name: z.enum(probeNames),
	descendant: z.boolean(),
	ok: z.boolean(),
	code: z.string().max(64),
	written_bytes: z.number().int().min(0).max(windowVolumeBytes),
});
const helperPath = fileURLToPath(
	new URL("./codex-window-containment-probe.mjs", import.meta.url),
);

export function assessWindowContainment(input) {
	const parsed = z.array(probeSchema).max(16).safeParse(input);
	if (!parsed.success) {
		return { passed: false, actual_target_qualified: false, checked: 0 };
	}
	const rows = parsed.data;
	const required = [false, true].flatMap((descendant) =>
		probeNames.map((name) => `${name}:${descendant}`)
	);
	const keys = rows.map((row) => `${row.name}:${row.descendant}`);
	const complete = keys.length === required.length &&
		new Set(keys).size === required.length &&
		required.every((key) => keys.includes(key));
	const valid = rows.every((row) =>
		row.ok &&
		(row.name === "loopback"
			? row.code === "allowed"
			: row.name === "quota"
			? ["ENOSPC", "EDQUOT"].includes(row.code) &&
				(row.descendant || row.written_bytes >= 3221225472)
			: ["EPERM", "EACCES"].includes(row.code))
	);
	return {
		passed: complete && valid,
		actual_target_qualified: false,
		checked: rows.length,
	};
}

async function runtimePaths(node, root) {
	const pending = [{ path: node, rpaths: [] }];
	const visited = new Set();
	const reads = new Set([dirname(dirname(node))]);
	const files = [];
	let bytes = 0;
	while (pending.length) {
		const entry = pending.pop();
		const path = realpathSync(entry.path);
		if (visited.has(path)) continue;
		visited.add(path);
		windowRequire(visited.size <= 64, "runtime_inventory_limit");
		const stat = lstatSync(path);
		bytes += stat.size;
		windowRequire(
			stat.isFile() && bytes <= 536870912,
			"runtime_inventory_limit",
		);
		files.push({ path, sha256: hashFile(path), bytes: stat.size });
		reads.add(dirname(path));
		const dependencies = await runWindowTool(
			"/usr/bin/otool",
			["-L", path],
			{ root, timeoutMs: 10000 },
		);
		windowRequire(dependencies.code === 0, "runtime_inventory_unavailable");
		const loadCommands = await runWindowTool(
			"/usr/bin/otool",
			["-l", path],
			{ root, timeoutMs: 10000 },
		);
		windowRequire(loadCommands.code === 0, "runtime_inventory_unavailable");
		const rpaths = [
			...loadCommands.stdout.matchAll(
				/cmd LC_RPATH[\s\S]*?path (.+?) \(offset/g,
			),
		].map((match) =>
			resolve(
				match[1].replace("@loader_path", dirname(path)).replace(
					"@executable_path",
					dirname(node),
				),
			)
		);
		const searchPaths = [...rpaths, ...entry.rpaths];
		for (const line of dependencies.stdout.split("\n").slice(1)) {
			const match = /^\s+(.+?) \(/.exec(line);
			if (
				!match || match[1].startsWith("/System/") ||
				match[1].startsWith("/usr/lib/")
			) continue;
			let dependency = match[1];
			if (dependency.startsWith("@rpath/")) {
				dependency = searchPaths.map((base) =>
					join(base, dependency.slice("@rpath/".length))
				).find((candidate) =>
					existsSync(candidate)
				) ?? "";
			}
			if (dependency.startsWith("@loader_path/")) {
				dependency = join(
					dirname(path),
					dependency.slice("@loader_path/".length),
				);
			}
			windowRequire(
				isAbsolute(dependency) && existsSync(dependency),
				"runtime_inventory_unavailable",
			);
			reads.add(dirname(dependency));
			pending.push({ path: dependency, rpaths: searchPaths });
		}
	}
	return {
		reads: [...reads].sort(),
		files: files.sort((a, b) => a.path.localeCompare(b.path, "en")),
	};
}

function privateJson(path, data) {
	const bytes = JSON.stringify(data, null, 2) + "\n";
	windowRequire(
		Buffer.byteLength(bytes) <= 65536,
		"qualification_packet_limit",
	);
	writeFileSync(path, bytes, { flag: "wx", mode: 0o600 });
}

async function runProbe(
	profile,
	node,
	helper,
	mode,
	config,
	descendant,
	root,
	signal,
) {
	const observed = await runWindowTool("/usr/bin/sandbox-exec", [
		"-f",
		profile,
		node,
		helper,
		mode,
		config,
		descendant ? "fork" : "direct",
	], {
		root,
		signal,
		timeoutMs: mode === "quota" ? 120000 : 15000,
		opensslConf: join(root, "openssl.cnf"),
	});
	windowRequire(
		observed.code === 0 && Buffer.byteLength(observed.stdout) <= 8192,
		"probe_execution_failed",
	);
	const parsed = probeSchema.safeParse(JSON.parse(observed.stdout));
	windowRequire(
		parsed.success && parsed.data.name === mode &&
			parsed.data.descendant === descendant,
		"probe_output_invalid",
	);
	return parsed.data;
}

async function prepareProbeCase(out, image, server, controller) {
	const caseRoot = join(image.mountPath, "case");
	const prefix = join(image.mountPath, "prefix");
	mkdirSync(caseRoot, { mode: 0o700 });
	mkdirSync(prefix, { mode: 0o700 });
	const copiedHelper = join(caseRoot, "probe.mjs");
	writeFileSync(copiedHelper, readFileSync(helperPath), {
		flag: "wx",
		mode: 0o600,
	});
	const configPath = join(caseRoot, "probe.json");
	const opensslConf = join(caseRoot, "openssl.cnf");
	writeFileSync(opensslConf, "", { flag: "wx", mode: 0o600 });
	const outsideRead = join(out, "outside-sentinel");
	writeFileSync(outsideRead, "synthetic-sentinel", {
		flag: "wx",
		mode: 0o600,
	});
	const port = await server.listen();
	server.events.on("request", () => {
		void server.start().then(() => server.complete()).catch(() =>
			controller.abort()
		);
	});
	const node = realpathSync(process.execPath);
	const runtime = await runtimePaths(node, out);
	const profile = buildWindowSandboxProfile({
		caseRoots: [caseRoot],
		vendorPrefix: prefix,
		runtimePaths: runtime.reads,
		executables: [node],
		port,
		home: homedir(),
	});
	const profilePath = join(out, "containment.sb");
	writeFileSync(profilePath, profile.bytes, { flag: "wx", mode: 0o600 });
	privateJson(configPath, {
		openssl_conf: opensslConf,
		port,
		caseRoot,
		outsideRead,
		outsideWrite: join(out, "denied-write"),
		homePath: join(homedir(), ".zshrc"),
		quota: join(caseRoot, "quota.bin"),
		descendantQuota: join(caseRoot, "descendant-quota.bin"),
	});
	return {
		caseRoot,
		copiedHelper,
		configPath,
		port,
		node,
		runtime,
		profile,
		profilePath,
	};
}

async function qualificationSupervisorBarrier(out, controller) {
	if (!process.send) return;
	const barrier = Promise.withResolvers();
	const continueProbes = (input) => {
		const parsed = z.strictObject({
			kind: z.literal("continue_qualification"),
		}).safeParse(input);
		if (parsed.success) barrier.resolve();
		else {barrier.reject(
				new WindowConformanceError("qualification_control_invalid"),
			);}
	};
	const lost = () =>
		barrier.reject(
			new WindowConformanceError("qualification_observer_lost"),
		);
	process.once("message", continueProbes);
	controller.signal.addEventListener("abort", lost, { once: true });
	try {
		windowRequire(
			!controller.signal.aborted,
			"qualification_observer_lost",
		);
		process.send(
			{
				kind: "qualification_mounted",
				identity: windowImageIdentity(out),
			},
			(error) => {
				if (error) lost();
			},
		);
		await barrier.promise;
	} finally {
		process.removeListener("message", continueProbes);
		controller.signal.removeEventListener("abort", lost);
	}
}

export async function qualifyWindowContainment(out) {
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
	const host = statfsSync(out, { bigint: true });
	windowRequire(
		host.bavail * host.bsize >=
			BigInt(windowVolumeBytes + windowGuardOverheadBytes),
		"qualification_disk_reserve",
	);
	const controller = new AbortController();
	const abort = () => controller.abort();
	const deadline = Date.now() + 600000;
	const timer = setTimeout(abort, deadline - Date.now());
	process.once("SIGINT", abort);
	process.once("SIGTERM", abort);
	process.once("disconnect", abort);
	const guardian = createWindowImageGuardian(out, { deadline });
	guardian.events.once("owner_lost", abort);
	const server = createWindowOracleServer([
		{ input: 1, output: 1, cached: 0, reasoning: 0 },
		{ input: 2, output: 2, cached: 0, reasoning: 0 },
	], { port: 0, timeoutMs: 600000, signal: controller.signal });
	let image, packet, failure;
	const rows = [];
	try {
		image = await guardian.start();
		await qualificationSupervisorBarrier(out, controller);
		const {
			caseRoot,
			copiedHelper,
			configPath,
			port,
			node,
			runtime,
			profile,
			profilePath,
		} = await prepareProbeCase(out, image, server, controller);
		for (const name of probeNames.filter((name) => name !== "quota")) {
			for (const descendant of [false, true]) {
				rows.push(
					await runProbe(
						profilePath,
						node,
						copiedHelper,
						name,
						configPath,
						descendant,
						caseRoot,
						controller.signal,
					),
				);
			}
		}
		for (const descendant of [false, true]) {
			rows.push(
				await runProbe(
					profilePath,
					node,
					copiedHelper,
					"quota",
					configPath,
					descendant,
					caseRoot,
					controller.signal,
				),
			);
		}
		const assessment = assessWindowContainment(rows);
		windowRequire(
			hashFile(profilePath) === profile.sha256 &&
				hashFile(helperPath) === hashFile(copiedHelper),
			"pin_drift",
		);
		const allocation = lstatSync(image.imagePath).blocks * 512;
		windowRequire(
			allocation <= windowVolumeBytes + windowGuardOverheadBytes,
			"image_overhead_limit",
		);
		unlinkSync(join(caseRoot, "quota.bin"));
		packet = {
			schema_version: 1,
			kind: "window_containment_qualification",
			origin: "local_nonvendor",
			containment_verified: assessment.passed,
			actual_target_qualified: false,
			execution_enabled: false,
			profile_sha256: profile.sha256,
			probe_sha256: hashFile(helperPath),
			runtime: process.version,
			runtime_files: runtime.files,
			node,
			oracle_port: port,
			quota_bytes: windowVolumeBytes,
			image_allocated_bytes: allocation,
			controls: rows,
			independent_review: "pending",
			preventive_process_count_verified: false,
			preventive_exec_count_verified: false,
		};
	} catch (error) {
		failure = error instanceof WindowConformanceError
			? error.code
			: "qualification_failed";
	} finally {
		clearTimeout(timer);
		process.removeListener("SIGINT", abort);
		process.removeListener("SIGTERM", abort);
		process.removeListener("disconnect", abort);
		await server.close();
		try {
			await guardian.close();
		} catch {
			failure = "image_cleanup_unverified";
		}
	}
	const evidence = packet ?? {
		schema_version: 1,
		kind: "window_containment_qualification",
		origin: "local_nonvendor",
		containment_verified: false,
		actual_target_qualified: false,
		execution_enabled: false,
		controls: rows,
	};
	evidence.cleanup_verified = guardian.summary().detached === true;
	evidence.failure = failure ?? null;
	if (failure) evidence.containment_verified = false;
	privateJson(join(out, "qualification.json"), evidence);
	return evidence;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	try {
		windowRequire(
			process.argv.length === 5 && process.argv[2] === "qualify" &&
				process.argv[3] === "--out",
			"command_invalid",
		);
		const packet = await qualifyWindowContainment(process.argv[4]);
		process.stdout.write(
			JSON.stringify({
				status: packet.containment_verified
					? "nonvendor_controls_passed"
					: "qualification_failed",
				actual_target_qualified: false,
				cleanup_verified: packet.cleanup_verified,
				failure: packet.failure,
				controls: packet.controls.length,
			}) + "\n",
		);
		if (!packet.containment_verified || !packet.cleanup_verified) {
			process.exitCode = 2;
		}
	} catch (error) {
		process.stdout.write(
			JSON.stringify({
				status: "qualification_failed",
				code: error instanceof WindowConformanceError
					? error.code
					: "qualification_failed",
				actual_target_qualified: false,
			}) + "\n",
		);
		process.exitCode = 2;
	}
	if (process.connected) process.disconnect();
}
