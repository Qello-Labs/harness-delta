import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readdirSync,
	readlinkSync,
	readSync,
	realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { z } from "zod";
import { deriveWindowNativeRecipe } from "./codex-window-native-recipe.mjs";
import {
	WindowConformanceError,
	windowRequire,
} from "./codex-window-conformance.mjs";

const sha = z.string().regex(/^[0-9a-f]{64}$/);
const pathSchema = z.string().max(4096).refine((path) =>
	isAbsolute(path) && resolve(path) === path && !path.includes("\0")
);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const argument = z.string().max(4096).refine((value) => !value.includes("\0"));
const environmentSchema = z.record(
	z.string().max(128).regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
	argument,
).refine((value) => Object.keys(value).length <= 64);
const toolPaths = Object.freeze({
	ps: "/bin/ps",
	pgrep: "/usr/bin/pgrep",
	python3: "/usr/bin/python3",
	sandbox_exec: "/usr/bin/sandbox-exec",
	hdiutil: "/usr/bin/hdiutil",
	diskutil: "/usr/sbin/diskutil",
	plutil: "/usr/bin/plutil",
});
const toolName = z.enum(Object.keys(toolPaths));
const identity = {
	path: pathSchema,
	mode: integer.max(0o7777),
	dev: z.string().max(32).regex(/^(0|[1-9]\d*)$/),
	ino: z.string().max(32).regex(/^(0|[1-9]\d*)$/),
};
const manifestSchema = z.strictObject({
	schema_version: z.literal(1),
	prefix_root: pathSchema,
	b0_inventory: z.strictObject({
		...identity,
		size: integer.max(1048576),
		sha256: sha,
	}),
	argv: z.array(argument).min(1).max(128),
	launcher_input: z.strictObject({
		argv_tail: z.array(argument).max(127),
		environment: environmentSchema,
	}),
	controller_runtime: z.strictObject({
		node_major: integer.positive(),
	}),
	process_paths: z.array(pathSchema).length(2),
	runtime_paths: z.array(pathSchema).min(1).max(64),
	runtime_links: z.array(z.strictObject({
		...identity,
		target: z.string().min(1).max(4096).refine((value) =>
			!value.includes("\0")
		),
	})).max(128).default([]),
	system_tools: z.array(toolName).max(7),
	files: z.array(z.strictObject({
		...identity,
		role: z.enum([
			"native",
			"host",
			"launcher",
			"runtime",
			"runtime_data",
			"system_tool",
			"config",
			"environment",
			"argv",
			"denied",
			"profile",
			"quota",
		]),
		size: integer.max(300 * 1048576),
		sha256: sha,
		tool: toolName.optional(),
	})).min(6).max(512),
	directories: z.array(z.strictObject({
		...identity,
		entries: z.array(
			z.string().min(1).max(255).refine((name) =>
				name !== "." && name !== ".." && !name.includes("/") &&
				!name.includes("\0")
			),
		).max(512),
	})).min(1).max(512),
});
const inventorySchema = z.object({
	files: z.array(
		z.object({
			path: pathSchema,
			size: integer,
			mode: z.string().regex(/^0[0-7]{3,4}$/),
			sha256: sha,
		}),
	).min(2).max(512),
});
const beneath = (root, path) => path.startsWith(root + sep);
const sameIdentity = (stat, row) =>
	stat.dev.toString() === row.dev && stat.ino.toString() === row.ino &&
	Number(stat.mode & 0o7777n) === row.mode;
const fileIdentity = (stat) =>
	[stat.dev, stat.ino, stat.size, stat.mode & 0o7777n].join(":");

function canonical(path) {
	windowRequire(
		pathSchema.safeParse(path).success && realpathSync(path) === path,
		"pin_drift",
	);
	for (let parent = dirname(path);; parent = dirname(parent)) {
		windowRequire(
			lstatSync(parent).isDirectory() &&
				!lstatSync(parent).isSymbolicLink(),
			"pin_drift",
		);
		if (parent === dirname(parent)) break;
	}
}

