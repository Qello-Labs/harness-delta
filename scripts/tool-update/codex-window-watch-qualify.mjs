import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createWindowClock } from "./codex-window-clock.mjs";
import { createWindowWatch } from "./codex-window-watch.mjs";

function requireOwnedBinary(path, name) {
	const canonical = realpathSync(path);
	const stat = lstatSync(canonical);
	if (
		basename(canonical) !== name || !stat.isFile() ||
		stat.uid !== process.getuid() ||
		stat.mode & 0o022
	) throw new Error("qualification_binary_identity");
	return canonical;
}

async function closeQualification(
	root,
	rootIdentity,
	watches,
	clock,
	cleanup,
	results,
	deniedCleanup,
) {
	const closed = await Promise.all(watches.map((watch) => watch.stop()));
	const clockResult = await clock.stop();
	if (
		cleanup && !clockResult.failed &&
		closed.every((result, index) =>
			result.cleanup_verified || deniedCleanup.has(watches[index])
		)
	) {
		const current = lstatSync(root);
		if (
			current.dev !== rootIdentity.dev ||
			current.ino !== rootIdentity.ino ||
			current.uid !== process.getuid()
		) throw new Error("qualification_root_identity");
		rmSync(root, { recursive: true });
		return;
	}
	console.error(JSON.stringify({ owned_root_retained: root, results }));
	throw new Error("qualification_cleanup_unverified");
}

const escapeScenarios = [
	{ name: "reparent-paused", mode: "reparent", paused: true },
	{ name: "reparent-setsid-paused", mode: "reparent-setsid", paused: true },
	{ name: "reparent", mode: "reparent", paused: false },
	{ name: "reparent-setsid", mode: "reparent-setsid", paused: false },
	{ name: "spawn", mode: "spawn", paused: false },
	{ name: "forkexec", mode: "forkexec", paused: false },
];

function processAbsent(pid) {
	try {
		process.kill(pid, 0);
		return false;
	} catch (error) {
		if (
			error instanceof Error && "code" in error && error.code === "ESRCH"
		) return true;
		throw error;
	}
}

function requireAbsent(identities) {
	for (const identity of identities) {
		if (!processAbsent(identity.pid)) throw new Error("owned_pid_still_present");
	}
}

// Nothing here is credit-paced: the fixture runs free once released, and the
// paused variants hold the guard still while a descendant escapes discovery.
async function qualifyEscape(scenario, clock, guardPath, targetPath, root) {
	const directory = join(root, scenario.name);
	mkdirSync(directory, { mode: 0o700 });
	const log = join(root, `${scenario.name}.log`);
	const identities = [];
	const exec = scenario.mode === "spawn" || scenario.mode === "forkexec";
	let owner, firstOverrun = null, released = false, reported = false;
	const settled = Promise.withResolvers();
	const deadline = (await clock.clock()) + 12000000000n;
	const peer = createWindowWatch({
		nativePath: guardPath,
		receiptDirectory: directory,
		priorExecs: 0,
		deadlineNs: String(deadline),
		executable: targetPath,
		args: [scenario.mode, exec ? "19" : "0", log],
		targetStdio: ["pipe", "pipe", "pipe"],
		onOwnerResource(value) {
			owner = value;
			identities.push(value);
		},
		onResource(value) {
			identities.push(value);
		},
		onRecord(event) {
			if (event.kind === "count" && event.exec_overshoot) {
				firstOverrun ??= event;
			}
			if (event.kind === "phase" && event.phase === "running") {
				released = true;
				if (scenario.paused) process.kill(owner.pid, "SIGSTOP");
				peer.targetStdio[0].write("+");
			}
		},
	});
	peer.targetStdio[1].on("data", (data) => {
		if ([...data].some((byte) => ![82, 83].includes(byte))) {
			void peer.stop();
			return;
		}
		reported = true;
		if (scenario.paused) process.kill(owner.pid, "SIGCONT");
		settled.resolve();
	});
	await peer.ready;
	await peer.launch();
	// An unpaused run can finish before the fixture reports; the result decides.
	void peer.result.then(settled.resolve);
	await settled.promise;
	const result = await peer.result;
	const escaped = existsSync(log)
		? readFileSync(log, "utf8").split("\n").filter(Boolean).map(Number)
		: [];
	for (const pid of escaped) {
		if (!processAbsent(pid)) throw new Error("escaped_process_survived");
	}
	for (const identity of identities) {
		if (!processAbsent(identity.pid)) {
			throw new Error("owned_pid_still_present");
		}
	}
	const unaccounted = result.unaccounted ?? 0;
	const passed = exec
		? result.failed && result.stop_batch && result.execs > 15 &&
			firstOverrun !== null && result.cleanup_verified
		: scenario.paused
		? escaped.length === 1 && reported && released &&
			result.failed && result.stop_batch && !result.cleanup_verified &&
			unaccounted >= 1
		: result.failed
		? result.stop_batch
		: result.cleanup_verified && unaccounted === 0;
	return {
		peer,
		row: {
			scenario: scenario.name,
			passed,
			escaped_pids_absent: escaped.length,
			first_overrun: firstOverrun,
			identities,
			result,
		},
	};
}

