// dev smoke/regression suite for pi-engineering-loop.
// Requires a dev environment with pi-subagents installed under Pi's
// managed npm directory (the suites import its public API). Creates
// throwaway temp workspaces and checkpoint roots; never touches real
// Pi state. Run: node <pi-package>/node_modules/.bin/jiti tests/<file>.mjs
// v1.2 isolated-verification smoke test for the engineering-loop extension.
// The harness acts as the pi-subagents delegation bridge: it captures
// SUBAGENT_DELEGATION_REQUEST_EVENT payloads and answers them with
// SUBAGENT_DELEGATION_RESPONSE_EVENT payloads on the same mock event bus.

// v1.4: older regression suites run against /home/hariz (non-empty); force
// scouting off so the pre-v1.4 flows are exercised exactly as before.
process.env.ENGINEERING_LOOP_SCOUT_DISABLE = "1";
// v1.5: these suites predate change tracking; disable baselines (their
// workspaces would otherwise be scanned).
process.env.ENGINEERING_LOOP_BASELINE_DISABLE = "1";
process.env.ENGINEERING_LOOP_VERIFIER_TIMEOUT_MS = "50";
process.env.ENGINEERING_LOOP_VERIFIER_GRACE_MS = "100";

const EXT_PATH = "/home/hariz/pi-engineering-loop/extension/index.ts";
const API_PATH =
	"/home/hariz/.pi/agent/npm/node_modules/pi-subagents/src/api/delegation.ts";
const CEILING_API_PATH =
	"/home/hariz/.pi/agent/npm/node_modules/pi-subagents/src/api/capability-ceiling.ts";

let passed = 0;
let failed = 0;
function check(name, cond, extra = "") {
	if (cond) {
		passed++;
		console.log(`  ok: ${name}`);
	} else {
		failed++;
		console.log(`  FAIL: ${name} ${extra}`);
	}
}

// Load the extension through jiti configured with pi's typebox alias (the
// extension imports `typebox`; only pi's loader provides that alias).
import { createRequire } from "node:module";
const requirePi = createRequire("/home/hariz/.nvm/versions/node/v22.23.1/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js");
const { createJiti } = await import("/home/hariz/.nvm/versions/node/v22.23.1/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs");
const testJiti = createJiti("/home/hariz/.nvm/versions/node/v22.23.1/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js", {
	moduleCache: true,
	alias: {
		typebox: requirePi.resolve("typebox"),
		"typebox/compile": requirePi.resolve("typebox/compile"),
		"typebox/value": requirePi.resolve("typebox/value"),
	},
});
const loadExt = () => testJiti.import(EXT_PATH);

const { SUBAGENT_DELEGATION_REQUEST_EVENT, SUBAGENT_DELEGATION_RESPONSE_EVENT, SUBAGENT_DELEGATION_CANCEL_EVENT } =
	await import(API_PATH);
const { resolveCurrentSubagentCapabilityCeiling } = await import(CEILING_API_PATH);

function makeHarness(seedEntries = [], cwd = "/home/hariz", sessionId = "test-session") {
	const entries = [...seedEntries];
	const sent = [];
	const notifies = [];
	const commands = {};
	const handlers = {};
	const requests = [];
	const tools = {};
	const cancels = [];
	const handlersByChannel = new Map();
	let idle = true;

	const events = {
		on(channel, handler) {
			if (!handlersByChannel.has(channel)) handlersByChannel.set(channel, []);
			handlersByChannel.get(channel).push(handler);
			return () => {
				const list = handlersByChannel.get(channel);
				if (!list) return;
				const i = list.indexOf(handler);
				if (i >= 0) list.splice(i, 1);
			};
		},
		emit(channel, data) {
			for (const handler of [...(handlersByChannel.get(channel) ?? [])]) handler(data);
		},
	};
	// act as the delegation bridge: capture requests, allow scripted responses
	events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (req) => requests.push(req));
	events.on(SUBAGENT_DELEGATION_CANCEL_EVENT, (req) => cancels.push(req));

	const pi = {
		events,
		on(n, h) {
			(handlers[n] ??= []).push(h);
		},
		registerCommand(n, o) {
			commands[n] = o;
		},
		registerTool(t) {
			tools[t.name] = t;
		},
		appendEntry(t, d) {
			entries.push({
				type: "custom",
				customType: t,
				id: `e${entries.length}`,
				parentId: null,
				timestamp: new Date().toISOString(),
				data: JSON.parse(JSON.stringify(d)),
			});
		},
		sendUserMessage(c, o) {
			if (!idle && !o?.deliverAs) throw new Error("sendUserMessage while streaming requires deliverAs");
			sent.push({ content: c });
		},
	};

	const ctx = {
		cwd,
		isIdle: () => idle,
		ui: { notify: (msg, level) => notifies.push({ msg, level }) },
		sessionManager: {
			getSessionId: () => sessionId,
			getEntries: () => entries,
			getBranch: () => entries.filter((e) => e.type !== "custom"),
		},
	};

	return {
		pi,
		ctx,
		events,
		entries,
		sent,
		notifies,
		commands,
		handlers,
		tools,
		requests,
		cancels,
		sessionId,
		setBusy: (b) => (idle = !b),
	};
}

