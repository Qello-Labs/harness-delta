import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readdirSync,
	readFileSync,
	writeSync,
} from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import {
	ownedWindowDirectory,
	windowRequire,
} from "./codex-window-conformance.mjs";

const safeName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const unsafe = "evidence_export_unsafe";

function jsonObject(bytes) {
	try {
		const value = JSON.parse(bytes.toString("utf8"));
		return typeof value === "object" && value !== null &&
			!Array.isArray(value);
	} catch {
		return false;
	}
}

function write(directory, name, bytes) {
	const fd = openSync(
		join(directory, name),
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
			constants.O_NOFOLLOW,
		0o600,
	);
	try {
		windowRequire(writeSync(fd, bytes) === bytes.length, unsafe);
	} finally {
		closeSync(fd);
	}
}

// Everything is validated before the first byte leaves the volume, so a refusal exports nothing.
export function exportWindowEvidence(
	{ evidenceRoot, exportRoot, maxFileBytes = 65536, maxTotalBytes = 67108864 },
) {
	ownedWindowDirectory(evidenceRoot);
	ownedWindowDirectory(exportRoot);
	const inside = relative(evidenceRoot, exportRoot);
	windowRequire(
		inside === ".." || inside.startsWith(".." + sep) || isAbsolute(inside),
		unsafe,
	);
	windowRequire(readdirSync(exportRoot).length === 0, unsafe);
	const staged = [];
	let total = 0;
	for (const name of readdirSync(evidenceRoot).sort()) {
		windowRequire(safeName.test(name), unsafe);
		const path = join(evidenceRoot, name);
		const before = lstatSync(path);
		windowRequire(
			before.isFile() && !before.isSymbolicLink() &&
				before.uid === process.getuid() && before.nlink === 1 &&
				before.size <= maxFileBytes,
			unsafe,
		);
		const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		let bytes;
		try {
			const opened = fstatSync(fd);
			windowRequire(
				opened.dev === before.dev && opened.ino === before.ino,
				unsafe,
			);
			bytes = readFileSync(fd);
		} finally {
			closeSync(fd);
		}
		total += bytes.length;
		windowRequire(
			bytes.length <= maxFileBytes && total <= maxTotalBytes &&
				jsonObject(bytes),
			unsafe,
		);
		staged.push({
			name,
			bytes,
			summary: {
				name,
				bytes: bytes.length,
				sha256: createHash("sha256").update(bytes).digest("hex"),
			},
		});
	}
	for (const file of staged) write(exportRoot, file.name, file.bytes);
	const summary = Object.freeze({
		schema_version: 1,
		total_bytes: total,
		files: Object.freeze(staged.map((file) => file.summary)),
	});
	write(
		exportRoot,
		"manifest.json",
		Buffer.from(JSON.stringify(summary, null, 2) + "\n"),
	);
	return summary;
}
