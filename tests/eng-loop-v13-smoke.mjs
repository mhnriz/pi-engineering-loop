// dev smoke/regression suite for pi-engineering-loop.
// Requires a dev environment with pi-subagents installed under Pi's
// managed npm directory (the suites import its public API). Creates
// throwaway temp workspaces and checkpoint roots; never touches real
// Pi state. Run: node <pi-package>/node_modules/.bin/jiti tests/<file>.mjs
// v1.3 smoke suite: persistent structured engineering planning + preserved
// v1.2 isolated-verification behavior. Loads the extension through jiti with
// pi's typebox alias and simulates the delegation bridge + plan tools.

const EXT_PATH = "/home/hariz/pi-engineering-loop/extension/index.ts";
const API_PATH =
	"/home/hariz/.pi/agent/npm/node_modules/pi-subagents/src/api/delegation.ts";
const CEILING_API_PATH =
	"/home/hariz/.pi/agent/npm/node_modules/pi-subagents/src/api/capability-ceiling.ts";
const PREFLIGHT_PATH =
	"/home/hariz/.pi/agent/npm/node_modules/pi-subagents/src/api/preflight.ts";

// v1.4: older regression suites run against /home/hariz (non-empty); force
// scouting off so the pre-v1.4 flows are exercised exactly as before.
process.env.ENGINEERING_LOOP_SCOUT_DISABLE = "1";
// v1.5: these suites predate change tracking; disable baselines (their
// workspaces would otherwise be scanned).
process.env.ENGINEERING_LOOP_BASELINE_DISABLE = "1";
process.env.ENGINEERING_LOOP_VERIFIER_TIMEOUT_MS = "50";
process.env.ENGINEERING_LOOP_VERIFIER_GRACE_MS = "100";

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

import { createRequire } from "node:module";
const requirePi = createRequire(
	"/home/hariz/.nvm/versions/node/v22.23.1/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
);
const { createJiti } = await import(
	"/home/hariz/.nvm/versions/node/v22.23.1/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/jiti/lib/jiti.mjs"
);
const testJiti = createJiti(
	"/home/hariz/.nvm/versions/node/v22.23.1/lib/node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js",
	{
		moduleCache: true,
		alias: {
			typebox: requirePi.resolve("typebox"),
			"typebox/compile": requirePi.resolve("typebox/compile"),
			"typebox/value": requirePi.resolve("typebox/value"),
		},
	},
);
const loadExt = () => testJiti.import(EXT_PATH);

const { SUBAGENT_DELEGATION_REQUEST_EVENT, SUBAGENT_DELEGATION_RESPONSE_EVENT } = await import(API_PATH);
const { resolveCurrentSubagentCapabilityCeiling } = await import(CEILING_API_PATH);
const { resolveSubagentLaunchContract } = await import(PREFLIGHT_PATH);

function makeHarness(seedEntries = [], cwd = "/home/hariz", sessionId = "test-session") {
	const entries = [...seedEntries];
	const sent = [];
	const notifies = [];
	const commands = {};
	const handlers = {};
	const tools = {};
	const requests = [];
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
	events.on(SUBAGENT_DELEGATION_REQUEST_EVENT, (req) => requests.push(req));
	events.on("prompt-template:subagent:cancel", (req) => cancels.push(req));

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
		sendUserMessage(c) {
			if (!idle) throw new Error("streaming requires deliverAs");
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

	return { pi, ctx, events, entries, sent, notifies, commands, handlers, tools, requests, cancels, sessionId };
}

const assistantEntry = (text) => ({
	type: "message",
	id: `m${Math.random().toString(36).slice(2)}`,
	parentId: null,
	timestamp: new Date().toISOString(),
	message: { role: "assistant", content: [{ type: "text", text }] },
});

const settled = async (h, branch) => {
	h.ctx.sessionManager.getBranch = () => branch;
	for (const handler of h.handlers.agent_settled ?? []) await handler({ type: "agent_settled" }, h.ctx);
};
const sessionStart = async (h) => {
	for (const handler of h.handlers.session_start ?? [])
		await handler({ type: "session_start", reason: "startup" }, h.ctx);
};
const sessionShutdown = async (h) => {
	for (const handler of h.handlers.session_shutdown ?? []) await handler({ type: "session_shutdown" }, h.ctx);
};
const cmd = async (h, args) => {
	await h.commands.engineer.handler(args, h.ctx);
};
const lastState = (h) => h.entries[h.entries.length - 1].data;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tool = (h, name, params) =>
	h.tools[name].execute("id", params, undefined, undefined, h.ctx);
const respond = (h, request, payload) =>
	h.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, { requestId: request.requestId, ...payload });
