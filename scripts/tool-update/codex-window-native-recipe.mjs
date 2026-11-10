import { dirname, join } from "node:path";

export function deriveWindowNativeRecipe(prefixRoot, input) {
	const packageRoot = join(prefixRoot, "node_modules/@openai/codex");
	const platformRoot = join(
		prefixRoot,
		"node_modules/@openai/codex-darwin-arm64",
	);
	const launcher = join(packageRoot, "bin/codex.js");
	const native = join(platformRoot, "vendor/aarch64-apple-darwin/bin/codex");
	const environment = {
		...input.environment,
		CODEX_MANAGED_PACKAGE_ROOT: packageRoot,
	};
	delete environment.CODEX_MANAGED_BY_NPM;
	delete environment.CODEX_MANAGED_BY_BUN;
	delete environment.CODEX_MANAGED_BY_PNPM;
	delete environment.CODEX_MANAGED_BY_VITE_PLUS;
	const userAgent = input.environment.npm_config_user_agent || "";
	const execPath = input.environment.npm_execpath || "";
	const entryDirectory = dirname(launcher);
	const bun = /\bbun\//.test(userAgent) || execPath.includes("bun") ||
		entryDirectory.includes(".bun/install/global") ||
		entryDirectory.includes(".bun\\install\\global");
	environment[bun ? "CODEX_MANAGED_BY_BUN" : "CODEX_MANAGED_BY_NPM"] = "1";
	return Object.freeze({
		argv: Object.freeze([native, ...input.argv_tail]),
		environment: Object.freeze(environment),
		resolution: Object.freeze({
			launcher,
			platform_package_json: join(platformRoot, "package.json"),
			native,
			target_triple: "aarch64-apple-darwin",
		}),
		required_signal_defaults: Object.freeze(["SIGXFSZ"]),
		residuals: Object.freeze([
			"ancestor_package_manager_metadata_not_replayed",
			"alternate_vendor_root_not_selected",
			"native_signal_handoff_unqualified",
		]),
	});
}
