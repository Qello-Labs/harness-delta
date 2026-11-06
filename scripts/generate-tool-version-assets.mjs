import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const check = process.argv.length === 3 && process.argv[2] === "--check";
if (process.argv.length > 2 && !check) {
	throw new Error("tool_version_assets_arguments");
}
const read = (path) => readFileSync(join(root, path), "utf8");
const profiles = JSON.parse(read("src/core/tool-version-profiles.json"));
const recipes = JSON.parse(read("src/core/tool-version-recipes.json"));
const identities =
	JSON.parse(read("src/core/tool-version-identities.json")).entries;
const receiptProfiles = profiles.filter((profile) =>
	profile.product === "codex" && profile.exportOrder.receipt !== undefined
)
	.sort((a, b) => a.exportOrder.receipt - b.exportOrder.receipt);
const localRecipe = recipes.find((recipe) =>
	recipe.id === "claude-localhost-02306"
);
const localImage = identities.find((identity) =>
	identity.id === localRecipe.imageIdentity
);
const admittedImage = {
	version: localRecipe.version,
	sha256: localImage.sha256,
	size: localImage.exactBytes,
};
const literal = (value) => `'${value}'`;
const artifacts = new Map();

function frozenLiteral(value) {
	if (Array.isArray(value)) {
		return `Object.freeze([${value.map(frozenLiteral).join(", ")}])`;
	}
	if (value !== null && typeof value === "object") {
		return `Object.freeze({${
			Object.entries(value).map(([key, item]) =>
				`${JSON.stringify(key)}: ${frozenLiteral(item)}`
			).join(", ")
		}})`;
	}
	return JSON.stringify(value);
}

function declaration(value) {
	if (Array.isArray(value)) {
		return `readonly [${value.map(declaration).join(", ")}]`;
	}
	if (value !== null && typeof value === "object") {
		return `{ ${
			Object.entries(value).map(([key, item]) =>
				`readonly ${JSON.stringify(key)}: ${declaration(item)};`
			).join(" ")
		} }`;
	}
	return JSON.stringify(value);
}

function replaceToken(template, token, value) {
	if (template.split(token).length !== 2) {
		throw new Error("tool_version_assets_template_token");
	}
	return template.replace(token, value);
}

let hook = read("scripts/session-binding-codex-hook.template.mjs");
hook = replaceToken(
	hook,
	"'__CODEX_RECEIPT_DEFAULT__'",
	literal(
		receiptProfiles.find((profile) => profile.receipt.legacyDefault)
			.version,
	),
);
hook = replaceToken(
	hook,
	"['__CODEX_RECEIPT_VERSIONS__']",
	`[${
		receiptProfiles.map((profile) => literal(profile.version)).join(", ")
	}]`,
);
artifacts.set("scripts/session-binding-codex-hook.mjs", hook);
const generatedNotice =
	"// Generated from code-owned registry inputs; edit those inputs instead.\n";
artifacts.set(
	"scripts/generated/tool-version-data.mjs",
	generatedNotice +
		`export const claudeLocalhostRecipe = ${
			frozenLiteral(localRecipe)
		};\n` +
		`export const claudeLocalhostImage = ${
			frozenLiteral(admittedImage)
		};\n`,
);
artifacts.set(
	"scripts/generated/tool-version-data.d.mts",
	generatedNotice +
		`export const claudeLocalhostRecipe: ${declaration(localRecipe)};\n` +
		`export const claudeLocalhostImage: Readonly<{ version: ${
			declaration(admittedImage.version)
		}; sha256: string; size: ${declaration(admittedImage.size)} }>;\n`,
);
artifacts.set(
	"scripts/generated/current-support.json",
	JSON.stringify(
		{
			schemaVersion: 1,
			profiles: profiles.map((profile) => ({
				product: profile.product,
				version: profile.version,
				...(profile.file ? { file: profile.file } : {}),
				...(profile.workflow ? { workflow: profile.workflow } : {}),
				...(profile.ordinaryBinding
					? { ordinaryBinding: profile.ordinaryBinding }
					: {}),
				...(profile.transcriptProfile
					? { transcriptProfile: profile.transcriptProfile }
					: {}),
			})),
		},
		null,
		2,
	) + "\n",
);

