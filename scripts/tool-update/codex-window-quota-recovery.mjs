import * as filesystem from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { runWindowTool } from "./codex-window-containment.mjs";
import {
	ownedWindowDirectory,
	WindowConformanceError,
	windowRequire,
} from "./codex-window-conformance.mjs";
import { readWindowStartupJournal } from "./codex-window-startup-journal.mjs";

const entity = z.object({
	"dev-entry": z.string().regex(/^\/dev\/disk[0-9]+(?:s[0-9]+)*$/),
	"content-hint": z.string().optional(),
	"mount-point": z.string().optional(),
});
const infoSchema = z.object({
	images: z.array(
		z.object({
			"image-path": z.string(),
			"system-entities": z.array(entity).min(1).max(16),
		}),
	).max(64),
});
const volumeNames = [
	"HarnessQuotaBase",
	"HarnessQuotaState",
	"HarnessQuotaEvidence",
];

async function attachment(run, root, imagePath, mountRoot) {
	const info = await run("/usr/bin/hdiutil", ["info", "-plist"], {
		root,
		timeoutMs: 15000,
	});
	windowRequire(info.code === 0, "recovery_cleanup_unverified");
	const json = await run("/usr/bin/plutil", [
		"-convert",
		"json",
		"-o",
		"-",
		"-",
	], { root, input: info.stdout, timeoutMs: 15000 });
	windowRequire(json.code === 0, "recovery_cleanup_unverified");
	const parsed = infoSchema.safeParse(JSON.parse(json.stdout));
	windowRequire(parsed.success, "recovery_cleanup_unverified");
	const matches = parsed.data.images.filter((row) =>
		row["image-path"] === imagePath
	);
	windowRequire(matches.length <= 1, "recovery_ownership_unverified");
	if (!matches.length) return null;
	const rows = matches[0]["system-entities"];
	const devices = new Set(rows.map((row) => row["dev-entry"]));
	windowRequire(
		devices.size === rows.length &&
			parsed.data.images.every((row) =>
				row["image-path"] === imagePath ||
				row["system-entities"].every((other) =>
					!devices.has(other["dev-entry"])
				)
			),
		"recovery_ownership_unverified",
	);
	for (const row of rows) {
		const point = row["mount-point"];
		windowRequire(
			!point || volumeNames.some((name) =>
				point === join(mountRoot, name)
			),
			"recovery_ownership_unverified",
		);
	}
	const wholes = rows.filter((row) =>
		row["content-hint"] === "GUID_partition_scheme" &&
		/^\/dev\/disk[0-9]+$/.test(row["dev-entry"])
	);
	windowRequire(wholes.length === 1, "recovery_ownership_unverified");
	return wholes[0]["dev-entry"];
}

function sameIdentity(a, b) {
	return Object.keys(a).every((key) => a[key] === b[key]);
}

function writeReceipt(fs, root, packet) {
	for (let attempt = 0; attempt < 8; attempt++) {
		const name = attempt
			? `startup-recovery-${attempt}.json`
			: "startup-recovery.json";
		try {
			fs.writeFileSync(
				join(root, name),
				JSON.stringify(packet, null, 2) + "\n",
				{ flag: "wx", mode: 0o600 },
			);
			return name;
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) ||
				error.code !== "EEXIST") throw error;
		}
	}
	throw new WindowConformanceError("recovery_receipt_unavailable");
}

// Independent of the guardian: only the hashed startup journal and the pinned
// root decide what is ours. An image path or a mount is never trusted by name alone.
export async function recoverWindowQuota(root, options = {}) {
	const fs = options.fs ?? filesystem;
	const run = options.run ?? runWindowTool;
	const journal = readWindowStartupJournal(root);
	const imagePath = join(root, "volume.sparseimage");
	const mountRoot = join(root, "mounts");
	let stat = null;
	try {
		stat = fs.lstatSync(imagePath);
	} catch (error) {
		if (!(error instanceof Error) || !("code" in error) ||
			error.code !== "ENOENT") throw error;
	}
	if (stat) {
		windowRequire(
			stat.isFile() && !stat.isSymbolicLink() &&
				stat.uid === process.getuid() && stat.nlink === 1,
			"recovery_ownership_unverified",
		);
		const directory = fs.lstatSync(root);
		windowRequire(
			!journal.identity || sameIdentity(journal.identity, {
				root_dev: directory.dev,
				root_ino: directory.ino,
				image_dev: stat.dev,
				image_ino: stat.ino,
			}),
			"recovery_identity_mismatch",
		);
	}
	const whole = await attachment(run, root, imagePath, mountRoot);
	if (whole) {
		let result = await run("/usr/bin/hdiutil", ["detach", whole], {
			root,
			timeoutMs: 30000,
		});
		if (result.code !== 0) {
			result = await run("/usr/bin/hdiutil", [
				"detach",
				"-force",
				whole,
			], { root, timeoutMs: 30000 });
		}
		windowRequire(result.code === 0, "recovery_cleanup_unverified");
		windowRequire(
			await attachment(run, root, imagePath, mountRoot) === null,
			"recovery_cleanup_unverified",
		);
	}
	if (stat) {
		const current = fs.lstatSync(imagePath);
		windowRequire(
			current.dev === stat.dev && current.ino === stat.ino,
			"recovery_identity_mismatch",
		);
		fs.unlinkSync(imagePath);
		windowRequire(!fs.existsSync(imagePath), "recovery_cleanup_unverified");
	}
	const packet = {
		recovered: true,
		detached: whole !== null,
		image_deleted: stat !== null,
		identity: stat ? journal.identity : null,
		identity_source: stat ? (journal.identity ? "journal" : "root") : null,
		journal: {
			head: journal.head,
			entries: journal.entries,
			last_phase: journal.last_phase,
		},
		actual_target_qualified: false,
	};
	writeReceipt(fs, root, packet);
	return packet;
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
	try {
		windowRequire(
			process.argv.length === 4 && process.argv[2] === "recover" &&
				process.argv[3] === resolve(process.argv[3]),
			"recovery_arguments_invalid",
		);
		ownedWindowDirectory(process.argv[3]);
		process.stdout.write(
			JSON.stringify(await recoverWindowQuota(process.argv[3])) + "\n",
		);
	} catch (error) {
		process.stdout.write(
			JSON.stringify({
				recovered: false,
				code: error instanceof WindowConformanceError
					? error.code
					: "recovery_failed",
			}) + "\n",
		);
		process.exitCode = 2;
	}
}