function snapshot(path, limit, collect = false) {
	canonical(path);
	const fd = openSync(
		path,
		constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
	);
	try {
		const before = fstatSync(fd, { bigint: true });
		windowRequire(
			before.isFile() && before.nlink === 1n &&
				before.size <= BigInt(limit) &&
				[0n, BigInt(process.getuid())].includes(before.uid) &&
				(before.mode & 0o22n) === 0n,
			"pin_drift",
		);
		const digest = createHash("sha256");
		const buffer = Buffer.alloc(65536);
		const chunks = [];
		let offset = 0;
		for (;;) {
			const length = readSync(
				fd,
				buffer,
				0,
				Math.min(buffer.length, limit - offset + 1),
				offset,
			);
			if (!length) break;
			offset += length;
			windowRequire(offset <= limit, "pin_drift");
			digest.update(buffer.subarray(0, length));
			if (collect) chunks.push(Buffer.from(buffer.subarray(0, length)));
		}
		const after = fstatSync(fd, { bigint: true });
		const current = lstatSync(path, { bigint: true });
		windowRequire(
			BigInt(offset) === before.size &&
				[
					"dev",
					"ino",
					"size",
					"mode",
					"uid",
					"gid",
					"nlink",
					"mtimeNs",
					"ctimeNs",
				].every((key) =>
					before[key] === after[key] && before[key] === current[key]
				),
			"pin_drift",
		);
		return {
			stat: before,
			sha256: digest.digest("hex"),
			bytes: collect ? Buffer.concat(chunks) : undefined,
		};
	} finally {
		closeSync(fd);
	}
}

function directory(row) {
	canonical(row.path);
	const before = lstatSync(row.path, { bigint: true });
	windowRequire(
		before.isDirectory() && before.uid === BigInt(process.getuid()) &&
			(before.mode & 0o7022n) === 0n && sameIdentity(before, row),
		"pin_drift",
	);
	const entries = readdirSync(row.path).sort();
	const after = lstatSync(row.path, { bigint: true });
	windowRequire(
		sameIdentity(after, row) && before.mtimeNs === after.mtimeNs &&
			before.ctimeNs === after.ctimeNs &&
			JSON.stringify(entries) ===
				JSON.stringify([...row.entries].sort()) &&
			new Set(row.entries).size === row.entries.length,
		"pin_drift",
	);
}

function revalidateInventory(manifest, files, directories) {
	windowRequire(
		files.size === manifest.files.length &&
			directories.size === manifest.directories.length &&
			directories.has(manifest.prefix_root),
		"pin_drift",
	);
	for (const row of manifest.directories) {
		windowRequire(
			row.path === manifest.prefix_root ||
				beneath(manifest.prefix_root, row.path),
			"pin_drift",
		);
		directory(row);
		for (const name of row.entries) {
			const path = join(row.path, name);
			windowRequire(
				files.has(path) !== directories.has(path),
				"pin_drift",
			);
		}
		if (row.path !== manifest.prefix_root) {
			windowRequire(
				directories.get(dirname(row.path))?.entries.includes(
					row.path.slice(dirname(row.path).length + 1),
				),
				"pin_drift",
			);
		}
	}
}

function revalidateRuntimeLinks(manifest) {
	windowRequire(
		new Set(manifest.runtime_links.map((row) => row.path)).size ===
			manifest.runtime_links.length,
		"pin_drift",
	);
	for (const row of manifest.runtime_links) {
		canonical(dirname(row.path));
		const before = lstatSync(row.path, { bigint: true });
		windowRequire(
			before.isSymbolicLink() && sameIdentity(before, row) &&
				[0n, BigInt(process.getuid())].includes(before.uid) &&
				readlinkSync(row.path) === row.target,
			"pin_drift",
		);
		const target = realpathSync(row.path);
		windowRequire(
			manifest.runtime_paths.some((path) =>
				path === target || beneath(target, path)
			),
			"pin_drift",
		);
		const after = lstatSync(row.path, { bigint: true });
		windowRequire(
			sameIdentity(after, row) && before.ctimeNs === after.ctimeNs &&
				before.mtimeNs === after.mtimeNs &&
				readlinkSync(row.path) === row.target,
			"pin_drift",
		);
	}
}

