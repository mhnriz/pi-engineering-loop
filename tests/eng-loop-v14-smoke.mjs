// dev smoke/regression suite for pi-engineering-loop.
// Requires a dev environment with pi-subagents installed under Pi's
// managed npm directory (the suites import its public API). Creates
// throwaway temp workspaces and checkpoint roots; never touches real
// Pi state. Run: node <pi-package>/node_modules/.bin/jiti tests/<file>.mjs
// v1.4 smoke suite: isolated repository scouting + preserved v1.2/v1.3 behavior.
// Uses real temp workspaces so the workspace-emptiness heuristic is exercised.

const EXT_PATH = "/home/hariz/pi-engineering-loop/extension/index.ts";
const API_PATH =
	"/home/hariz/.pi/agent/npm/node_modules/pi-subagents/src/api/delegation.ts";
const CEILING_API_PATH =
	"/home/hariz/.pi/agent/npm/node_modules/pi-subagents/src/api/capability-ceiling.ts";
const PREFLIGHT_PATH =
	"/home/hariz/.pi/agent/npm/node_modules/pi-subagents/src/api/preflight.ts";

process.env.ENGINEERING_LOOP_VERIFIER_TIMEOUT_MS = "50";
process.env.ENGINEERING_LOOP_VERIFIER_GRACE_MS = "100";
process.env.ENGINEERING_LOOP_SCOUT_TIMEOUT_MS = "50";
process.env.ENGINEERING_LOOP_SCOUT_GRACE_MS = "100";
delete process.env.ENGINEERING_LOOP_SCOUT_DISABLE;
process.env.ENGINEERING_LOOP_CHECKPOINT_DISABLE = "1";

// v1.5: this suite predates change tracking; disable baselines (some fixtures
// seed /home/hariz as the run cwd and would otherwise scan it).
process.env.ENGINEERING_LOOP_BASELINE_DISABLE = "1";

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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function makeEmptyWs() {
	const dir = mkdtempSync(join(tmpdir(), "el14-empty-"));
	mkdirSync(join(dir, ".git"));
	writeFileSync(join(dir, ".gitignore"), "node_modules\n");
	writeFileSync(join(dir, ".DS_Store"), "");
	return dir;
}
function makeExistingWs() {
	const dir = mkdtempSync(join(tmpdir(), "el14-app-"));
	mkdirSync(join(dir, "src"));
	mkdirSync(join(dir, "test"));
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "existing-app", scripts: { test: "node --test" } }));
	writeFileSync(join(dir, "src", "app.js"), "module.exports = { createServer() {} };\n");
	writeFileSync(join(dir, "src", "storage.js"), "module.exports = { load() {} };\n");
	writeFileSync(join(dir, "test", "app.test.js"), "const t = require('node:test');\n");
	writeFileSync(join(dir, "README.md"), "# existing-app\n");
	return dir;
}
const SCOUT_REPORT = {
	summary: "Small Express-like Node server; storage in src/storage.js.",
	architecture: "Handlers in src/app.js, persistence in src/storage.js, tests in test/.",
	relevantFiles: [
		{ path: "src/app.js", reason: "route registration lives here" },
		{ path: "src/storage.js", reason: "persistence layer" },
		{ path: "test/app.test.js", reason: "existing tests" },
	],
	tests: { locations: ["test/"], commands: ["npm test", "node --test"] },
	conventions: ["CommonJS", "lowercase file names"],
	risks: ["storage.js may not be async-safe"],
	unknowns: ["unclear whether persistent store is expected"],
	recommendedInspection: ["src/app.js", "src/storage.js"],
};

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

const { SUBAGENT_DELEGATION_REQUEST_EVENT, SUBAGENT_DELEGATION_RESPONSE_EVENT, SUBAGENT_DELEGATION_CANCEL_EVENT } =
	await import(API_PATH);
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
const cmd = async (h, args) => {
	await h.commands.engineer.handler(args, h.ctx);
};
const lastState = (h) => h.entries[h.entries.length - 1].data;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tool = (h, name, params) => h.tools[name].execute("id", params, undefined, undefined, h.ctx);
const respond = (h, request, payload) =>
	h.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, { requestId: request.requestId, ...payload });