const engDone = (text = "done\n<ENGINEER_DONE>") => [assistantEntry(text)];

// plan helpers for tests
async function createPlan(h, titles = ["Persistence", "API endpoints"]) {
	return tool(h, "engineer_plan_create", { tasks: titles.map((title) => ({ title })) });
}
async function completeAll(h) {
	const st = lastState(h);
	for (const t of st.plan.tasks) {
		await tool(h, "engineer_task_start", { taskId: t.id });
		await tool(h, "engineer_task_complete", { taskId: t.id, evidence: `evidence for ${t.id}` });
	}
}

// ---------------------------------------------------------------------------
console.log("test 1: plan creation + id stability + persistence");
{
	const h = makeHarness();
	const mod = await loadExt();
	mod.default(h.pi);
	await sessionStart(h);
	await cmd(h, "Build a notes API");
	await cmd(h, "status");
	check("fresh run has no plan", lastState(h).plan === null && lastState(h).currentTaskId === null);

	const r = await createPlan(h);
	check("create succeeds", r.content[0].text.includes("Created engineering plan with 2 task(s)"));
	let st = lastState(h);
	check("stable ids T1..T2", st.plan.tasks.map((t) => t.id).join(",") === "T1,T2");
	check("version 1", st.plan.version === 1);
	check("all pending", st.plan.tasks.every((t) => t.status === "pending"));
	check("timestamps set", !!st.plan.createdAt && !!st.plan.updatedAt);
	check("persisted in session", h.entries.some((e) => e.data?.plan));

	// re-create rejected
	const r2 = await createPlan(h, ["again"]);
	check("re-create rejected", r2.content[0].text.includes("already exists"));

	// empty / too-large rejected
	await cmd(h, "stop");
	const h2 = makeHarness();
	mod.default(h2.pi);
	await sessionStart(h2);
	await cmd(h2, "Fresh");
	const re = await tool(h2, "engineer_plan_create", { tasks: [] });
	check("empty plan rejected", re.content[0].text.includes("Empty plan"));
	const rl = await tool(h2, "engineer_plan_create", { tasks: Array.from({ length: 31 }, (_, i) => ({ title: `t${i}` })) });
	check(">30 rejected", rl.content[0].text.includes("maximum"));
}

// ---------------------------------------------------------------------------
console.log("test 2: task lifecycle — start/complete/block/reopen");
{
	const h = makeHarness();
	const mod = await loadExt();
	mod.default(h.pi);
	await sessionStart(h);
	await cmd(h, "Goal");
	await createPlan(h, ["A", "B", "C"]);

	// only one in_progress
	await tool(h, "engineer_task_start", { taskId: "T1" });
	check("currentTaskId T1", lastState(h).currentTaskId === "T1");
	const r = await tool(h, "engineer_task_start", { taskId: "T2" });
	check("start T2 demotes T1", r.content[0].text.includes("T1 returned to pending"));
	let st = lastState(h);
	check("only T2 in_progress", st.plan.tasks.filter((t) => t.status === "in_progress").map((t) => t.id).join(",") === "T2");
	check("currentTaskId T2", st.currentTaskId === "T2");

	// completed task cannot restart
	await tool(h, "engineer_task_complete", { taskId: "T2", evidence: "tests passed" });
	check("evidence stored", lastState(h).plan.tasks[1].evidence === "tests passed");
	check("current cleared after complete", lastState(h).currentTaskId === null);
	const rs = await tool(h, "engineer_task_start", { taskId: "T2" });
	check("completed cannot restart", rs.content[0].text.includes("reopen"));

	// blocked task stores reason, prevents silent restart
	await tool(h, "engineer_task_block", { taskId: "T3", reason: "missing dependency" });
	check("block reason stored", lastState(h).plan.tasks[2].notes === "missing dependency");
	const rb = await tool(h, "engineer_task_start", { taskId: "T3" });
	check("blocked cannot be silently started", rb.content[0].text.includes("blocked"));

	// reopen completed -> pending, evidence moved to notes
	const rk = await tool(h, "engineer_task_reopen", { taskId: "T2", reason: "verifier found missing error handling" });
	check("reopen succeeds", rk.content[0].text.includes("Reopened T2") && lastState(h).plan.tasks[1].status === "pending");
	check("evidence moved to notes", lastState(h).plan.tasks[1].notes.includes("Prior evidence: tests passed"));
	check("reopen reason recorded", lastState(h).plan.tasks[1].notes.includes("Reopened: verifier found missing error handling"));
	check("stale evidence cleared", lastState(h).plan.tasks[1].evidence === undefined);
	// reopen pending rejected
	const rp = await tool(h, "engineer_task_reopen", { taskId: "T1", reason: "x" });
	check("reopen pending rejected", rp.content[0].text.includes("only completed or blocked"));
	// tools outside active run rejected
	await cmd(h, "stop");
	const ro = await tool(h, "engineer_task_start", { taskId: "T1" });
	check("mutation tools rejected when not running", ro.content[0].text.includes("not active"));
}

