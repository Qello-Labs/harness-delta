import {
	constants,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hashFile } from "./fixtures.mjs";
import {
	ownedWindowDirectory,
	windowRequire,
} from "./codex-window-conformance.mjs";
import { runWindowTool } from "./codex-window-containment.mjs";

export function nativeProbeFiles(out) {
	const root = lstatSync(out);
	const files = new Map();
	const removed = [];
	const compilations = [];
	const identity = (path) => {
		const stat = lstatSync(path);
		windowRequire(
			realpathSync(path) === path && stat.isFile() &&
				stat.uid === process.getuid() && stat.nlink === 1,
			"native_probe_ownership_unverified",
		);
		return {
			path,
			dev: stat.dev,
			ino: stat.ino,
			bytes: stat.size,
			mode: stat.mode,
			sha256: hashFile(path),
		};
	};
	const track = (path) => files.set(path, identity(path));
	const verify = () => {
		ownedWindowDirectory(out);
		const current = lstatSync(out);
		windowRequire(
			current.dev === root.dev && current.ino === root.ino,
			"native_probe_ownership_unverified",
		);
		for (const [path, expected] of files) {
			const currentFile = identity(path);
			windowRequire(
				Object.keys(expected).every((key) =>
					expected[key] === currentFile[key]
				),
				"native_probe_ownership_unverified",
			);
		}
	};
	const remove = (path) => {
		verify();
		const expected = files.get(path);
		windowRequire(expected, "native_probe_ownership_unverified");
		unlinkSync(path);
		removed.push(expected);
		files.delete(path);
	};
	const copy = (source, target) => {
		mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
		copyFileSync(source, target, constants.COPYFILE_EXCL);
		track(target);
	};
	const compile = async (sourceName, output, flags = []) => {
		const source = fileURLToPath(new URL(sourceName, import.meta.url));
		const retained = join(out, sourceName);
		writeFileSync(retained, readFileSync(source), {
			flag: "wx",
			mode: 0o600,
		});
		let result;
		try {
			result = await runWindowTool("/usr/bin/clang", [
				"-Wall",
				"-Wextra",
				"-Werror",
				...flags,
				retained,
				"-o",
				output,
			], { root: out, timeoutMs: 30000 });
		} finally {
			if (existsSync(output)) track(output);
		}
		compilations.push({ source: retained, output, exit_code: result.code });
		windowRequire(
			result.code === 0 && files.has(output),
			"native_probe_compile_failed",
		);
	};
	return {
		copy,
		compile,
		verify,
		remove,
		files,
		removed,
		compilations,
		close: () => {
			for (const path of files.keys()) remove(path);
		},
	};
}

export async function prepareNativeProbes(out, owned) {
	const caseRoot = join(out, "case");
	const prefix = join(out, "prefix");
	mkdirSync(caseRoot, { mode: 0o700 });
	mkdirSync(prefix, { mode: 0o700 });
	const nativeRoot = join(
		prefix,
		"node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin",
	);
	const paths = {
		caseRoot,
		prefix,
		cli: join(nativeRoot, "bin/codex"),
		host: join(nativeRoot, "bin/codex-code-mode-host"),
		node: realpathSync(process.execPath),
		python: "/usr/bin/python3",
		rg: join(nativeRoot, "codex-path/rg"),
		voice: join(nativeRoot, "codex-resources/voice/bin/codex-voice-host"),
		voiceLibrary: join(
			nativeRoot,
			"codex-resources/voice/lib/libffi.8.dylib",
		),
		writableLibrary: join(caseRoot, "writable.dylib"),
		library: join(out, "control.dylib"),
	};
	const executable = join(out, "probe");
	await owned.compile("codex-window-native-probe.c", executable);
	await owned.compile("codex-window-native-probe-library.c", paths.library, [
		"-dynamiclib",
	]);
	for (const target of [paths.cli, paths.host, paths.rg, paths.voice]) {
		owned.copy(executable, target);
	}
	for (const target of [paths.voiceLibrary, paths.writableLibrary]) {
		owned.copy(paths.library, target);
	}
	for (
		const [name, marker] of [[
			"arbitrary.mjs",
			"unapproved-writable-script-executed",
		], ["child.mjs", "unapproved-descendant-script-executed"]]
	) {
		writeFileSync(
			join(caseRoot, name),
			`process.stdout.write(${JSON.stringify(marker + "\n")});\n`,
			{ flag: "wx", mode: 0o600 },
		);
	}
	writeFileSync(join(caseRoot, "openssl.cnf"), "", {
		flag: "wx",
		mode: 0o600,
	});
	return paths;
}