const requestsByNode = (h, nodeId) => h.requests.filter((r) => r.nodeId === nodeId);
const latest = (h, nodeId) => requestsByNode(h, nodeId).slice(-1)[0];
const respondLatest = (h, nodeId, payload) => {
	const req = latest(h, nodeId);
	if (!req) throw new Error(`no request for ${nodeId}`);
	respond(h, req, payload);
};
const engDone = (text = "done\n<ENGINEER_DONE>") => [assistantEntry(text)];

// start an existing-workspace run AND collaborate with the scout synchronously
async function startExisting(h, goal = "Add a health endpoint") {
	const p = cmd(h, goal); // startLoop awaits runScout via its promise
	await sleep(0); // let the scout request be emitted
	respondLatest(h, "scout", { status: "completed", result: { kind: "structured", value: SCOUT_REPORT } });
	await p;
}
async function createPlan(h, titles = ["Impl", "Test"]) {
	return tool(h, "engineer_plan_create", { tasks: titles.map((t) => ({ title: t })) });
}
async function completeAll(h) {
	const st = lastState(h);
	for (const t of st.plan.tasks) {
		await tool(h, "engineer_task_start", { taskId: t.id });
		await tool(h, "engineer_task_complete", { taskId: t.id, evidence: `evidence ${t.id}` });
	}
}

