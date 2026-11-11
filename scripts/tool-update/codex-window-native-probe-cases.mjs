import { join } from "node:path";

export function nativeProbeCases(paths) {
	const child = join(paths.caseRoot, "child.mjs");
	const spawnScript = "const {spawnSync}=require('node:child_process');" +
		"const r=spawnSync(process.execPath,[process.argv[1]],{env:process.env,encoding:'utf8',timeout:3000});" +
		"process.stdout.write(r.stdout||'');process.exit(r.status===0?0:1)";
	const spawnEval = "const {spawnSync}=require('node:child_process');" +
		"const r=spawnSync(process.execPath,['-e',\"process.stdout.write('unapproved-eval-executed\\\\n')\"]," +
		"{env:process.env,encoding:'utf8',timeout:3000});process.stdout.write(r.stdout||'');process.exit(r.status===0?0:1)";
	return [
		{
			name: "native_cli",
			mode: "exec",
			target: paths.cli,
			args: ["pass"],
			allowed: true,
		},
		{
			name: "native_host",
			mode: "exec",
			target: paths.host,
			args: ["pass"],
			allowed: true,
		},
		{
			name: "native_mapping_control",
			mode: "map",
			target: paths.library,
			args: [],
			allowed: true,
		},
		{
			name: "node_eval",
			mode: "exec",
			target: paths.node,
			args: ["-e", "process.stdout.write('node-started\\n')"],
			allowed: false,
		},
		{
			name: "node_writable_script",
			mode: "exec",
			target: paths.node,
			args: [join(paths.caseRoot, "arbitrary.mjs")],
			allowed: false,
		},
		{
			name: "node_spawn_script",
			mode: "exec",
			target: paths.node,
			args: ["-e", spawnScript, child],
			allowed: false,
		},
		{
			name: "node_spawn_eval",
			mode: "exec",
			target: paths.node,
			args: ["-e", spawnEval],
			allowed: false,
		},
		{
			name: "python3",
			mode: "exec",
			target: paths.python,
			args: ["-c", "print('python-started')"],
			allowed: false,
		},
		{
			name: "rg_exec",
			mode: "exec",
			target: paths.rg,
			args: ["pass"],
			allowed: false,
		},
		{
			name: "voice_exec",
			mode: "exec",
			target: paths.voice,
			args: ["pass"],
			allowed: false,
		},
		{
			name: "writable_mapping",
			mode: "map",
			target: paths.writableLibrary,
			args: [],
			allowed: false,
		},
		{
			name: "voice_mapping",
			mode: "map",
			target: paths.voiceLibrary,
			args: [],
			allowed: false,
		},
		{
			name: "rg_mapping",
			mode: "map",
			target: paths.rg,
			args: [],
			allowed: false,
			replaceWithLibrary: true,
		},
	];
}
