import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	fsyncSync,
	lstatSync,
	openSync,
	readFileSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
	ownedWindowDirectory,
	windowRequire,
} from "./codex-window-conformance.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const zero = "0".repeat(64);

export function createWindowStartupJournal(root) {
	ownedWindowDirectory(root);
	const directory = lstatSync(root);
	const path = join(root, "startup-journal.jsonl");
	const fd = openSync(
		path,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL |
			constants.O_APPEND | constants.O_NOFOLLOW,
		0o600,
	);
	const identity = fstatSync(fd);
	let bytes = "", head = zero, sequence = 0, closed = false;
	return Object.freeze({
		path,
		append(phase, imageIdentity = null) {
			windowRequire(!closed, "startup_journal_closed");
			const currentRoot = lstatSync(root), current = lstatSync(path);
			windowRequire(
				currentRoot.dev === directory.dev &&
					currentRoot.ino === directory.ino &&
					current.dev === identity.dev &&
					current.ino === identity.ino &&
					current.nlink === 1 && (current.mode & 0o777) === 0o600 &&
					readFileSync(path, "utf8") === bytes,
				"startup_journal_changed",
			);
			const entry = {
				sequence: sequence + 1,
				phase,
				root_identity: { dev: directory.dev, ino: directory.ino },
				identity: imageIdentity,
				previous_hash: head,
			};
			const hash = digest(JSON.stringify(entry));
			const line = JSON.stringify({ ...entry, hash }) + "\n";
			windowRequire(
				Buffer.byteLength(bytes + line) <= 524288,
				"startup_journal_limit",
			);
			const data = Buffer.from(line);
			windowRequire(
				writeSync(fd, data) === data.length,
				"startup_journal_write_failed",
			);
			fsyncSync(fd);
			bytes += line;
			head = hash;
			sequence++;
			return Object.freeze({ path, head, entries: sequence });
		},
		summary() {
			return Object.freeze({ path, head, entries: sequence });
		},
		close() {
			if (!closed) closeSync(fd);
			closed = true;
		},
	});
}

const imageIdentity = z.strictObject({
	root_dev: z.number().int(),
	root_ino: z.number().int(),
	image_dev: z.number().int(),
	image_ino: z.number().int(),
});
const journalRow = z.strictObject({
	sequence: z.number().int().positive(),
	phase: z.string().min(1).max(64),
	root_identity: z.strictObject({ dev: z.number(), ino: z.number() }),
	identity: imageIdentity.nullable(),
	previous_hash: z.string().regex(/^[a-f0-9]{64}$/),
	hash: z.string().regex(/^[a-f0-9]{64}$/),
});

// Read-only verification: recovery trusts the chain and the pinned root, never the writer.
export function readWindowStartupJournal(root) {
	ownedWindowDirectory(root);
	const directory = lstatSync(root);
	const path = join(root, "startup-journal.jsonl");
	let stat;
	try {
		stat = lstatSync(path);
	} catch {
		windowRequire(false, "startup_journal_changed");
	}
	windowRequire(
		stat.isFile() && !stat.isSymbolicLink() &&
			stat.uid === process.getuid() && stat.nlink === 1 &&
			(stat.mode & 0o777) === 0o600 && stat.size > 0 &&
			stat.size <= 524288,
		"startup_journal_changed",
	);
	const bytes = readFileSync(path, "utf8");
	windowRequire(bytes.endsWith("\n"), "startup_journal_changed");
	let head = zero, count = 0, lastPhase = null, identity = null;
	for (const line of bytes.slice(0, -1).split("\n")) {
		let parsed;
		try {
			parsed = journalRow.safeParse(JSON.parse(line));
		} catch {
			parsed = { success: false };
		}
		windowRequire(parsed.success, "startup_journal_changed");
		const { hash, ...entry } = parsed.data;
		windowRequire(
			entry.previous_hash === head && entry.sequence === ++count &&
				entry.root_identity.dev === directory.dev &&
				entry.root_identity.ino === directory.ino &&
				hash === digest(JSON.stringify(entry)),
			"startup_journal_changed",
		);
		head = hash;
		lastPhase = entry.phase;
		identity = entry.identity ?? identity;
	}
	return Object.freeze({
		path,
		head,
		entries: count,
		last_phase: lastPhase,
		identity,
	});
}