const assistantEntry = (text) => ({
	type: "message",
	id: `m${Math.random().toString(36).slice(2)}`,
	parentId: null,
	timestamp: new Date().toISOString(),
	message: { role: "assistant", content: [{ type: "text", text }] },
});

const settled = async (h, branch) => {
	// v1.3 completion gate: a DONE settle only launches the verifier when the
	// structured plan is fully completed. These legacy tests assume the
	// engineer already finished its work, so auto-complete a minimal plan
	// before the settle is processed.
	const last = branch[branch.length - 1];
	const text = last?.message?.content?.[0]?.text ?? "";
	if (text.includes("<ENGINEER_DONE>") && h.tools) {
		const st = h.entries[h.entries.length - 1]?.data;
		if (st && st.status === "running") {
			try { await h.tools.engineer_plan_create.execute("id", { tasks: [{ title: "Implement" }] }, undefined, undefined, h.ctx); } catch {}
			try { await h.tools.engineer_task_start.execute("id", { taskId: "T1" }, undefined, undefined, h.ctx); } catch {}
			try { await h.tools.engineer_task_complete.execute("id", { taskId: "T1", evidence: "stub" }, undefined, undefined, h.ctx); } catch {}
		}
	}
	h.ctx.sessionManager.getBranch = () => branch;
	for (const handler of h.handlers.agent_settled ?? []) await handler({ type: "agent_settled" }, h.ctx);
};
const sessionStart = async (h) => {
	for (const handler of h.handlers.session_start ?? [])
		await handler({ type: "session_start", reason: "startup" }, h.ctx);
};
const cmd = async (h, args) => {
	await h.commands.engineer.handler(args, h.ctx);
};
const lastState = (h) => h.entries[h.entries.length - 1].data;
const respond = (h, request, payload) =>
	h.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, { requestId: request.requestId, ...payload });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
