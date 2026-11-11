import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createSyntheticWindowCaseGuards } from "./codex-window-case-guards.mjs";
import { createWindowClock } from "./codex-window-clock.mjs";
import {
	createWindowBudget,
	ownedWindowDirectory,
	windowRequire,
} from "./codex-window-conformance.mjs";
import { reserveWindowConsent } from "./codex-window-consent.mjs";
import { runWindowTool } from "./codex-window-containment.mjs";
import { verifyWindowResourceRegistry } from "./codex-window-registry.mjs";

function reserveSyntheticConsent(root) {
	const pins = Object.fromEntries(
		[
			"native",
			"host",
			"source",
			"build",
			"instrument",
			"runtime",
			"lockfile",
			"config",
			"environment",
			"egress",
			"quota",
		]
			.map(
				(name) => [
					name,
					createHash("sha256").update(`synthetic-only:${name}`)
						.digest("hex"),
				],
			),
	);
	const intent = {
		schema_version: 1,
		kind: "codex_window_disabled_intent",
		authority: "none",
		execution_enabled: false,
		actual_qualification: false,
		case_id: "normal",
		case_root: root,
		plan_digest: "a".repeat(64),
		plan: {
			schema_version: 1,
			product: "codex",
			version: "0.167.0",
			commit: "086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a",
			route: "codex_binding",
			policy_id: "codex-binding-root-window-v1",
			operation: "collect",
			topology: "root",
			runtime: "node24",
			platform: "darwin_arm64",
			model: "gpt-6.1-sol",
			effort: "high",
			pins,
		},
		owner_ms: 120000,
		cleanup_ms: 5000,
		audit_reserve_ms: 10000,
		containment_qualified: false,
	};
	const bytes = JSON.stringify(intent);
	const intentFile = join(root, "intent.json"),
		consentFile = join(root, "consent.json");
	writeFileSync(intentFile, bytes, { flag: "wx", mode: 0o600 });
	const now = Date.now();
	writeFileSync(
		consentFile,
		JSON.stringify({
			schema_version: 1,
			kind: "codex_window_b1_consent",
			consent_id: randomUUID(),
			approval_reference: "b".repeat(64),
			issued_at: now,
			expires_at: now + 120000,
			intent_sha256: createHash("sha256").update(bytes).digest("hex"),
			case_id: "normal",
			case_root: root,
			product: "codex",
			version: "0.167.0",
			operation: "collect",
			topology: "root",
			pins,
		}),
		{ flag: "wx", mode: 0o600 },
	);
	return {
		capability: reserveWindowConsent({
			intentFile,
			consentFile,
			observedPins: pins,
		}),
		observedPins: pins,
		scenario: "hold",
	};
}

function absentPid(identity) {
	try {
		process.kill(identity.pid, 0);
	} catch (error) {
		if (error?.code === "ESRCH") return;
		throw error;
	}
	throw new Error("batch_audit_clock_still_present");
}