function revalidateProcesses(manifest, inputs) {
	const runtime = realpathSync(process.execPath);
	const report = z.object({ sharedObjects: z.array(pathSchema) }).parse(
		process.report.getReport(),
	);
	// OS shared-cache names are not standalone files; host qualification owns that boundary.
	const loadedRuntime = report.sharedObjects.filter((path) =>
		!path.startsWith("/usr/lib/") && !path.startsWith("/System/")
	);
	windowRequire(
		loadedRuntime.every((path) =>
			manifest.runtime_paths.includes(realpathSync(path))
		),
		"pin_drift",
	);
	const singleRoles = {
		native: inputs.native_path,
		host: inputs.host_path,
		launcher: join(
			inputs.prefix_root,
			"node_modules/@openai/codex/bin/codex.js",
		),
		runtime,
		config: inputs.config_path,
		environment: inputs.environment_path,
		profile: inputs.profile_path,
		quota: inputs.quota_packet_path,
	};
	for (const [role, path] of Object.entries(singleRoles)) {
		const rows = manifest.files.filter((row) => row.role === role);
		windowRequire(rows.length === 1 && rows[0].path === path, "pin_drift");
	}
	const sets = [
		[
			manifest.process_paths,
			manifest.files.filter((row) =>
				["native", "host"]
					.includes(row.role)
			).map((row) => row.path),
		],
		[
			manifest.runtime_paths,
			manifest.files.filter((row) =>
				["runtime", "runtime_data"].includes(row.role)
			).map((row) => row.path),
		],
		[
			manifest.system_tools,
			manifest.files.filter((row) => row.role === "system_tool").map(
				(row) => row.tool,
			),
		],
	];
	for (const [declared, measured] of sets) {
		windowRequire(
			new Set(declared).size === declared.length &&
				JSON.stringify([...declared].sort()) ===
					JSON.stringify(measured.sort()),
			"pin_drift",
		);
	}
	for (const row of manifest.files) {
		if (row.role === "system_tool") {
			windowRequire(
				row.tool && row.path === realpathSync(toolPaths[row.tool]),
				"pin_drift",
			);
		} else windowRequire(row.tool === undefined, "pin_drift");
	}
	windowRequire(
		manifest.files.filter((row) => row.role === "argv").length === 1 &&
			Number(process.versions.node.split(".")[0]) ===
				manifest.controller_runtime.node_major &&
			manifest.argv[0] === inputs.native_path &&
			JSON.stringify(manifest.argv) === JSON.stringify(
					deriveWindowNativeRecipe(
						inputs.prefix_root,
						manifest.launcher_input,
					).argv,
				) &&
			manifest.files.some((row) =>
				row.path ===
					join(
						inputs.prefix_root,
						"node_modules/@openai/codex-darwin-arm64/package.json",
					)
			),
		"pin_drift",
	);
}

function revalidateFiles(manifest, inputs, caseRoot, b0Files, directories) {
	for (const row of manifest.files) {
		const inPrefix = beneath(inputs.prefix_root, row.path);
		windowRequire(
			inPrefix ===
				["native", "host", "launcher", "denied"].includes(row.role),
			"pin_drift",
		);
		if (inPrefix) {
			const recorded = b0Files.get(row.path);
			windowRequire(
				recorded && recorded.sha256 === row.sha256 &&
					recorded.size === row.size &&
					parseInt(recorded.mode, 8) === row.mode &&
					directories.get(dirname(row.path))?.entries.includes(
						row.path.slice(dirname(row.path).length + 1),
					),
				"pin_drift",
			);
		}
		if (["config", "environment", "argv"].includes(row.role)) {
			windowRequire(beneath(caseRoot, row.path), "pin_drift");
		}
		const collect = ["argv", "environment"].includes(row.role);
		const limit = collect
			? 1048576
			: row.role === "host"
			? 128 * 1048576
			: 300 * 1048576;
		const observed = snapshot(row.path, limit, collect);
		windowRequire(
			row.role === "system_tool" || (observed.stat.mode & 0o7000n) === 0n,
			"pin_drift",
		);
		windowRequire(
			sameIdentity(observed.stat, row) &&
				observed.stat.size === BigInt(row.size) &&
				observed.sha256 === row.sha256,
			"pin_drift",
		);
		if (inPrefix) {
			windowRequire(
				observed.stat.uid === BigInt(process.getuid()),
				"pin_drift",
			);
		}
		if (row.role === "argv") {
			windowRequire(
				JSON.stringify(JSON.parse(observed.bytes.toString("utf8"))) ===
					JSON.stringify(manifest.argv),
				"pin_drift",
			);
		}
		if (row.role === "environment") {
			const actual = environmentSchema.parse(
				JSON.parse(observed.bytes.toString("utf8")),
			);
			const expected = deriveWindowNativeRecipe(
				inputs.prefix_root,
				manifest.launcher_input,
			).environment;
			windowRequire(
				JSON.stringify(Object.entries(actual).sort()) ===
					JSON.stringify(Object.entries(expected).sort()),
				"pin_drift",
			);
		}
	}
}