async function qualifyEscapes(target, sink) {
	for (const scenario of escapeScenarios) {
		const outcome = await qualifyEscape(
			scenario,
			target.clock,
			target.guardPath,
			target.targetPath,
			target.root,
		);
		sink.watches.push(outcome.peer);
		if (outcome.row.result.unaccounted > 0) {
			sink.deniedCleanup.add(outcome.peer);
		}
		sink.results.push(outcome.row);
	}
	const failed = sink.results.filter((row) => !row.passed);
	if (failed.length) {
		throw new Error(
			`qualification_failed_${failed.map((row) => row.scenario).join(",")}`,
		);
	}
}

export async function qualifyWindowWatch(nativePath, fixturePath) {
	if (process.platform !== "darwin") throw new Error("darwin_only");
	const guardPath = requireOwnedBinary(nativePath, "guard");
	const targetPath = requireOwnedBinary(fixturePath, "watch-fixture");
	const root = mkdtempSync(join(realpathSync(tmpdir()), "window-watch-"));
	const rootIdentity = lstatSync(root);
	const clock = createWindowClock({ nativePath: guardPath });
	const results = [];
	const watches = [];
	// An escaped descendant must deny positive cleanup; the harness checked
	// separately that it was killed.
	const deniedCleanup = new Set();
	let cleanup = false;
	try {
		await clock.ready;
		for (
			const scenario of ["exec", "exec-carry", "fork", "receipt", "hold"]
		) {
			const fixtureScenario = scenario === "exec-carry"
				? "exec"
				: scenario;
			const priorExecs = scenario === "exec-carry" ? 14 : 0;
			const directory = join(root, scenario);
			mkdirSync(directory, { mode: 0o700 });
			const identities = [];
			let peer, latest, reported = 0, credited = 0, running = false;
			let firstOverrun = null;
			let stopped = false;
			function drive() {
				if (!peer || stopped || !running) return;
				if (scenario === "hold") {
					if (reported) {
						stopped = true;
						void clock.clock().then((origin) => peer.stop(origin));
					}
					return;
				}
				if (credited >= 24 || reported < credited || !latest) return;
				const reconciled = fixtureScenario === "exec"
					? latest.execs >= priorExecs + reported &&
						reported > credited
					: scenario === "fork"
					? latest.live >= reported + 1
					: latest.receipts >= reported;
				if (!reconciled) return;
				peer.targetStdio[0].write("+");
				credited++;
			}
			const deadline = (await clock.clock()) + 12000000000n;
			peer = createWindowWatch({
				nativePath: guardPath,
				receiptDirectory: directory,
				priorExecs,
				deadlineNs: String(deadline),
				executable: targetPath,
				args: [
					fixtureScenario,
					"24",
					...(scenario === "receipt" ? [directory] : []),
				],
				targetStdio: ["pipe", "pipe", "pipe"],
				onOwnerResource(value) {
					identities.push(value);
				},
				onResource(value) {
					identities.push(value);
				},
				onRecord(event) {
					switch (event.kind) {
						case "count":
							latest = event;
							if (
								event.execs > 15 || event.live > 16 ||
								event.receipts > 16
							) {
								firstOverrun ??= event;
								stopped = true;
							}
							drive();
							break;
						case "phase":
							if (event.phase === "running") {
								running = true;
								drive();
							}
							break;
					}
				},
			});
			watches.push(peer);
			const output = peer.targetStdio?.[1];
			if (!output) throw new Error("fixture_output_missing");
			output.on("data", (data) => {
				if (
					[...data].some((byte) => ![69, 70, 82, 72].includes(byte))
				) {
					stopped = true;
					void peer.stop();
					return;
				}
				reported += data.length;
				drive();
			});
			await peer.ready;
			await peer.launch();
			const result = await peer.result;
			requireAbsent(identities);
			const passed = result.cleanup_verified &&
				(scenario === "hold"
					? !result.failed && result.term_ms !== null &&
						result.kill_ms !== null
					: result.failed && result.stop_batch &&
						firstOverrun !== null);
			results.push({
				scenario,
				prior_execs: priorExecs,
				passed,
				reported,
				credited,
				identities,
				first_overrun: firstOverrun,
				result,
			});
			if (!passed) throw new Error(`qualification_failed_${scenario}`);
		}
		await qualifyEscapes(
			{ clock, guardPath, targetPath, root },
			{ watches, results, deniedCleanup },
		);
		cleanup = true;
		return {
			vendor_execs: 0,
			results,
			cleanup_verified: true,
			root_removed: true,
		};
	} finally {
		await closeQualification(
			root,
			rootIdentity,
			watches,
			clock,
			cleanup,
			results,
			deniedCleanup,
		);
	}
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	if (
		process.argv[2] !== "--qualify-nonvendor" || process.argv.length !== 5
	) {
		throw new Error("explicit_nonvendor_opt_in_required");
	}
	console.log(
		JSON.stringify(
			await qualifyWindowWatch(process.argv[3], process.argv[4]),
		),
	);
}