console.log("test 1: PASS flow through the isolated verifier");
{
	const h = makeHarness();
	const mod = await loadExt();
	mod.default(h.pi);
	await sessionStart(h);
	await cmd(h, "Create an add function with tests");

	// engineer claims done -> verifying phase -> delegation request
	await settled(h, [assistantEntry("implemented\n<ENGINEER_DONE>")]);
	let st = lastState(h);
	check("phase verifying persisted", st.phase === "verifying");
	check("attempts 1", st.verificationAttempts === 1);
	check("exactly one delegation request", h.requests.length === 1);
	const req = h.requests[0];
	check("request agent", req.agent === "engineering-verifier");
	check("request context fresh", req.context === "fresh");
	check("request cwd from state", req.cwd === "/home/hariz");
	check("request thinking high", req.thinking === "high");
	check("request timeoutMs", req.timeoutMs === 50); // TEST-ONLY env override of 600000 default
	check("request structured result", req.result?.kind === "structured");
	const schema = req.result?.schema ?? {};
	check(
		"schema requires verdict+findings",
		Array.isArray(schema.required) &&
			schema.required.includes("verdict") &&
			schema.required.includes("findings"),
	);
	check(
		"schema verdict enum pass/fail",
		Array.isArray(schema.properties?.verdict?.enum) &&
			schema.properties.verdict.enum.includes("pass") &&
			schema.properties.verdict.enum.includes("fail"),
	);
	check("task carries ORIGINAL GOAL", req.task.includes("ORIGINAL GOAL:"));
	check("task carries the goal text", req.task.includes("Create an add function with tests"));
	check("task carries WORKSPACE", req.task.includes("WORKSPACE:\n/home/hariz"));
	check("no parent-engineer turn sent", h.sent.length === 1); // only iteration 1

	// status while verifier active
	await cmd(h, "status");
	let sn = h.notifies[h.notifies.length - 1];
	check("status shows verifier agent", sn.msg.includes("Verifier: engineering-verifier"));
	check("status shows verifier active", sn.msg.includes("Verifier active: yes"));
	check("status shows phase verifying", sn.msg.includes("Phase: verifying"));

	// ceiling registered while run active
	await sleep(30);
	const ceiling = resolveCurrentSubagentCapabilityCeiling(h.sessionId);
	check("capability ceiling registered", !!ceiling);
	check("ceiling allows verifier agent", ceiling?.allowedAgents?.includes("engineering-verifier"));
	check("ceiling restricts tools", ceiling?.allowedTools?.includes("bash") && !ceiling?.allowedTools?.includes("write"));

	// verifier passes
	respond(h, req, { status: "completed", result: { kind: "structured", value: { verdict: "pass", findings: "All tests pass." } } });
	st = lastState(h);
	check("status done", st.status === "done");
	check("consecutive failures 0", st.consecutiveVerificationFailures === 0);
	check("lastVerificationFailure cleared", st.lastVerificationFailure === null);
	check("notify isolated verification passed", h.notifies.some((n) => n.msg === "Engineering loop complete — isolated verification passed"));
	check("no engineering iteration after pass", h.sent.length === 1);

	// ceiling disposed on done
	await sleep(10);
	check("ceiling disposed after done", resolveCurrentSubagentCapabilityCeiling(h.sessionId) === undefined);
}

// ---------------------------------------------------------------------------
console.log("test 2: FAIL -> repair -> PASS full cycle");
{
	const h = makeHarness();
	const mod = await loadExt();
	mod.default(h.pi);
	await sessionStart(h);
	await cmd(h, "Build a CLI with tests");

	await settled(h, [assistantEntry("done\n<ENGINEER_DONE>")]);
	const req1 = h.requests[0];

	respond(h, req1, { status: "completed", result: { kind: "structured", value: { verdict: "fail", findings: "Missing --help flag; no tests." } } });
	let st = lastState(h);
	check("phase back to engineering", st.phase === "engineering");
	check("consecutive 1", st.consecutiveVerificationFailures === 1);
	check("failure summary stored", st.lastVerificationFailure?.summary === "Missing --help flag; no tests.");
	check("notify isolated verification failed", h.notifies.some((n) => n.msg.includes("Isolated verification failed")));
	const repairPrompt = h.sent[h.sent.length - 1];
	check("repair prompt iteration 2", repairPrompt.content.includes("iteration 2/15"));
	check("repair has PREVIOUS VERIFICATION FAILURE", repairPrompt.content.includes("PREVIOUS VERIFICATION FAILURE:"));
	check("repair carries findings", repairPrompt.content.includes("Missing --help flag; no tests."));
	check("repair has new directive", repairPrompt.content.includes("You must address this failure before requesting verification again."));

	// engineer repairs, claims done again -> SECOND fresh request, same ownerRunId
	await settled(h, [assistantEntry("fixed\n<ENGINEER_DONE>")]);
	check("second request launched", h.requests.length === 2);
	check("ownerRunId stable across attempts", h.requests[1].ownerRunId === req1.ownerRunId);
	check("requestIds unique", h.requests[1].requestId !== req1.requestId);
	check("ownerRunId derives from startedAt", req1.ownerRunId.endsWith(String(st.startedAt)));
	check("attempts 2", lastState(h).verificationAttempts === 2);

	respond(h, h.requests[1], { status: "completed", result: { kind: "structured", value: { verdict: "pass", findings: "Now correct." } } });
	st = lastState(h);
	check("status done after repair pass", st.status === "done");
	check("consecutive reset", st.consecutiveVerificationFailures === 0);
}