export async function qualifySyntheticWindowCaseGuards(
	{ root, prerequisitesReady },
) {
	windowRequire(prerequisitesReady === true, "prerequisites_not_ready");
	windowRequire(
		process.platform === "darwin" && process.arch === "arm64" &&
			process.versions.node.split(".")[0] === "24",
		"qualification_host_invalid",
	);
	ownedWindowDirectory(root);
	const batchGuardRoot = join(root, "batch-guards");
	const caseRoot = join(root, "case");
	mkdirSync(batchGuardRoot, { mode: 0o700 });
	mkdirSync(caseRoot, { mode: 0o700 });
	const exportRoot = join(root, "evidence-export");
	mkdirSync(exportRoot, { mode: 0o700 });
	const guardIdentity = lstatSync(batchGuardRoot);
	const nativePath = join(batchGuardRoot, "guard");
	const source = join(
		dirname(fileURLToPath(import.meta.url)),
		"codex-window-guard-native.c",
	);
	const compilation = await runWindowTool("/usr/bin/clang", [
		"-std=c11",
		"-Wall",
		"-Wextra",
		"-Werror",
		"-O2",
		source,
		"-o",
		nativePath,
	], { root: batchGuardRoot, timeoutMs: 30000 });
	windowRequire(compilation.code === 0, "native_compile_failed");
	const owners = [];
	// This is a batch audit service, not a disposable case helper. Its owned root
	// is charged to the case; it remains alive until the case verifier has finished.
	const auditClock = createWindowClock({
		nativePath,
		env: {
			PATH: "/usr/bin:/bin",
			HOME: batchGuardRoot,
			TMPDIR: batchGuardRoot,
			LC_ALL: "C",
			TZ: "UTC",
		},
		onOwnerResource: async (identity) => {
			owners.push(identity);
			writeFileSync(
				join(root, "batch-clock-identity.json"),
				JSON.stringify(identity),
				{ flag: "wx", mode: 0o600 },
			);
		},
	});
	let guards, result, failure = null, auditClosed = null;
	try {
		await auditClock.ready;
		const batchStartedMs = Number(await auditClock.clock() / 1000000n);
		const budget = createWindowBudget(batchStartedMs);
		guards = createSyntheticWindowCaseGuards({
			root: caseRoot,
			nativePath,
			caseId: "normal",
			batchStartedMs,
			priorExecs: 0,
			budget,
			auditClock,
			guardRoots: [root],
			evidenceExportRoot: exportRoot,
		});
		const prepared = await guards.prepare();
		result = await guards.run(reserveSyntheticConsent(prepared.caseRoot));
		windowRequire(
			!result.failed && result.cleanup_verified && result.registry &&
				result.evidence_export?.files.length === 1 &&
				existsSync(join(exportRoot, "synthetic-case.json")),
			result.reason ?? "qualification_failed",
		);
		await verifyWindowResourceRegistry(result.registry, {
			checkDeadline: async () => {
				const now = Number(await auditClock.clock() / 1000000n);
				windowRequire(
					now <=
							Number(BigInt(result.stop_origin_ns) / 1000000n) +
								5000 && now <= batchStartedMs + 1190000,
					"qualification_cleanup_deadline",
				);
			},
		});
	} catch (error) {
		failure = error instanceof Error
			? error.message
			: "qualification_failed";
	} finally {
		if (guards && !result) {
			result = await guards.stop(failure ?? "qualification_aborted");
		}
		try {
			auditClosed = await auditClock.stop(
				result ? BigInt(result.stop_origin_ns) : undefined,
			);
			windowRequire(!auditClosed.failed, "audit_clock_cleanup_failed");
			for (const identity of owners) absentPid(identity);
			const current = lstatSync(batchGuardRoot);
			windowRequire(
				current.dev === guardIdentity.dev &&
					current.ino === guardIdentity.ino &&
					current.uid === guardIdentity.uid,
				"batch_guard_identity_changed",
			);
			rmSync(batchGuardRoot, { recursive: true });
		} catch (error) {
			failure ??= error instanceof Error
				? error.message
				: "batch_cleanup_failed";
		}
	}
	const evidence = {
		origin: "local_nonvendor",
		actual_qualification: false,
		execution_enabled: false,
		vendor_execs: 0,
		runtime: process.version,
		result: result ?? null,
		batch_clock_identities: owners,
		batch_clock_result: auditClosed,
		passed: failure === null,
		failure,
		physical_cleanup: result?.cleanup_verified === true && failure === null,
		limitations: [
			"vendor_containment_unqualified",
			"pty_composition_unqualified",
			"native_recipe_composition_unqualified",
		],
	};
	writeFileSync(
		join(root, "qualification.json"),
		JSON.stringify(evidence, null, 2) + "\n",
		{ flag: "wx", mode: 0o600 },
	);
	windowRequire(evidence.passed, failure ?? "qualification_failed");
	return evidence;
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	windowRequire(
		process.argv.length === 5 &&
			process.argv[2] === "--qualify-nonvendor" &&
			process.argv[3] === "--prerequisites-ready",
		"explicit_nonvendor_readiness_required",
	);
	console.log(
		JSON.stringify(
			await qualifySyntheticWindowCaseGuards({
				root: realpathSync(process.argv[4]),
				prerequisitesReady: true,
			}),
		),
	);
}