// ---------------------------------------------------------------------------
console.log("test 3: prompt snapshots — PLANNING REQUIRED vs ENGINEERING PLAN");
{
	const h = makeHarness();
	const mod = await loadExt();
	mod.default(h.pi);
	await sessionStart(h);
	await cmd(h, "Goal");
	check("no-plan iteration has PLANNING REQUIRED", h.sent[0].content.includes("PLANNING REQUIRED"));
	check("no plan snapshot when no plan", !h.sent[0].content.includes("ENGINEERING PLAN"));

	await createPlan(h, ["Inspect repo", "Implement", "Test", "Docs"]);
	await tool(h, "engineer_task_start", { taskId: "T1" });
	await tool(h, "engineer_task_complete", { taskId: "T1", evidence: "inspected" });
	await tool(h, "engineer_task_start", { taskId: "T2" });
	await settled(h, engDone("\n<ENGINEER_CONTINUE>")); // settle a CONTINUE to trigger next iteration
	const p = h.sent[h.sent.length - 1].content;
	check("plan snapshot present", p.includes("ENGINEERING PLAN"));
	check("progress shown", p.includes("Progress: 1/4 completed"));
	check("marker for in_progress", p.includes("[>] T2"));
	check("marker for completed", p.includes("[x] T1"));
	check("current task shown", p.includes("Current task:") && p.includes("T2 — Implement"));
	check("behavior instructions present", p.includes("1. Read the current plan (engineer_plan_read)"));
	check("no historical evidence in snapshot", !p.includes("evidence for T1") && !p.includes("inspected"));
}

// ---------------------------------------------------------------------------
console.log("test 4: completion gate rejections");
{
	const h = makeHarness();
	const mod = await loadExt();
	mod.default(h.pi);
	await sessionStart(h);
	await cmd(h, "Goal");

	// 12. DONE without plan rejected
	await settled(h, engDone());
	check("no plan -> verifier NOT launched", h.requests.length === 0);
	check("no plan rejected notify", h.notifies.some((n) => n.msg.includes("Completion rejected — no engineering plan exists")));
	check("next prompt has COMPLETION REJECTED", h.sent[h.sent.length - 1].content.includes("COMPLETION REJECTED:"));

	// 13. pending rejected after plan exists
	await createPlan(h, ["P1", "P2"]);
	await settled(h, engDone());
	check("pending rejected", h.notifies.some((n) => n.msg.includes("unfinished tasks")));
	const rp = h.sent[h.sent.length - 1].content;
	check("rejection lists unfinished", rp.includes("COMPLETION REJECTED:") && rp.includes("P1") && rp.includes("[ ]"));
	check("still no verifier", h.requests.length === 0);

	// 14. in_progress rejected
	await tool(h, "engineer_task_start", { taskId: "T1" });
	await settled(h, engDone());
	check("in_progress rejected", h.notifies.some((n) => n.msg.includes("unfinished tasks")));
	check("still no verifier", h.requests.length === 0);

	// 15. blocked rejected
	await tool(h, "engineer_task_complete", { taskId: "T1", evidence: "ok" });
	await tool(h, "engineer_task_start", { taskId: "T2" });
	await tool(h, "engineer_task_block", { taskId: "T2", reason: "blocked" });
	await settled(h, engDone());
	check("blocked rejected", h.notifies.some((n) => n.msg.includes("contains blocked tasks")));
	check("blocked rejection lists blocked marker", h.sent[h.sent.length - 1].content.includes("[!]") && h.sent[h.sent.length - 1].content.includes("P2"));
	check("still no verifier", h.requests.length === 0);
}

