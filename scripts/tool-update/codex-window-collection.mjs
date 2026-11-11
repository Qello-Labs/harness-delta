import { mkdirSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { Store } from "../../dist/store.js";
import { Lifecycle } from "../../dist/core/lifecycle.js";
import { createOrdinaryWindowTask } from "../../dist/ordinary-observation.js";
import { ordinaryWindowSelection } from "../../dist/core/ordinary-window-store.js";
import {
	ordinaryWindowRuntimeRevision,
	ordinaryWindowTrialBudgetBasis,
} from "../../dist/core/ordinary-window-decision.js";
import {
	activateOrdinaryWindowDecision,
	revokeOrdinaryWindowDecisionRow,
} from "../../dist/core/ordinary-window-activation.js";
import {
	collectOrdinaryCodexWindow,
	connectOrdinaryCodexWindow,
} from "../../dist/ordinary-session-binding.js";
import { CodexWindowPendingReceiptSchema } from "../../dist/session-binding-codex.js";
import {
	revalidateWindowConsent,
	writeConsentedWindowEmission,
} from "./codex-window-consent.mjs";
import {
	ownedWindowDirectory,
	windowRequire,
} from "./codex-window-conformance.mjs";

function trialPacket(selection, taskId, nativeRootId, durationMs) {
	return {
		schema_version: 1,
		kind: "ordinary_window_activation",
		decision_kind: "trial",
		decision_ref: "synthetic-window-trial",
		project_id: selection.projectId,
		product: "codex",
		source: selection.policy.source,
		policy_id: selection.policy.policyId,
		policy_revision: selection.policy.ruleRevision,
		policy_digest: selection.policyDigest,
		evidence_mode: selection.policy.evidenceMode,
		accepted_risks: ["source_identity_limits", "root_ownership_unverified"],
		implementation_revision: ordinaryWindowRuntimeRevision,
		evidence_ref: "synthetic-only",
		review_ref: "not-actual-qualification",
		task_id: taskId,
		native_root_id: nativeRootId,
		duration_ms: durationMs,
		token_limit: 32000,
		token_budget_basis: ordinaryWindowTrialBudgetBasis,
	};
}

export function createSyntheticWindowCollection(capability, observedPins) {
	const verified = revalidateWindowConsent(capability, observedPins);
	windowRequire(verified.origin === "synthetic", "b1_execution_disabled");
	const projectRoot = join(verified.caseRoot, "project");
	const home = join(verified.caseRoot, "codex-home");
	const sourceRoot = join(home, "sessions");
	for (const path of [projectRoot, home, sourceRoot]) {
		mkdirSync(path, { mode: 0o700 });
		ownedWindowDirectory(path);
	}
	const control = writeConsentedWindowEmission(capability, observedPins);
	const receiptDirectory = join(
		projectRoot,
		".harness-delta",
		"window-receipts",
	);
	const clock = () => new Date().toISOString();
	const store = new Store(":memory:", clock);
	const lifecycle = new Lifecycle(store, clock);
	let closed = false, rootSessionId, decision;
	let taskId;
	const close = () => {
		if (closed) return;
		closed = true;
		try {
			control.close();
			if (decision) {
				revokeOrdinaryWindowDecisionRow(store, decision, {
					at: clock(),
					reason: "trial_failed",
				});
			}
			if (
				taskId &&
				store.get("SELECT state FROM tasks WHERE id=?", [taskId])
						?.state === "active"
			) {
				lifecycle.pause(taskId);
			}
		} finally {
			store.close();
		}
	};
	const check = () => {
		windowRequire(!closed, "case_stopped");
		control.check();
	};
	try {
		lifecycle.registerProject("synthetic-conformance", projectRoot);
		taskId = createOrdinaryWindowTask(store, {
			schema_version: 2,
			mode: "ordinary_window",
			project_id: "synthetic-conformance",
			product: "codex",
			declared_version: "0.167.0",
			policy_id: "codex-binding-root-window-v1",
			criterion_ids: ["accepted"],
		}, clock);
		const selection = ordinaryWindowSelection(store, taskId);
		windowRequire(selection, "task_selection_missing");
		const options = {
			store,
			taskId,
			receiptDirectory,
			sourceRoots: [sourceRoot],
			clock: () => {
				// External consent cannot be atomic with the Store transaction.
				check();
				return clock();
			},
		};
		return Object.freeze({
			origin: "synthetic",
			actual_qualification: false,
			store,
			taskId,
			projectRoot,
			sourceRoot,
			receiptDirectory,
			async connect(input) {
				check();
				windowRequire(!decision, "reservation_reused");
				const pending = CodexWindowPendingReceiptSchema.parse(input);
				windowRequire(
					pending.event === "SessionStart" &&
						pending.agentId === null &&
						pending.nativeRootSessionId ===
							pending.nativeSessionId &&
						pending.cwd === projectRoot,
					"binding_root_only_required",
				);
				windowRequire(
					pending.sourceRef !== null,
					"binding_identity_missing",
				);
				const distance = relative(sourceRoot, pending.sourceRef);
				windowRequire(
					distance !== "" && distance !== ".." &&
						!distance.startsWith(`..${sep}`) &&
						!isAbsolute(distance),
					"input_scope_invalid",
				);
				const durationMs = Math.min(
					60000,
					verified.expiresAt - Date.now(),
				);
				windowRequire(durationMs >= 1000, "consent_expired");
				decision = activateOrdinaryWindowDecision(
					store,
					trialPacket(
						selection,
						taskId,
						pending.nativeSessionId,
						durationMs,
					),
					clock(),
				);
				lifecycle.start(taskId);
				const connected = await connectOrdinaryCodexWindow(options, {
					receipt: pending.receipt,
				});
				check();
				rootSessionId = connected.rootSessionId;
				return {
					baseline_established: true,
					actual_qualification: false,
				};
			},
			async collect() {
				check();
				windowRequire(rootSessionId, "baseline_missing");
				await collectOrdinaryCodexWindow(options, rootSessionId);
				check();
			},
			close,
		});
	} catch (error) {
		close();
		throw error;
	}
}