// ---------------------------------------------------------------------------
console.log("test 3: infrastructure failures block without verdict semantics");
{
	const h = makeHarness();
	const mod = await loadExt();
	mod.default(h.pi);
	await sessionStart(h);
	await cmd(h, "Goal");
	await settled(h, [assistantEntry("x\n<ENGINEER_DONE>")]);
	respond(h, h.requests[0], { status: "invalid_request", error: "bad payload" });
	let st = lastState(h);
	check("status blocked on invalid_request", st.status === "blocked");
	check("lastAction infrastructure", st.lastAction.includes("verifier infrastructure failure"));
	check("consecutive NOT incremented", st.consecutiveVerificationFailures === 0);
	check("infra notify", h.notifies.some((n) => n.msg.includes("verifier infrastructure failure")));
	check("no engineer prompt after infra block", h.sent.length === 1);
}

// ---------------------------------------------------------------------------
console.log("test 4: runtime verifier failures are conservative failures");
{
	const h = makeHarness();
	const mod = await loadExt();
	mod.default(h.pi);
	await sessionStart(h);
	await cmd(h, "Goal");
	await settled(h, [assistantEntry("x\n<ENGINEER_DONE>")]);
	respond(h, h.requests[0], { status: "timed_out", error: "verifier exceeded deadline" });
	let st = lastState(h);
	check("phase engineering after runtime failure", st.phase === "engineering");
	check("consecutive 1", st.consecutiveVerificationFailures === 1);
	check("understandable error stored", st.lastVerificationFailure?.summary.includes("Verifier error (timed_out)"));
	check("not done", st.status !== "done");
	const p = h.sent[h.sent.length - 1];
	check("engineer told about verifier error", p.content.includes("Verifier error (timed_out)"));
}

// ---------------------------------------------------------------------------
console.log("test 5: stop cancels the delegation; late responses are ignored");
{
	const h = makeHarness();
	const mod = await loadExt();
	mod.default(h.pi);
	await sessionStart(h);
	await cmd(h, "Goal");
	await settled(h, [assistantEntry("x\n<ENGINEER_DONE>")]);
	const req = h.requests[0];

	await cmd(h, "stop");
	check("status stopped", lastState(h).status === "stopped");
	check("cancel event emitted for the request", h.cancels.some((c) => c.requestId === req.requestId));
	check("cancel carries identity", h.cancels[0]?.ownerRunId === req.ownerRunId && h.cancels[0]?.nodeId === "verification");
	await cmd(h, "status");
	check("status no longer shows verifier active", !h.notifies[h.notifies.length - 1].msg.includes("Verifier active"));

	// late PASS must not resurrect the run
	respond(h, req, { status: "completed", result: { kind: "structured", value: { verdict: "pass", findings: "late" } } });
	check("late response ignored", lastState(h).status === "stopped");
	check("no complete notify", !h.notifies.some((n) => n.msg === "Engineering loop complete — isolated verification passed"));
}

// ---------------------------------------------------------------------------
console.log("test 6: no duplicate launches, duplicate responses ignored");
{
	const h = makeHarness();
	const mod = await loadExt();
	mod.default(h.pi);
	await sessionStart(h);
	await cmd(h, "Goal");
	const branch = [assistantEntry("done\n<ENGINEER_DONE>")];
	await settled(h, branch);
	await settled(h, branch); // duplicate settle -> skipped
	check("only one request", h.requests.length === 1);

	const req = h.requests[0];
	respond(h, req, { status: "completed", result: { kind: "structured", value: { verdict: "pass", findings: "ok" } } });
	respond(h, req, { status: "completed", result: { kind: "structured", value: { verdict: "fail", findings: "duplicate" } } });
	check("duplicate response ignored", lastState(h).status === "done");
	check("no engineering turn after duplicate response", h.sent.length === 1);
}

