import { lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { hashFile } from "./fixtures.mjs";
import {
	ownedWindowDirectory,
	WindowConformanceError,
	windowRequire,
} from "./codex-window-conformance.mjs";
import {
	buildWindowSandboxProfile,
	runWindowTool,
} from "./codex-window-containment.mjs";
import { nativeProbeCases } from "./codex-window-native-probe-cases.mjs";
import {
	nativeProbeFiles,
	prepareNativeProbes,
} from "./codex-window-native-probe-files.mjs";

const resultSchema = z.strictObject({
	result: z.enum(["allowed", "EPERM", "EACCES", "mapping_rejected"]),
});

function observation(result) {
	windowRequire(
		Buffer.byteLength(result.stdout) <= 8192,
		"native_probe_output_invalid",
	);
	const parsed = resultSchema.safeParse(
		JSON.parse(result.stdout.trim().split("\n").at(-1)),
	);
	windowRequire(parsed.success, "native_probe_output_invalid");
	return {
		exit_code: result.code,
		result: parsed.data.result,
		stdout: result.stdout,
	};
}

async function executeNativeRows(context, rows) {
	const { out, owned, paths, profilePath } = context;
	for (const control of nativeProbeCases(paths)) {
		if (control.replaceWithLibrary) {
			owned.remove(paths.rg);
			owned.copy(paths.library, paths.rg);
		}
		for (const descendant of [false, true]) {
			owned.verify();
			const args = [
				...(descendant ? ["descendant"] : []),
				control.mode,
				control.target,
				...control.args,
			];
			const settings = {
				root: paths.caseRoot,
				timeoutMs: 15000,
				opensslConf: join(paths.caseRoot, "openssl.cnf"),
			};
			const baseline = observation(
				await runWindowTool(paths.cli, args, settings),
			);
			windowRequire(
				baseline.exit_code === 0 && baseline.result === "allowed",
				"native_probe_baseline_failed",
			);
			const sandboxed = observation(
				await runWindowTool("/usr/bin/sandbox-exec", [
					"-f",
					profilePath,
					paths.cli,
					...args,
				], settings),
			);
			const expected = control.allowed
				? ["allowed"]
				: control.mode === "map"
				? ["mapping_rejected"]
				: ["EPERM", "EACCES"];
			const passed = sandboxed.exit_code === (control.allowed ? 0 : 77) &&
				expected.includes(sandboxed.result);
			rows.push({
				name: control.name,
				descendant,
				mode: control.mode,
				target: control.target,
				target_sha256: owned.files.get(control.target)?.sha256 ?? null,
				baseline,
				sandboxed,
				passed,
			});
			owned.verify();
			windowRequire(passed, "native_probe_control_failed");
		}
	}
	windowRequire(
		rows.length === 26 && hashFile(profilePath) === context.profile.sha256,
		"native_probe_evidence_invalid",
	);
	windowRequire(
		lstatSync(out).uid === process.getuid(),
		"native_probe_ownership_unverified",
	);
}

export async function qualifyNativeWindowContainment(out) {
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
	const owned = nativeProbeFiles(out);
	const packet = {
		schema_version: 1,
		kind: "window_native_containment_qualification",
		origin: "local_nonvendor",
		containment_verified: false,
		native_exec_mapping_verified: false,
		historical_controls_verified: false,
		actual_target_qualified: false,
		execution_enabled: false,
		runtime: process.version,
		images_created: 0,
		network_requests: 0,
		controls: [],
		unverified_controls: [
			"loopback",
			"external_tcp",
			"dns",
			"outside_read",
			"home_stat",
			"outside_write",
			"exec_denied",
			"quota",
		]
			.map((name) => ({
				name,
				direct: "unverified",
				descendant: "unverified",
				profile: "native_only",
			})),
		cleanup_verified: false,
		removed_binaries: owned.removed,
		compilations: owned.compilations,
		failure: null,
	};
	try {
		const paths = await prepareNativeProbes(out, owned);
		const profile = buildWindowSandboxProfile({
			caseRoots: [paths.caseRoot],
			vendorPrefix: paths.prefix,
			runtimePaths: [paths.node, paths.python, paths.library],
			executables: [paths.cli, paths.host],
			port: 43123,
			home: join(out, "synthetic-home"),
		});
		const profilePath = join(out, "containment.sb");
		writeFileSync(profilePath, profile.bytes, { flag: "wx", mode: 0o600 });
		packet.profile_sha256 = profile.sha256;
		packet.exec_allowlist = [paths.cli, paths.host];
		packet.probe_sha256 = hashFile(
			join(out, "codex-window-native-probe.c"),
		);
		packet.library_source_sha256 = hashFile(
			join(out, "codex-window-native-probe-library.c"),
		);
		await executeNativeRows(
			{ out, owned, paths, profile, profilePath },
			packet.controls,
		);
		packet.native_exec_mapping_verified = true;
	} catch (error) {
		packet.failure = error instanceof WindowConformanceError
			? error.code
			: "native_qualification_failed";
	} finally {
		try {
			owned.close();
			packet.cleanup_verified = true;
		} catch (error) {
			packet.failure = error instanceof WindowConformanceError
				? error.code
				: "native_cleanup_unverified";
		}
	}
	if (packet.failure) packet.native_exec_mapping_verified = false;
	writeFileSync(
		join(out, "qualification.json"),
		JSON.stringify(packet, null, 2) + "\n",
		{ flag: "wx", mode: 0o600 },
	);
	return packet;
}