// ---------------------------------------------------------------------------
console.log("test 5: DONE with completed plan launches verifier; FAIL preserves plan");
{
	const h = makeHarness();
	const mod = await loadExt();
	mod.default(h.pi);
	await sessionStart(h);
	await cmd(h, "Goal");
	await createPlan(h, ["P1", "P2"]);
	await completeAll(h);

	await settled(h, engDone());
	check("verifier launched with completed plan", h.requests.length === 1);
	check("phase verifying", lastState(h).phase === "verifying");

	// verifier FAIL -> plan preserved
	respond(h, h.requests[0], {
		status: "completed",
		result: { kind: "structured", value: { verdict: "fail", findings: "P1 wire-format wrong." } },
	});
	let st = lastState(h);
	check("phase engineering after fail", st.phase === "engineering");
	check("plan preserved", st.plan.tasks.length === 2);
	check("completed statuses preserved", st.plan.tasks.every((t) => t.status === "completed"));
	check("evidence preserved", st.plan.tasks.every((t) => t.evidence && t.evidence.includes("evidence for")));
	const repair = h.sent[h.sent.length - 1].content;
	check("repair prompt has findings", repair.includes("P1 wire-format wrong."));
	check("repair prompt still shows plan snapshot", repair.includes("ENGINEERING PLAN"));
	check("repair prompt shows 2/2 completed", repair.includes("Progress: 2/2 completed"));
}

// ---------------------------------------------------------------------------
console.log("test 6: verifier PASS completes normally; reopened task repaired");
{
	const h = makeHarness();
	const mod = await loadExt();
	mod.default(h.pi);
	await sessionStart(h);
	await cmd(h, "Goal");
	await createPlan(h, ["P1"]);
	await completeAll(h);
	await settled(h, engDone());
	respond(h, h.requests[0], { status: "completed", result: { kind: "structured", value: { verdict: "pass", findings: "ok" } } });
	check("done after pass", lastState(h).status === "done");
	check("complete report notify", h.notifies.some((n) => n.msg.includes("Engineering run complete") && n.msg.includes("Verification: passed")));

	// reopen path used after a verifier FAIL on a completed task
	const h2 = makeHarness();
	mod.default(h2.pi);
	await sessionStart(h2);
	await cmd(h2, "Goal2");
	await createPlan(h2, ["Impl"]);
	await tool(h2, "engineer_task_start", { taskId: "T1" });
	await tool(h2, "engineer_task_complete", { taskId: "T1", evidence: "built" });
	await settled(h2, engDone());
	respond(h2, h2.requests[0], { status: "completed", result: { kind: "structured", value: { verdict: "fail", findings: "T1 implementation is incomplete" } } });
	const reopen = await tool(h2, "engineer_task_reopen", { taskId: "T1", reason: "Verifier found missing error handling" });
	check("engineer reopens affected task", reopen.content[0].text.includes("Reopened T1") && lastState(h2).plan.tasks[0].status === "pending");
}

// ---------------------------------------------------------------------------
console.log("test 7: deterministic verifier-only criterion through the plan flow");
{
	const h = makeHarness();
	const mod = await loadExt();
	mod.default(h.pi);
	await sessionStart(h);
	await cmd(h, "--test-failure Build a CLI");
	check("criterion stored", lastState(h).testCriterion?.file === ".engineering-loop-verifier-sentinel");
	check("engineer iter1 hidden criterion", !h.sent[0].content.includes("TEST-ONLY VERIFICATION CRITERION"));

	await createPlan(h, ["Implement"]);
	await completeAll(h);
	await settled(h, engDone());
	check("verifier launched", h.requests.length === 1);
	check("verifier task sees criterion", h.requests[0].task.includes(".engineering-loop-verifier-sentinel") && h.requests[0].task.includes("VERIFIER_REPAIR_CONFIRMED"));
	respond(h, h.requests[0], { status: "completed", result: { kind: "structured", value: { verdict: "fail", findings: "Sentinel missing." } } });
	check("findings reached engineer", h.sent[h.sent.length - 1].content.includes("Sentinel missing."));
	check("plan survived criterion fail", lastState(h).plan?.tasks[0].status === "completed");

	await settled(h, engDone());
	check("attempt 2 launched with SAME criterion", h.requests[1].task.includes(".engineering-loop-verifier-sentinel"));
	respond(h, h.requests[1], { status: "completed", result: { kind: "structured", value: { verdict: "pass", findings: "sentinel ok" } } });
	const st = lastState(h);
	check("done", st.status === "done");
	check("criterion cleared on pass", st.testCriterion === null);
	check("plan intact after pass", st.plan?.tasks.length === 1);
}