// ---------------------------------------------------------------------------
console.log("test 7: resume in verifying phase launches a fresh verifier");
{
	const seed = {
		goal: "Resume goal",
		cwd: "/home/hariz",
		status: "stopped",
		phase: "verifying",
		iteration: 3,
		maxIterations: 15,
		startedAt: 12345,
		lastAction: "stopped",
		completionCandidate: false,
		verificationAttempts: 2,
		lastVerificationResult: null,
		consecutiveVerificationFailures: 0,
		lastVerificationFailure: null,
		needsReplan: false,
		testCriterion: null,
		verifierAgent: "engineering-verifier",
	};
	const seeded = [{ type: "custom", customType: "engineering-loop", id: "s1", parentId: null, timestamp: "t", data: seed }];
	const h = makeHarness(seeded);
	const mod = await loadExt();
	mod.default(h.pi);
	await sessionStart(h);
	await cmd(h, "resume");
	check("fresh request launched on resume", h.requests.length === 1);
	check("resume request uses stored cwd", h.requests[0].cwd === "/home/hariz");
	check("resume request uses run ownerRunId", h.requests[0].ownerRunId.endsWith(":12345"));
	check("resume request agent", h.requests[0].agent === "engineering-verifier");
	check("attempts 3 after resume", lastState(h).verificationAttempts === 3);
	respond(h, h.requests[0], { status: "completed", result: { kind: "structured", value: { verdict: "pass", findings: "ok" } } });
	check("done after resume verification", lastState(h).status === "done");
}

// ---------------------------------------------------------------------------
console.log("test 8: deadline backstop when no response arrives");
{
	const h = makeHarness();
	const mod = await loadExt();
	mod.default(h.pi);
	await sessionStart(h);
	await cmd(h, "Goal");
	await settled(h, [assistantEntry("x\n<ENGINEER_DONE>")]);
	check("request launched", h.requests.length === 1);
	// no response; deadline = 50 + 100 = 150ms
	await sleep(250);
	const st = lastState(h);
	check("no_response handled", st.phase === "engineering" && st.consecutiveVerificationFailures === 1);
	check("no_response summary stored", st.lastVerificationFailure?.summary.includes("no_response"));
	check("engineer prompt triggered", h.sent.length === 2);
}

// ---------------------------------------------------------------------------
console.log("test 9: malformed structured result is a conservative failure");
{
	const h = makeHarness();
	const mod = await loadExt();
	mod.default(h.pi);
	await sessionStart(h);
	await cmd(h, "Goal");
	await settled(h, [assistantEntry("x\n<ENGINEER_DONE>")]);
	respond(h, h.requests[0], { status: "completed", result: { kind: "structured", value: { verdict: "maybe" } } });
	const st = lastState(h);
	check("malformed verdict treated as failure", st.phase === "engineering" && st.consecutiveVerificationFailures === 1);
	check("invalid result noted", st.lastVerificationFailure?.summary.includes("invalid structured result"));
}

