#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
	WindowConformanceError,
	windowRequire,
} from "./codex-window-conformance.mjs";
import { windowVolumeBytes } from "./codex-window-containment.mjs";
import { qualifyNativeWindowContainment } from "./codex-window-native-probe.mjs";

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

export async function qualifyWindowContainment(out) {
	return qualifyNativeWindowContainment(out);
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	try {
		windowRequire(
			process.argv[2] !== "qualify",
			"qualification_native_mode_required",
		);
		windowRequire(
			process.argv.length === 5 && process.argv[2] === "qualify-native" &&
				process.argv[3] === "--out",
			"command_invalid",
		);
		const packet = await qualifyWindowContainment(process.argv[4]);
		process.stdout.write(
			JSON.stringify({
				status: packet.native_exec_mapping_verified
					? "nonvendor_native_controls_passed"
					: "qualification_failed",
				actual_target_qualified: false,
				native_exec_mapping_verified:
					packet.native_exec_mapping_verified,
				containment_verified: false,
				historical_controls_verified: false,
				cleanup_verified: packet.cleanup_verified,
				failure: packet.failure,
				controls: packet.controls.length,
			}) + "\n",
		);
		if (!packet.native_exec_mapping_verified || !packet.cleanup_verified) {
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