// ---------------------------------------------------------------------------
console.log("test 8: stop/resume and reload preserve the plan");
{
	const h = makeHarness();
	const mod = await loadExt();
	mod.default(h.pi);
	await sessionStart(h);
	await cmd(h, "Goal");
	await createPlan(h, ["P1", "P2"]);
	await tool(h, "engineer_task_start", { taskId: "T1" });
	await cmd(h, "stop");
	check("plan survives stop", lastState(h).plan !== null && lastState(h).currentTaskId === "T1");

	// resume (engineering phase) -> next prompt includes the plan snapshot
	await cmd(h, "resume");
	const rp = h.sent[h.sent.length - 1].content;
	check("resume prompt shows plan", rp.includes("ENGINEERING PLAN") && rp.includes("[>] T1"));

	// reload preserves plan
	const h2 = makeHarness(h.entries, "/home/hariz");
	mod.default(h2.pi);
	await sessionStart(h2);
	await cmd(h2, "status");
	const sn = h2.notifies[h2.notifies.length - 1].msg;
	check("status shows plan summary", sn.includes("Plan: 0/2 completed"));
	check("status shows current task", sn.includes("Current task: T1 — P1") || sn.includes("Current task: T1 —"));
	check("status shows blocked count", sn.includes("Blocked: 0"));
	check("status shows pending count", sn.includes("Pending: 1"));
	await cmd(h2, "plan");
	check("/engineer plan shows full plan", h2.notifies[h2.notifies.length - 1].msg.includes("[>] T1 P1"));
}

// ---------------------------------------------------------------------------
console.log("test 9: legacy v1.2 state (no plan) restores safely");
{
	const legacySeed = {
		goal: "Legacy",
		cwd: "/home/hariz",
		status: "running",
		phase: "engineering",
		iteration: 1,
		maxIterations: 15,
		startedAt: 999,
		lastAction: "iteration 1 started",
		completionCandidate: false,
		verificationAttempts: 0,
		lastVerificationResult: null,
		consecutiveVerificationFailures: 0,
		lastVerificationFailure: null,
		needsReplan: false,
		testCriterion: null,
		verifierAgent: "engineering-verifier",
	};
	const seeded = [{ type: "custom", customType: "engineering-loop", id: "l1", parentId: null, timestamp: "t", data: legacySeed }];
	const h = makeHarness(seeded);
	const mod = await loadExt();
	mod.default(h.pi);
	await sessionStart(h);
	await cmd(h, "status");
	check("legacy restores plan null", (lastState(h).plan ?? null) === null && (lastState(h).currentTaskId ?? null) === null);
	check("legacy status shows Plan: none", h.notifies[h.notifies.length - 1].msg.includes("Plan: none"));
	// DONE on legacy (no plan) is rejected, not crashed
	await cmd(h, "resume"); // put an engineering iteration in flight
	await settled(h, engDone());
	check("legacy DONE rejected safely", h.notifies.some((n) => n.msg.includes("no engineering plan exists")) && h.requests.length === 0);
}

// ---------------------------------------------------------------------------
console.log("test 10: verifier agent cannot access engineer planning tools");
{
	const contract = await resolveSubagentLaunchContract({
		agent: "engineering-verifier",
		task: "verify",
		context: "fresh",
		cwd: "/home/hariz",
		availableModels: [],
	});
	check("verifier agent resolves", contract.ok === true);
	if (contract.ok) {
		const allow = contract.contract.tools.effectiveAllowlist;
		check("verifier has read tools", allow.includes("read") && allow.includes("bash"));
		check("verifier has no plan tools", !allow.some((t) => t.startsWith("engineer_plan") || t.startsWith("engineer_task")));
		check("verifier has no edit/write", !allow.includes("edit") && !allow.includes("write"));
	}
}

// ---------------------------------------------------------------------------
console.log("test 11: preserved delegation guards (infra block, stale response, deadline)");
{
	// infra
	const h = makeHarness();
	const mod = await loadExt();
	mod.default(h.pi);
	await sessionStart(h);
	await cmd(h, "Goal");
	await createPlan(h, ["P1"]);
	await completeAll(h);
	await settled(h, engDone());
	respond(h, h.requests[0], { status: "unavailable_context", error: "no ctx" });
	check("infra blocks run", lastState(h).status === "blocked" && lastState(h).lastAction.includes("infrastructure failure"));

	// stale response after stop
	const h2 = makeHarness();
	mod.default(h2.pi);
	await sessionStart(h2);
	await cmd(h2, "Goal");
	await createPlan(h2, ["P1"]);
	await completeAll(h2);
	await settled(h2, engDone());
	const req = h2.requests[0];
	await cmd(h2, "stop");
	check("cancel emitted", h2.cancels.some((c) => c.requestId === req.requestId));
	respond(h2, req, { status: "completed", result: { kind: "structured", value: { verdict: "pass", findings: "late" } } });
	check("late response ignored", lastState(h2).status === "stopped");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);