// ---------------------------------------------------------------------------
console.log("test 10: --test-failure arms a verifier-only criterion (full cycle)");
{
	const h = makeHarness();
	const mod = await loadExt();
	mod.default(h.pi);
	await sessionStart(h);

	await cmd(h, "--test-failure Build a CLI");
	let st = lastState(h);
	check("criterion stored in state", st.testCriterion?.file === ".engineering-loop-verifier-sentinel" && st.testCriterion?.content === "VERIFIER_REPAIR_CONFIRMED");
	check("criterion armed notify", h.notifies.some((n) => n.msg.includes("Test verification criterion armed")));
	// engineer iteration 1 MUST NOT see the criterion
	const iter1 = h.sent[0].content;
	check("iteration 1 has no criterion block", !iter1.includes("TEST-ONLY VERIFICATION CRITERION"));
	check("iteration 1 has no sentinel", !iter1.includes(".engineering-loop-verifier-sentinel"));
	check("iteration 1 has no content", !iter1.includes("VERIFIER_REPAIR_CONFIRMED"));
	check("no sabotage instruction anywhere", !iter1.includes("TEST HARNESS INSTRUCTION"));
	await cmd(h, "status");
	check("status shows criterion active", h.notifies[h.notifies.length - 1].msg.includes("Test verification criterion: active"));

	// engineer claims done -> verifier attempt 1 SEES the criterion
	await settled(h, [assistantEntry("done\n<ENGINEER_DONE>")]);
	check("request launched", h.requests.length === 1);
	const task1 = h.requests[0].task;
	check("verifier task carries criterion block", task1.includes("TEST-ONLY VERIFICATION CRITERION:"));
	check("verifier task carries sentinel file", task1.includes(".engineering-loop-verifier-sentinel"));
	check("verifier task carries exact content", task1.includes("VERIFIER_REPAIR_CONFIRMED"));
	check("verifier task treats absence as failure", task1.includes("Treat absence or incorrect content as a verification failure."));

	// verifier rejects -> findings reach engineer iteration 2
	respond(h, h.requests[0], {
		status: "completed",
		result: { kind: "structured", value: { verdict: "fail", findings: "Missing .engineering-loop-verifier-sentinel with VERIFIER_REPAIR_CONFIRMED." } },
	});
	st = lastState(h);
	check("phase engineering after criterion fail", st.phase === "engineering");
	check("criterion still armed after fail", st.testCriterion?.file === ".engineering-loop-verifier-sentinel");
	const iter2 = h.sent[h.sent.length - 1].content;
	check("iteration 2 carries FAIL findings", iter2.includes("Missing .engineering-loop-verifier-sentinel with VERIFIER_REPAIR_CONFIRMED."));
	check("iteration 2 has PREVIOUS VERIFICATION FAILURE", iter2.includes("PREVIOUS VERIFICATION FAILURE:"));
	check("iteration 2 does NOT see criterion block", !iter2.includes("TEST-ONLY VERIFICATION CRITERION"));

	// engineer repairs (creates sentinel), claims done -> attempt 2 SAME criterion
	await settled(h, [assistantEntry("sentinel created\n<ENGINEER_DONE>")]);
	check("attempt 2 launched", h.requests.length === 2);
	const task2 = h.requests[1].task;
	check("attempt 2 carries the SAME criterion", task2.includes(".engineering-loop-verifier-sentinel") && task2.includes("VERIFIER_REPAIR_CONFIRMED"));
	check("criterion unchanged in state for attempt 2", lastState(h).testCriterion?.content === "VERIFIER_REPAIR_CONFIRMED");

	// verifier passes -> criterion cleared
	respond(h, h.requests[1], { status: "completed", result: { kind: "structured", value: { verdict: "pass", findings: "Sentinel present." } } });
	st = lastState(h);
	check("status done", st.status === "done");
	check("criterion cleared after pass", st.testCriterion === null);
	check("complete report notify", h.notifies.some((n) => n.msg.includes("Engineering run complete") && n.msg.includes("Verification: passed")));
}

console.log("test 11: normal runs never arm the criterion");
{
	const h = makeHarness();
	const mod = await loadExt();
	mod.default(h.pi);
	await sessionStart(h);
	await cmd(h, "Normal goal");
	check("no criterion in fresh state", lastState(h).testCriterion === null);
	await settled(h, [assistantEntry("done\n<ENGINEER_DONE>")]);
	check("verifier task has no criterion", !h.requests[0].task.includes("TEST-ONLY VERIFICATION CRITERION"));
	await cmd(h, "status");
	check("status shows no criterion", !h.notifies[h.notifies.length - 1].msg.includes("Test verification criterion"));
}

console.log("test 12: stop clears the criterion; reload/resume preserves it");
{
	const h = makeHarness();
	const mod = await loadExt();
	mod.default(h.pi);
	await sessionStart(h);
	await cmd(h, "--test-failure Stop goal");
	check("criterion armed", lastState(h).testCriterion !== null);
	await cmd(h, "stop");
	check("criterion cleared on stop", lastState(h).testCriterion === null);

	// reload with an armed criterion mid-verifying: restored + resumed with criterion
	const h2 = makeHarness();
	mod.default(h2.pi);
	await sessionStart(h2);
	await cmd(h2, "--test-failure Reload goal");
	await settled(h2, [assistantEntry("done\n<ENGINEER_DONE>")]);
	check("request with criterion", h2.requests[0].task.includes(".engineering-loop-verifier-sentinel"));
	// "restart": new instance seeded with the same session entries
	const h3 = makeHarness(h2.entries, "/home/hariz");
	mod.default(h3.pi);
	await sessionStart(h3);
	await cmd(h3, "status");
	check("criterion restored after reload", h3.notifies[h3.notifies.length - 1].msg.includes("Test verification criterion: active"));
	await cmd(h3, "resume"); // phase verifying -> fresh verifier
	check("resumed verifier carries criterion", h3.requests[0].task.includes(".engineering-loop-verifier-sentinel"));
	respond(h3, h3.requests[0], { status: "completed", result: { kind: "structured", value: { verdict: "pass", findings: "ok" } } });
	check("done after resumed criterion pass", lastState(h3).status === "done");
}