// ---------------------------------------------------------------------------
console.log("test 1: greenfield — empty workspace skips scout (v1.3 flow unchanged)");
{
	const dir = makeEmptyWs();
	const h = makeHarness([], dir);
	const mod = await loadExt();
	mod.default(h.pi);
	await sessionStart(h);
	await cmd(h, "Create a notes API");
	check("no scout request", requestsByNode(h, "scout").length === 0);
	check("scoutStatus not_needed", lastState(h).scoutStatus === "not_needed");
	check("iteration 1 dispatched", h.sent.length === 1 && h.sent[0].content.includes("iteration 1/15"));
	check("iteration 1 has PLANNING REQUIRED", h.sent[0].content.includes("PLANNING REQUIRED"));
	check("iteration 1 has no SCOUT REPORT", !h.sent[0].content.includes("SCOUT REPORT"));
	rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
console.log("test 2: existing workspace launches scout; report persists + injects");
{
	const dir = makeExistingWs();
	const h = makeHarness([], dir);
	const mod = await loadExt();
	mod.default(h.pi);
	await sessionStart(h);
	const start = cmd(h, "Add a health endpoint");
	await sleep(0);
	const req = latest(h, "scout");
	check("scout request emitted", !!req);
	check("scout agent identity", req.agent === "engineering-scout");
	check("scout nodeId", req.nodeId === "scout");
	check("scout context fresh", req.context === "fresh");
	const schema = req.result?.schema ?? {};
	check(
		"scout structured schema fields",
		["summary", "architecture", "relevantFiles", "tests", "conventions", "risks", "unknowns", "recommendedInspection"].every((k) => k in schema.properties),
	);
	check("scout task carries ORIGINAL GOAL", req.task.includes("ORIGINAL GOAL:") && req.task.includes("Add a health endpoint"));
	check("scout task forbids editing", req.task.includes("Do NOT modify or write any files"));
	respond(h, req, { status: "completed", result: { kind: "structured", value: SCOUT_REPORT } });
	await start;
	let st = lastState(h);
	check("scoutStatus completed", st.scoutStatus === "completed");
	check("scoutReport persisted", st.scoutReport?.summary === SCOUT_REPORT.summary);
	check("scout report relevantFiles persisted", st.scoutReport?.relevantFiles.length === 3);
	check("iteration 1 dispatched after scout", h.sent.length === 1);
	const p1 = h.sent[0].content;
	check("iteration 1 has SCOUT REPORT", p1.includes("SCOUT REPORT"));
	check("iteration 1 has summary", p1.includes(SCOUT_REPORT.summary));
	check("iteration 1 has relevant files line", p1.includes("src/app.js — route registration lives here"));
	check("iteration 1 has test commands", p1.includes("npm test"));
	check("iteration 1 still PLANNING REQUIRED", p1.includes("PLANNING REQUIRED"));
	check("iteration 1 has recon caveat", p1.includes("reconnaissance, not absolute truth"));
	check("scout did not create plan", lastState(h).plan === null);
	check("status shows Scout completed", (h.notifies, true));
	await cmd(h, "status");
	check("status line Scout: completed", h.notifies.some((n) => n.msg.includes("Scout: completed")));
	rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
console.log("test 3: scout failure + timeout fall back to direct inspection");
{
	// infra failure
	const dir = makeExistingWs();
	const h = makeHarness([], dir);
	const mod = await loadExt();
	mod.default(h.pi);
	await sessionStart(h);
	const p = cmd(h, "Goal");
	await sleep(0);
	respondLatest(h, "scout", { status: "unavailable_context", error: "no bridge" });
	await p;
	let st = lastState(h);
	check("scout failed on infra error", st.scoutStatus === "failed");
	check("scout error stored", st.scoutError?.includes("unavailable_context"));
	check("fallback notify", h.notifies.some((n) => n.msg.includes("Scout unavailable — continuing with direct engineering inspection")));
	check("goals not blocked", st.status === "running");
	check("iteration 1 dispatched without report", h.sent.length === 1 && !h.sent[0].content.includes("SCOUT REPORT"));
	rmSync(dir, { recursive: true, force: true });

	// timeout
	const dir2 = makeExistingWs();
	const h2 = makeHarness([], dir2);
	mod.default(h2.pi);
	await sessionStart(h2);
	const p2 = cmd(h2, "Goal");
	await sleep(250); // scout deadline = 50 + 100 ms
	await p2;
	const st2 = lastState(h2);
	check("scout timed out -> failed", st2.scoutStatus === "failed" && st2.scoutError?.includes("timed out"));
	check("timeout does NOT mark complete", st2.status === "running" && st2.phase === "engineering");
	check("iteration 1 still dispatched", h2.sent.length === 1);
	rmSync(dir2, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
console.log("test 4: stop cancels active scout; stale scout response ignored");
{
	const dir = makeExistingWs();
	const h = makeHarness([], dir);
	const mod = await loadExt();
	mod.default(h.pi);
	await sessionStart(h);
	const start = cmd(h, "Goal");
	await sleep(0);
	const req = latest(h, "scout");
	check("scout in flight", !!req);
	await cmd(h, "stop");
	check("stop cancels scout", h.cancels.some((c) => c.nodeId === "scout" && c.requestId === req.requestId));
	await start;
	check("no iteration 1 on stopped run", h.sent.length === 0 && lastState(h).status === "stopped");
	// late scout success must be ignored
	respond(h, req, { status: "completed", result: { kind: "structured", value: SCOUT_REPORT } });
	check("late scout response ignored", lastState(h).scoutStatus !== "completed" && lastState(h).status === "stopped");
	rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
console.log("test 5: resume relaunches interrupted scout; completed scout not relaunched");
{
	// incomplete scout (restored as running) -> resume launches a fresh scout
	const dir = makeExistingWs();
	const seed = {
		goal: "Resume scout goal",
		cwd: dir,
		status: "running",
		phase: "engineering",
		iteration: 0,
		maxIterations: 15,
		startedAt: 4242,
		lastAction: "scout reconnaissance launched",
		completionCandidate: false,
		verificationAttempts: 0,
		lastVerificationResult: null,
		consecutiveVerificationFailures: 0,
		lastVerificationFailure: null,
		needsReplan: false,
		testCriterion: null,
		plan: null,
		currentTaskId: null,
		scoutReport: null,
		scoutStatus: "running",
		activeIteration: 0,
		verifierAgent: "engineering-verifier",
	};
	const seeded = [{ type: "custom", customType: "engineering-loop", id: "s1", parentId: null, timestamp: "t", data: seed }];
	const h = makeHarness(seeded, dir);
	const mod = await loadExt();
	mod.default(h.pi);
	await sessionStart(h);
	await cmd(h, "status");
	check("restored scout running shown", h.notifies[h.notifies.length - 1].msg.includes("Scout: running"));
	const p = cmd(h, "resume");
	await sleep(0);
	const fresh = latest(h, "scout");
	check("resume relaunches fresh scout", !!fresh && fresh.requestId && fresh.cwd === dir);
	respond(h, fresh, { status: "completed", result: { kind: "structured", value: SCOUT_REPORT } });
	await p;
	check("resumed scout completed", lastState(h).scoutStatus === "completed" && lastState(h).scoutReport !== null);
	check("iteration 1 after resumed scout", h.sent.length === 1 && h.sent[0].content.includes("SCOUT REPORT"));
	rmSync(dir, { recursive: true, force: true });

	// completed scout -> resume must NOT relaunch
	const dir2 = makeExistingWs();
	const seed2 = {
		...seed,
		cwd: dir2,
		startedAt: 7777,
		scoutStatus: "completed",
		scoutReport: SCOUT_REPORT,
	};
	const seeded2 = [{ type: "custom", customType: "engineering-loop", id: "s2", parentId: null, timestamp: "t", data: seed2 }];
	const h2 = makeHarness(seeded2, dir2);
	mod.default(h2.pi);
	await sessionStart(h2);
	await cmd(h2, "resume");
	check("completed scout NOT relaunched", requestsByNode(h2, "scout").length === 0);
	check("report restored", lastState(h2).scoutReport?.summary === SCOUT_REPORT.summary);
	check("resumed iter prompt has SCOUT REPORT", h2.sent[h2.sent.length - 1].content.includes("SCOUT REPORT"));
	await cmd(h2, "status");
	check("status Scout: completed", h2.notifies.some((n) => n.msg.includes("Scout: completed")));
}

// ---------------------------------------------------------------------------
console.log("test 6: verifier architecture + plan survive the scout lifecycle; PASS completes");
{
	const dir = makeExistingWs();
	const h = makeHarness([], dir);
	const mod = await loadExt();
	mod.default(h.pi);
	await sessionStart(h);
	await startExisting(h, "Add health endpoint with tests");
	await createPlan(h, ["Health route", "Tests"]);
	await completeAll(h);
	await settled(h, engDone());
	check("verifier launched after DONE", requestsByNode(h, "verification").length === 1);
	check("verifier context fresh", latest(h, "verification").context === "fresh");
	respondLatest(h, "verification", { status: "completed", result: { kind: "structured", value: { verdict: "pass", findings: "all good" } } });
	const st = lastState(h);
	check("done after pass", st.status === "done");
	check("plan survived", st.plan?.tasks.length === 2 && st.plan.tasks.every((t) => t.status === "completed"));
	check("scout report survived", st.scoutReport?.architecture === SCOUT_REPORT.architecture);
	rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
console.log("test 7: TEST-ONLY verifier criterion still works with scout");
{
	const dir = makeExistingWs();
	const h = makeHarness([], dir);
	const mod = await loadExt();
	mod.default(h.pi);
	await sessionStart(h);
	const p = cmd(h, "--test-failure Build a CLI");
	await sleep(0);
	respondLatest(h, "scout", { status: "completed", result: { kind: "structured", value: SCOUT_REPORT } });
	await p;
	check("criterion stored", lastState(h).testCriterion?.file === ".engineering-loop-verifier-sentinel");
	check("iter1 hides criterion", !h.sent[0].content.includes("TEST-ONLY VERIFICATION CRITERION"));
	await createPlan(h, ["Implement"]);
	await completeAll(h);
	await settled(h, engDone());
	check("verifier sees criterion", latest(h, "verification").task.includes(".engineering-loop-verifier-sentinel"));
	respondLatest(h, "verification", { status: "completed", result: { kind: "structured", value: { verdict: "fail", findings: "sentinel missing" } } });
	check("repair iteration sees findings", h.sent[h.sent.length - 1].content.includes("sentinel missing"));
	check("plan survived criterion fail", lastState(h).plan?.tasks[0].status === "completed");
	await settled(h, engDone());
	check("attempt 2 same criterion", latest(h, "verification").task.includes("VERIFIER_REPAIR_CONFIRMED"));
	respondLatest(h, "verification", { status: "completed", result: { kind: "structured", value: { verdict: "pass", findings: "ok" } } });
	const st = lastState(h);
	check("done + criterion cleared", st.status === "done" && st.testCriterion === null);
	rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
console.log("test 8: permissions — verifier keeps bash, scout stays read-only via preflight + ceiling");
{
	const v = await resolveSubagentLaunchContract({ agent: "engineering-verifier", task: "t", context: "fresh", cwd: "/home/hariz", availableModels: [] });
	const s = await resolveSubagentLaunchContract({ agent: "engineering-scout", task: "t", context: "fresh", cwd: "/home/hariz", availableModels: [] });
	check("verifier resolves", v.ok);
	check("scout resolves", s.ok);
	if (v.ok) {
		const a = v.contract.tools.effectiveAllowlist;
		check("verifier still has bash", a.includes("bash"));
		check("verifier has read tools", a.includes("read") && a.includes("grep") && a.includes("find") && a.includes("ls"));
		check("verifier no plan tools", !a.some((x) => x.startsWith("engineer_plan") || x.startsWith("engineer_task")));
	}
	if (s.ok) {
		const a = s.contract.tools.effectiveAllowlist;
		check("scout allowlist lacks bash", !a.includes("bash"));
		check("scout allowlist lacks write/edit", !a.includes("write") && !a.includes("edit"));
		check("scout allowlist lacks plan tools", !a.some((x) => x.startsWith("engineer_plan") || x.startsWith("engineer_task")));
		check("scout allowlist has read tools", a.includes("read") && a.includes("grep") && a.includes("find") && a.includes("ls"));
	}

	// ceiling registers both agents with the 5-tool set (scout's own allowlist keeps bash out)
	const dir = makeExistingWs();
	const h = makeHarness([], dir);
	const mod = await loadExt();
	mod.default(h.pi);
	await sessionStart(h);
	const p = cmd(h, "Goal");
	await sleep(0);
	respondLatest(h, "scout", { status: "completed", result: { kind: "structured", value: SCOUT_REPORT } });
	await p;
	await sleep(20);
	const c = resolveCurrentSubagentCapabilityCeiling(h.sessionId);
	check("ceiling allows both agents", c?.allowedAgents?.includes("engineering-verifier") && c?.allowedAgents?.includes("engineering-scout"));
	check("ceiling tool set has bash (for verifier)", c?.allowedTools?.includes("bash"));
	rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
console.log("test 9: legacy states without scout fields restore safely; iteration display fix");
{
	const legacySeed = {
		goal: "Legacy",
		cwd: "/home/hariz",
		status: "running",
		phase: "engineering",
		iteration: 4,
		maxIterations: 15,
		startedAt: 1,
		lastAction: "iteration 4 started",
		completionCandidate: false,
		verificationAttempts: 0,
		lastVerificationResult: null,
		consecutiveVerificationFailures: 0,
		lastVerificationFailure: null,
		needsReplan: false,
		testCriterion: null,
		plan: null,
		currentTaskId: null,
		verifierAgent: "engineering-verifier",
	};
	const seeded = [{ type: "custom", customType: "engineering-loop", id: "l1", parentId: null, timestamp: "t", data: legacySeed }];
	const h = makeHarness(seeded);
	const mod = await loadExt();
	mod.default(h.pi);
	await sessionStart(h);
	check("legacy scoutStatus not_needed", (lastState(h).scoutStatus ?? "not_needed") === "not_needed");
	check("legacy scoutReport null", (lastState(h).scoutReport ?? null) === null);
	await cmd(h, "status");
	check("legacy shows Scout: skipped (empty workspace)", h.notifies.some((n) => n.msg.includes("Scout: skipped (empty workspace)")));
	// v1.3.1: active iteration shown when dispatched but not settled
	check("iteration display uses activeIteration", h.notifies.some((n) => n.msg.includes("Iteration: 4/15")));

	// v1.3.1 regression: start -> iteration 1 dispatched -> status shows 1/15
	const dir = makeEmptyWs();
	const h2 = makeHarness([], dir);
	mod.default(h2.pi);
	await sessionStart(h2);
	await cmd(h2, "Fresh");
	check("iteration 1 dispatched", h2.sent.length === 1);
	check("activeIteration 1 persisted", lastState(h2).activeIteration === 1);
	await cmd(h2, "status");
	check("status shows Iteration: 1/15 while running", h2.notifies.some((n) => n.msg.includes("Iteration: 1/15")));
	await cmd(h2, "stop");
	rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);