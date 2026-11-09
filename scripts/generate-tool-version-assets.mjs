import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	parseToolVersionPromotionDescriptor,
	projectToolVersionPromotions,
	promotionProjectionDigest,
	promotionRegistryDigest,
} from "../src/core/tool-version-promotion.ts";
import { promotionImplementationDigest } from "./tool-update/promotion-implementation.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const check = process.argv.length === 3 && process.argv[2] === "--check";
if (process.argv.length > 2 && !check) {
	throw new Error("tool_version_assets_arguments");
}
const read = (path) => readFileSync(join(root, path), "utf8");
const rawProfiles = JSON.parse(read("src/core/tool-version-profiles.json"));
const profiles = rawProfiles.filter((profile) =>
	profile.kind !== "promoted_descriptor"
);
const descriptors = rawProfiles.filter((profile) =>
	profile.kind === "promoted_descriptor"
).map(parseToolVersionPromotionDescriptor);
const recipes = JSON.parse(read("src/core/tool-version-recipes.json"));
const identities =
	JSON.parse(read("src/core/tool-version-identities.json")).entries;
const registryDigest = promotionRegistryDigest({
	profiles: rawProfiles,
	recipes,
	identities,
});
const receiptProfiles = profiles
	.filter((profile) =>
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
const changed = [];

function frozenLiteral(value) {
	if (Array.isArray(value)) {
		return `Object.freeze([${value.map(frozenLiteral).join(", ")}])`;
	}
	if (value !== null && typeof value === "object") {
		return `Object.freeze({${
			Object.entries(value)
				.map(([key, item]) =>
					`${JSON.stringify(key)}: ${frozenLiteral(item)}`
				)
				.join(", ")
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
			Object.entries(value)
				.map(([key, item]) =>
					`readonly ${JSON.stringify(key)}: ${declaration(item)};`
				)
				.join(" ")
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
const promotedTemplate = read(
	"scripts/session-binding-codex-promoted-hook.template.mjs",
);
artifacts.set(
	"scripts/session-binding-codex-promoted-hook.mjs",
	replaceToken(promotedTemplate, "__PROMOTED_PRODUCT__", "codex"),
);
artifacts.set(
	"skills/harness-connect-promoted-claude/scripts/connect.mjs",
	replaceToken(
		read("skills/harness-connect-promoted-codex/scripts/connect.mjs"),
		"codex",
		"claude_code",
	),
);
artifacts.set(
	"skills/harness-connect-promoted-claude/scripts/claude-session-hook.mjs",
	replaceToken(promotedTemplate, "__PROMOTED_PRODUCT__", "claude_code"),
);
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
			declaration(
				admittedImage.version,
			)
		}; sha256: string; size: ${declaration(admittedImage.size)} }>;\n`,
);
writeArtifacts();
artifacts.clear();
const implementationDigest = await promotionImplementationDigest(root);
const projection = projectToolVersionPromotions({
	descriptors,
	ledger: JSON.parse(read("src/core/tool-version-promotions.json")),
	registryDigest,
	implementationDigest,
});
const promotedSupport = descriptors.map((descriptor) => ({
	product: descriptor.product,
	version: descriptor.version,
	promotion: {
		status:
			projection.facets.some((facet) =>
					facet.descriptor.product === descriptor.product &&
					facet.descriptor.version === descriptor.version
				)
				? "effective"
				: "pending",
		profileId: descriptor.profileId,
		route: descriptor.route,
		declaredScopes: descriptor.scopes,
		effectiveScopes: projection.facets
			.filter((facet) =>
				facet.descriptor.product === descriptor.product &&
				facet.descriptor.version === descriptor.version
			)
			.map(({ decision }) => {
				const scope = descriptor.scopes.find((scope) =>
					scope.operation === decision.scope.lane.operation &&
					scope.topology === decision.scope.lane.topology
				);
				return {
					operation: scope.operation,
					topology: scope.topology,
					maxDepth: scope.maxDepth,
					maxFamilyMembers: scope.maxFamilyMembers,
					platform: decision.scope.platform,
					runtime: decision.scope.runtime,
					grants: decision.grants,
				};
			}),
	},
}));
const currentSupport = {
	schemaVersion: 1,
	profiles: [
		...profiles.map((profile) => ({
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
		...promotedSupport,
	],
};
artifacts.set(
	"scripts/generated/current-support.json",
	JSON.stringify(currentSupport, null, 2) + "\n",
);

const supportText = {
	ko: {
		title: "지원 매트릭스",
		language: "[English](support-matrix.md)",
		intro:
			"[registry](../src/core/tool-version-profiles.json)와 같은 데이터로 생성한 [current-support.json](../scripts/generated/current-support.json)의 정확 경로 투영입니다. `node scripts/generate-tool-version-assets.mjs`로 재생성하고 `--check`로 검사합니다. 직접 편집하지 마세요.",
		routes: "정확한 경로",
		columns:
			"| 제품 | 버전 | 경로 | status | profileId | qualification | 추가 registry 값 |",
		scope:
			"`not_declared`는 이 투영에 값이 없다는 뜻입니다. 선언되지 않은 버전이나 경로를 정확 등록/admission으로 지원하지 않습니다. 별도 조건부 parser 재사용이나 명시적으로 승인한 pilot을 미지원이라고 단정하지는 않습니다. `transcriptProfile`은 ordinary admission과 별도 근거이며 profile ID가 선언되지 않을 수 있습니다.",
		legend: "범례와 제한",
		labels: [
			[
				"registered",
				"정확 파일 adapter 등록입니다. 전체 사용량이나 비용 검증이 아닙니다.",
			],
			[
				"ledger_registered",
				"정책 revision을 가진 ledger 기반 정확 등록입니다. 과거 admission이 현재 source identity나 전체 작업 완전성을 검증하지 않습니다.",
			],
			[
				"admitted",
				"해당 정확 경로와 profile 범위의 사용 허용입니다. native qualification, 다른 경로 또는 과거 관측의 승격이 아닙니다.",
			],
			[
				"retired",
				"이 workflow admission은 지원 종료됐으며 현재 허용 경로가 아닙니다.",
			],
			[
				"candidate",
				"후보 근거만 있으며 검증된 production admission이 아닙니다.",
			],
			[
				"qualified",
				"transcriptProfile에 기록된 제한된 print-mode 근거입니다. interactive, authenticated ordinary, broader resume/compaction 검증이 아닙니다.",
			],
			[
				"implicit_verified",
				"registry가 유지하는 암묵적 검증 상태입니다. 명시적 verified로 바꾸거나 다른 source에 적용하지 않습니다.",
			],
			[
				"verified",
				"명시적으로 기록된 해당 경로의 qualification 상태입니다. 다른 경로나 전체 비용 검증이 아닙니다.",
			],
			[
				"unqualified",
				"qualification 미완료입니다. selectable/admitted라는 이유로 검증된 지원이라고 표현하지 않습니다.",
			],
			[
				"qualified: false",
				"ordinary qualification은 false로 남습니다. 일반 사용 admission이나 transcript 검증이 이 값을 바꾸지 않습니다.",
			],
			[
				"not_declared",
				"필드 또는 정확 경로 선언이 없습니다. 검증됨, 관측된 0 또는 허용으로 추정하지 않습니다.",
			],
			[
				"compatibility_unverified",
				"별도 유한 window의 조건부 재사용 상태입니다. 정확 admission이 아니며 추정값을 분리하고 비호환 데이터를 무효화합니다.",
			],
		],
		labelColumns: "| 값 | 의미와 운영 경계 |",
		limits: [
			"일반 파일, binding, workflow 사용량과 비용은 partial이며 전체 비용, 청구액, 추론 기반 도입 판단은 제공하지 않습니다. 별도 검증된 instrumented Codex의 표준화된 complete cost를 일반 관측에 적용하지 않습니다. [관측 비용](runbooks/observed-cost.ko.md)을 참고하세요.",
			"정확 버전과 요구되는 binary/source pin을 지키세요. admission, qualification, 설치, 설정, synthetic 검증은 별개이며 과거 관측의 provenance를 승격하지 않습니다. 저장 버전은 자동 갱신하지 않고 버전 생략은 저장값을 유지하며 고정 작업과 가격은 이전하지 않습니다.",
			"`gpt_family_observed_effort_v1`과 `claude_family_observed_effort_v1`은 해당 제품 계열 모델과 관측 effort 정책입니다. model/effort 근거 값을 모든 실행의 pin으로 해석하지 마세요. 다른 제품 모델은 거부되며 Claude batch는 원자적으로 거부됩니다.",
			"Codex ordinary family는 등록된 고정 `functional_pilot`, 새 CLI root와 제한된 새 직접 자식을 요구합니다. assignment-free Claude 모드나 qualification lease가 권한을 부여하지 않습니다. `maxFamilyMembers`는 root를 포함하고 `rootOnlyOverride: true`는 family 검증을 뜻하지 않습니다. [연결 절차](runbooks/harness-connect.ko.md)를 따르세요.",
			"Codex child workflow는 read-only이며 family resume과 더 넓은 descendant 수집을 허용하지 않습니다. Claude child workflow도 새 read-only 직접 자식 하나로 제한하고 child resume, 더 깊거나 추가된 자식을 지원하지 않습니다. [native workflow](runbooks/task-native-workflow.md)에 작업별 경계를 유지합니다.",
			"비교/pilot provider는 transcript-qualified profile에도 `allowCandidateProfiles: true`와 별도 로컬 pilot 권한을 요구하며 기본 거부는 닫혀 있습니다. `native_unverified_pilot`, `legacy_unverified`, `candidate_pilot` 표시는 유지되고 일반 관측 권한을 부여하지 않습니다. [pilot 절차](runbooks/harness-connect.ko.md#claude-사용자-조작-ui-pilot)를 참고하세요.",
			"관측하지 않은 연결 전·일시정지·오프라인 구간은 backfill하지 않습니다. 누락 사용량이나 가격은 0이 아니라 unknown입니다. complete request-universe와 terminal accounting은 일반 관측으로 검증되지 않습니다.",
		],
		windows: "Ordinary window",
		windowText:
			"이 registry 투영에는 ordinary-window 정책, profile 또는 cap 데이터가 없습니다. 따라서 버전 cap을 생성하거나 정확 admission으로 추론하지 않습니다. 구현된 유한 정책은 [ADR 013](decisions/013-forward-version-compatibility.md#implemented-windows-and-evidence)과 [Codex 설정](runbooks/harness-connect.ko.md#codex-일반-window-설정-수집-비활성), [Claude 설정](runbooks/harness-connect.ko.md#claude-일반-window-설정-수집-비활성)을 참고하세요.",
		windowGate:
			"Window activation은 기본적으로 닫혀 있습니다. 오프라인 구현, 설치와 정적 선택은 수집이나 정확 지원을 활성화하지 않습니다. 별도 제품 활성화와 native 검증이 필요하며 root-source 참조는 root-own 사용량이 아닙니다. 소유는 미검증이고 자식 관측 범위와 비용은 null로 남습니다.",
		evidence: "근거와 절차",
		links: [
			"[버전 admission 절차](runbooks/codex-version-admission.md)와 [기여 절차](../CONTRIBUTING.md#file-adapter-profiles)",
			"[정확 adapter capability 근거](decisions/001-adapter-capabilities.md)와 [일반 관측 정책](decisions/016-ordinary-observation.md)",
			"[Codex ordinary qualification 기록](validation/codex-ordinary-binding-qualification.ko.md)과 [Claude transcript 및 ordinary 근거](validation/claude-ordinary-binding-02196-qualification.md)",
			"[Codex checkpoint readiness 한도](validation/codex-01580-offline-readiness.md): 과거 live report는 현재 source identity나 전체 작업 완전성을 검증하지 않습니다.",
		],
	},
	en: {
		title: "Support matrix",
		language: "[한국어](support-matrix.ko.md)",
		intro:
			"Generated from the [registry](../src/core/tool-version-profiles.json), using the same exact-route projection as [current-support.json](../scripts/generated/current-support.json). Regenerate with `node scripts/generate-tool-version-assets.mjs`; verify with `--check`. Do not edit this file by hand.",
		routes: "Exact routes",
		columns:
			"| Product | Version | Route | status | profileId | qualification | Additional registry values |",
		scope:
			"`not_declared` means this projection has no value. Undeclared versions or routes are unsupported as exact registrations/admissions here. This does not rule out separately authorized pilots or conditional parser reuse. `transcriptProfile` is evidence separate from ordinary admission and may have no declared profile ID.",
		legend: "Legend and limits",
		labels: [
			[
				"registered",
				"An exact file adapter registration, not qualification of complete usage or cost.",
			],
			[
				"ledger_registered",
				"A ledger-backed exact registration with a policy revision. Historical admission does not qualify the current source identity or whole-task completeness.",
			],
			[
				"admitted",
				"Use is admitted only for this exact route and profile scope, not native qualification or promotion of other routes or historical observations.",
			],
			[
				"retired",
				"This workflow admission is retired, not a currently permitted route.",
			],
			[
				"candidate",
				"Candidate evidence only, not verified production admission.",
			],
			[
				"qualified",
				"The transcriptProfile's bounded print-mode evidence, not interactive, authenticated ordinary or broader resume/compaction qualification.",
			],
			[
				"implicit_verified",
				"The implicit verification state retained by the registry. Do not relabel it explicit verified or apply it to other sources.",
			],
			[
				"verified",
				"The explicitly recorded qualification state for this route, not another route or complete cost.",
			],
			[
				"unqualified",
				"Qualification is outstanding. Selectable/admitted does not mean qualified support.",
			],
			[
				"qualified: false",
				"Ordinary qualification remains false. Normal-use admission and transcript qualification do not change this flag.",
			],
			[
				"not_declared",
				"A field or exact-route declaration is absent. Do not infer verification, observed zero or permission.",
			],
			[
				"compatibility_unverified",
				"Conditional reuse within a separate finite window, not exact admission. Keep estimates separate and invalidate incompatible data.",
			],
		],
		labelColumns: "| Value | Meaning and operational boundary |",
		limits: [
			"Ordinary file, binding and workflow usage and costs remain partial: no complete totals, vendor bills or inferential adoption support. The separately qualified instrumented Codex source's standardized complete cost does not promote ordinary observations. See [observed cost](runbooks/observed-cost.md).",
			"Respect exact versions and required binary/source pins. Admission, qualification, installation, configuration and synthetic validation are separate; never promote historical provenance. Saved versions never upgrade automatically, omitting a version keeps saved settings, and frozen tasks and prices never migrate.",
			"`gpt_family_observed_effort_v1` and `claude_family_observed_effort_v1` permit the respective product's model family at observed effort. Evidence model/effort values are not a universal invocation pin. Another product's model is refused; Claude source batches are rejected atomically.",
			"Codex ordinary families require a registered frozen `functional_pilot`, a fresh CLI root and bounded fresh direct children. Assignment-free Claude mode or a qualification lease grants no such authority. `maxFamilyMembers` includes the root; `rootOnlyOverride: true` does not qualify a family. Follow [Harness Connect](runbooks/harness-connect.md).",
			"Codex child workflow is read-only, with no family resume or broader descendant collection. Claude child workflow also permits only one fresh read-only direct child, with no child resume, deeper or additional children. Keep operation-specific boundaries in the [native workflow](runbooks/task-native-workflow.md).",
			"The comparison/pilot provider requires `allowCandidateProfiles: true` even for transcript-qualified profiles, plus separate local pilot authority; default refusal stays closed. Labels remain `native_unverified_pilot`, `legacy_unverified` and `candidate_pilot`. These profiles grant no ordinary observation authority. See the [pilot procedure](runbooks/harness-connect.md#claude-human-operated-ui-pilot).",
			"Never backfill unobserved pre-connection, paused or offline intervals. Missing usage or prices are unknown, not zero. Complete request-universe and terminal accounting are not qualified by ordinary observations.",
		],
		windows: "Ordinary windows",
		windowText:
			"This registry projection contains no ordinary-window policy, profile or cap data. No version caps are generated or inferred as exact admissions. For implemented finite policies see [ADR 013](decisions/013-forward-version-compatibility.md#implemented-windows-and-evidence), [Codex setup](runbooks/harness-connect.md#codex-ordinary-window-setup-collection-disabled) and [Claude setup](runbooks/harness-connect.md#claude-ordinary-window-setup-collection-disabled).",
		windowGate:
			"Window activation stays closed by default. Offline implementation, installation and static selection do not activate collection or extend exact support. Separate product activation and native acceptance are required. A root-source reference is not root-own usage: ownership stays unverified and child coverage and cost stay null.",
		evidence: "Evidence and procedures",
		links: [
			"[Version admission procedure](runbooks/codex-version-admission.md) and [contributor process](../CONTRIBUTING.md#file-adapter-profiles)",
			"[Exact adapter capability evidence](decisions/001-adapter-capabilities.md) and [ordinary observation policy](decisions/016-ordinary-observation.md)",
			"[Codex ordinary qualification record](validation/codex-ordinary-binding-qualification.md) and [Claude transcript and ordinary evidence](validation/claude-ordinary-binding-02196-qualification.md)",
			"[Codex checkpoint readiness limits](validation/codex-01580-offline-readiness.md): the archived live report does not qualify the current source identity or establish whole-task completeness.",
		],
	},
};

function supportMatrix(korean) {
	const cell = (value) =>
		`\`${JSON.stringify(value).replaceAll("|", "\\|")}\``;
	const rows = [];
	for (const profile of currentSupport.profiles) {
		for (
			const route of [
				"file",
				"workflow",
				"ordinaryBinding",
				"ordinaryWindow",
				"transcriptProfile",
				...(profile.promotion ? ["promotion"] : []),
			]
		) {
			const declared = profile[route];
			const entries = Array.isArray(declared) ? declared : [declared];
			for (const entry of entries) {
				const {
					status,
					profileId,
					qualification,
					qualified,
					...details
				} = entry ?? {};
				const state = qualification !== undefined
					? { qualification }
					: qualified !== undefined
					? { qualified }
					: "not_declared";
				rows.push(
					`| ${cell(profile.product)} | ${cell(profile.version)} | ${
						cell(route)
					} | ${cell(status ?? "not_declared")} | ${
						cell(
							profileId ?? "not_declared",
						)
					} | ${cell(state)} | ${cell(details)} |`,
				);
			}
		}
	}
	const text = korean ? supportText.ko : supportText.en;
	return [
		`# ${text.title}`,
		"",
		text.language,
		"",
		text.intro,
		"",
		`## ${text.routes}`,
		"",
		text.scope,
		"",
		text.columns,
		"| --- | --- | --- | --- | --- | --- | --- |",
		...rows,
		"",
		`## ${text.legend}`,
		"",
		text.labelColumns,
		"| --- | --- |",
		...text.labels.map(([label, meaning]) =>
			`| \`${label}\` | ${meaning} |`
		),
		"",
		...text.limits.map((limit) => `- ${limit}`),
		"",
		`## ${text.windows}`,
		"",
		text.windowText,
		"",
		text.windowGate,
		"",
		`## ${text.evidence}`,
		"",
		...text.links.map((link) => `- ${link}`),
		"",
	].join("\n");
}

artifacts.set("docs/support-matrix.md", supportMatrix(false));
artifacts.set("docs/support-matrix.ko.md", supportMatrix(true));

function factBlock(path, name, content) {
	const start = `<!-- tool-version-assets:${name}:start -->`;
	const end = `<!-- tool-version-assets:${name}:end -->`;
	const current = read(path);
	if (
		current.split(start).length !== 2 || current.split(end).length !== 2 ||
		current.indexOf(start) > current.indexOf(end)
	) {
		throw new Error(`tool_version_assets_markers:${path}`);
	}
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
factBlock(
	"docs/runbooks/workflow-quickstart.md",
	"workflow-profiles",
	"Choose an exact route and check its status in the [generated support matrix](../support-matrix.md#exact-routes).\n" +
		"Conditional forward selection is separate from exact admission.",
);
factBlock(
	"docs/runbooks/workflow-quickstart.ko.md",
	"workflow-profiles",
	"[생성된 지원 매트릭스](../support-matrix.ko.md#정확한-경로)에서 정확 경로와 상태를 확인하세요.\n" +
		"조건부 후속 버전 선택은 정확 admission과 별개입니다.",
);

artifacts.set(
	"src/core/tool-version-promotion-result.json",
	JSON.stringify(
		{
			schema_version: 1,
			implementation_scheme: "promotion-implementation-v1",
			implementation_digest: implementationDigest,
			effective_projection_digest: promotionProjectionDigest(projection),
		},
		null,
		2,
	) + "\n",
);
writeArtifacts();

function writeArtifacts() {
	const pending = [];
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
			if (check) {
				throw new Error(`tool_version_assets_missing:${path}`, {
					cause: error,
				});
			}
			current = null;
		}
		if (current !== expected) {
			if (check) throw new Error(`tool_version_assets_stale:${path}`);
			pending.push([path, expected]);
		}
	}
	for (const [path, expected] of pending) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), expected);
		changed.push([path, expected]);
	}
}
console.log(
	JSON.stringify({
		status: check
			? "tool_version_assets_current"
			: "tool_version_assets_generated",
		changed: changed.map(([path]) => path),
	}),
);