export function revalidateNativeWindowInputs(inputs, caseRoot) {
	try {
		windowRequire(
			beneath(inputs.batch_root, inputs.native_manifest_path) &&
				!beneath(inputs.prefix_root, inputs.native_manifest_path),
			"pin_drift",
		);
		const frozen = snapshot(inputs.native_manifest_path, 1048576, true);
		windowRequire(
			(frozen.stat.mode & 0o7777n) === 0o600n &&
				frozen.stat.uid === BigInt(process.getuid()) &&
				fileIdentity(frozen.stat) === inputs.native_manifest_identity &&
				frozen.sha256 === inputs.native_manifest_sha256,
			"pin_drift",
		);
		const manifest = manifestSchema.parse(
			JSON.parse(frozen.bytes.toString("utf8")),
		);
		windowRequire(manifest.prefix_root === inputs.prefix_root, "pin_drift");
		const bin = join(
			inputs.prefix_root,
			"node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin",
		);
		windowRequire(
			inputs.native_path === join(bin, "codex") &&
				inputs.host_path === join(bin, "codex-code-mode-host"),
			"pin_drift",
		);
		windowRequire(
			beneath(inputs.batch_root, manifest.b0_inventory.path) &&
				!beneath(inputs.prefix_root, manifest.b0_inventory.path),
			"pin_drift",
		);
		const b0 = snapshot(manifest.b0_inventory.path, 1048576, true);
		windowRequire(
			b0.sha256 === manifest.b0_inventory.sha256 &&
				sameIdentity(b0.stat, manifest.b0_inventory) &&
				b0.stat.size === BigInt(manifest.b0_inventory.size),
			"pin_drift",
		);
		// The inventory's whole-file pin retains signing metadata, not source attestation.
		const inventory = inventorySchema.parse(
			JSON.parse(b0.bytes.toString("utf8")),
		);
		const b0Files = new Map(inventory.files.map((row) => [row.path, row]));
		const files = new Map(manifest.files.map((row) => [row.path, row]));
		const directories = new Map(
			manifest.directories.map((row) => [row.path, row]),
		);
		windowRequire(
			b0Files.size === inventory.files.length,
			"pin_drift",
		);
		revalidateInventory(manifest, files, directories);
		revalidateProcesses(manifest, inputs);
		revalidateRuntimeLinks(manifest);
		revalidateFiles(manifest, inputs, caseRoot, b0Files, directories);
		revalidateRuntimeLinks(manifest);
		windowRequire(
			inventory.files.every((row) =>
				beneath(inputs.prefix_root, row.path) && files.has(row.path)
			),
			"pin_drift",
		);
		for (const row of manifest.directories) directory(row);
		for (
			const [path, previous] of [[inputs.native_manifest_path, frozen], [
				manifest.b0_inventory.path,
				b0,
			]]
		) {
			const current = snapshot(path, 1048576);
			windowRequire(
				current.sha256 === previous.sha256 &&
					fileIdentity(current.stat) === fileIdentity(previous.stat),
				"pin_drift",
			);
		}
	} catch (error) {
		if (error instanceof WindowConformanceError) throw error;
		throw new WindowConformanceError("pin_drift");
	}
}