function factBlock(path, name, content) {
	const start = `<!-- tool-version-assets:${name}:start -->`;
	const end = `<!-- tool-version-assets:${name}:end -->`;
	const current = read(path);
	if (
		current.split(start).length !== 2 || current.split(end).length !== 2 ||
		current.indexOf(start) > current.indexOf(end)
	) throw new Error(`tool_version_assets_markers:${path}`);
	const begin = current.indexOf(start) + start.length;
	artifacts.set(
		path,
		current.slice(0, begin) + "\n" + content + "\n" +
			current.slice(current.indexOf(end)),
	);
}

const ordinary = profiles.find((profile) =>
	profile.ordinaryBinding?.profileId ===
		"codex-binding-01630-direct-family-v1"
);
const children = ordinary.ordinaryBinding.maxFamilyMembers - 1;
const words = [
	"zero",
	"one",
	"two",
	"three",
	"four",
	"five",
	"six",
	"seven",
	"eight",
];
factBlock(
	"docs/runbooks/harness-connect.md",
	"codex-ordinary-profile",
	`The exact \`${ordinary.ordinaryBinding.profileId}\` source admits one fresh CLI root\n` +
		`and up to ${
			words[children]
		} fresh direct children in a registered frozen \`functional_pilot\`.`,
);
factBlock(
	"docs/runbooks/harness-connect.ko.md",
	"codex-ordinary-profile",
	`정확한 \`${ordinary.ordinaryBinding.profileId}\` 소스는 등록된 동결 \`functional_pilot\`에서\n` +
		`새 CLI 부모 한 개와 새 직접 자식 최대 ${
			[
				"영",
				"한",
				"두",
				"세",
				"네",
				"다섯",
				"여섯",
				"일곱",
				"여덟",
			][children]
		} 개를 허용합니다.`,
);
const codexWorkflow = profiles.find((profile) =>
	profile.product === "codex" &&
	profile.workflow?.some((workflow) =>
		workflow.status === "admitted" &&
		workflow.profileId === "codex-workflow-own-response-v1"
	)
);
const claudeWorkflow = profiles.find((profile) =>
	profile.product === "claude_code" &&
	profile.workflow?.some((workflow) =>
		workflow.status === "admitted" &&
		workflow.profileId === "claude-workflow-own-trace-v1"
	)
);
const codexWorkflowProfile = codexWorkflow.workflow.find((workflow) =>
	workflow.profileId === "codex-workflow-own-response-v1"
);
const claudeWorkflowProfile = claudeWorkflow.workflow.find((workflow) =>
	workflow.profileId === "claude-workflow-own-trace-v1"
);
const claudeChildProfile = claudeWorkflow.workflow.find((workflow) =>
	workflow.profileId === "claude-workflow-direct-child-v1"
);
factBlock(
	"docs/runbooks/workflow-quickstart.md",
	"workflow-profiles",
	`It covers Codex ${codexWorkflow.version} (\`${codexWorkflowProfile.profileId}\`) and\n` +
		`Claude Code ${claudeWorkflow.version} (\`${claudeWorkflowProfile.profileId}\`, parent-only; \`${claudeChildProfile.profileId}\`), plus\n` +
		"the conditional forward versions described below.",
);
factBlock(
	"docs/runbooks/workflow-quickstart.ko.md",
	"workflow-profiles",
	`대상은 Codex ${codexWorkflow.version}(\`${codexWorkflowProfile.profileId}\`)과\n` +
		`Claude Code ${claudeWorkflow.version}(\`${claudeWorkflowProfile.profileId}\`, 부모 전용; \`${claudeChildProfile.profileId}\`)과\n` +
		"아래의 조건부 후속 버전입니다.",
);

const changed = [];
for (const [path, expected] of artifacts) {
	let current;
	try {
		const stat = statSync(join(root, path));
		if ((stat.mode & 0o222) === 0) {
			throw new Error(`tool_version_assets_read_only:${path}`);
		}
		current = read(path);
	} catch (error) {
		if (
			!(error instanceof Error) || !("code" in error) ||
			error.code !== "ENOENT"
		) throw error;
		if (check) throw new Error(`tool_version_assets_missing:${path}`, { cause: error });
		current = null;
	}
	if (current !== expected) {
		if (check) throw new Error(`tool_version_assets_stale:${path}`);
		changed.push([path, expected]);
	}
}
for (const [path, expected] of changed) {
	mkdirSync(dirname(join(root, path)), { recursive: true });
	writeFileSync(join(root, path), expected);
}
console.log(
	JSON.stringify({
		status: check
			? "tool_version_assets_current"
			: "tool_version_assets_generated",
		changed: changed.map(([path]) => path),
	}),
);
