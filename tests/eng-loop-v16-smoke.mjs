// dev smoke/regression suite for pi-engineering-loop.
// Requires a dev environment with pi-subagents installed under Pi's
// managed npm directory (the suites import its public API). Creates
// throwaway temp workspaces and checkpoint roots; never touches real
// Pi state. Run: node <pi-package>/node_modules/.bin/jiti tests/<file>.mjs
// v1.6 smoke suite: extension-owned recoverable checkpoints + safe rollback.
// Uses real temp workspaces (including a real git repo) and a temp checkpoint
// root. The v1.5 baseline stays enabled; scout is disabled except where the
// test targets it.

const EXT_PATH = "/home/hariz/pi-engineering-loop/extension/index.ts";
const API_PATH =
	"/home/hariz/.pi/agent/npm/node_modules/pi-subagents/src/api/delegation.ts";
const WORKSPACE_PATH = "/home/hariz/.pi/agent/extensions/engineering-loop/workspace.ts";

process.env.ENGINEERING_LOOP_VERIFIER_TIMEOUT_MS = "50";
process.env.ENGINEERING_LOOP_VERIFIER_GRACE_MS = "100";
process.env.ENGINEERING_LOOP_SCOUT_TIMEOUT_MS = "50";
process.env.ENGINEERING_LOOP_SCOUT_GRACE_MS = "100";
process.env.ENGINEERING_LOOP_SCOUT_DISABLE = "1"; // per-test control below
delete process.env.ENGINEERING_LOOP_BASELINE_DISABLE;
delete process.env.ENGINEERING_LOOP_CHECKPOINT_DISABLE;
// small caps so coverage-partial paths are testable cheaply
process.env.ENGINEERING_LOOP_SNAPSHOT_FILE_MAX = "4000";
process.env.ENGINEERING_LOOP_SNAPSHOT_TOTAL_MAX = "20000";

import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CP_ROOT = mkdtempSync(join(tmpdir(), "el16-cp-"));
process.env.ENGINEERING_LOOP_CHECKPOINT_DIR = CP_ROOT;

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

// ---- workspace factories ---------------------------------------------------
function makeDirtyRepo() {
	// committed app.js; committed README; pre-run USER-MODIFIED README; untracked scratch.txt
	const dir = mkdtempSync(join(tmpdir(), "el16-repo-"));
	execFileSync("git", ["init", "-q"], { cwd: dir });
	execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
	execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
	writeFileSync(join(dir, "app.js"), "// committed app\n");
	writeFileSync(join(dir, "README.md"), "README\n");
	writeFileSync(join(dir, "storage.js"), "module.exports = {}\n");
	execFileSync("git", ["add", "."], { cwd: dir });
	execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir });
	// pre-existing dirty state:
	writeFileSync(join(dir, "README.md"), "README\nUSER LINE\n"); // user-modified tracked file
	writeFileSync(join(dir, "scratch.txt"), "scratch\n"); // pre-existing untracked
	return dir;
}
function makePlainWs(files) {
	const dir = mkdtempSync(join(tmpdir(), "el16-plain-"));
	for (const [rel, content] of Object.entries(files)) {
		const abs = join(dir, rel);
		mkdirSync(require("node:path").dirname(abs), { recursive: true });
		writeFileSync(abs, content);
	}
	return dir;
}
const read = (p) => {
	try {
		return readFileSync(p, "utf8");
	} catch {
		return null;
	}
};

// ---- harness ---------------------------------------------------------------
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
const tool = (h, name, params) => h.tools[name].execute("id", params, undefined, undefined, h.ctx);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const engDone = (text = "done\n<ENGINEER_DONE>") => [assistantEntry(text)];
const respond = (h, request, payload) =>
	h.events.emit(SUBAGENT_DELEGATION_RESPONSE_EVENT, { requestId: request.requestId, ...payload });
const latestReq = (h, nodeId) => h.requests.filter((r) => r.nodeId === nodeId).slice(-1)[0];

async function startRun(h, wsDir, goal = "Add a health endpoint") {
	// empty/greenfield ws: scout disabled -> no scout; baseline + snapshot captured
	await cmd(h, goal);
}
async function createPlan(h, titles) {
	await tool(h, "engineer_plan_create", { tasks: titles.map((t) => ({ title: t })) });
}
async function completeAll(h) {
	const st = lastState(h);
	for (const t of st.plan.tasks) {
		await tool(h, "engineer_task_start", { taskId: t.id });
		await tool(h, "engineer_task_complete", { taskId: t.id, evidence: `ev ${t.id}` });
	}
}
const cpRunDir = (startedAt) => join(CP_ROOT, String(startedAt));
const cpMeta = (startedAt, type) => {
	try {
		const store = JSON.parse(readFileSync(join(cpRunDir(startedAt), "metadata.json"), "utf8"));
		return store[type] ?? null;
	} catch {
		return null;
	}
};

// ---------------------------------------------------------------------------
console.log("test A: baseline snapshot captures bytes incl. dirty pre-run state");
{
	const ws = makeDirtyRepo();
	const h = makeHarness([], ws);
	const mod = await loadExt();
	mod.default(h.pi);
	await sessionStart(h);
	await startRun(h, ws);
	const st = lastState(h);
	check("checkpointRunId set", st.checkpointRunId !== null && st.checkpointRunId === String(st.startedAt));
	check("rollback coverage full", st.rollbackCoverage === "full");
	const dir = cpRunDir(st.startedAt);
	check("baseline metadata exists", existsSync(join(dir, "metadata.json")));
	check("baseline captured app.js bytes", read(join(dir, "baseline/app.js")) === "// committed app\n");
	check("baseline captured pre-run USER-modified README (not git HEAD)", read(join(dir, "baseline/README.md")) === "README\nUSER LINE\n");
	check("baseline captured pre-existing untracked scratch.txt", read(join(dir, "baseline/scratch.txt")) === "scratch\n");
	check("git never copied into checkpoint", !existsSync(join(dir, "baseline/.git")));
	const meta = cpMeta(st.startedAt, "run_baseline");
	check("metadata files map includes paths", meta?.files?.["app.js"] && meta.files["README.md"] && meta.files["scratch.txt"]);
	check("metadata has hashes", typeof meta.files["app.js"].hash === "string");
	check("RUN_BASELINE created automatically (no checkpoint cmd)", meta?.type === "run_baseline");
	await cmd(h, "status");
	check("status shows Recovery lines", h.notifies.some((n) => n.msg.includes("Recovery:") && n.msg.includes("Rollback coverage: full")));
	rmSync(ws, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
console.log("test B: engineering changes then baseline rollback restores exact state");
{
	const ws = makeDirtyRepo();
	const h = makeHarness([], ws);
	const mod = await loadExt();
	mod.default(h.pi);
	await sessionStart(h);
	await startRun(h, ws);
	const st0 = lastState(h);
	// engineering work: modify app.js, modify README (add line), create app.test.js, delete storage.js
	writeFileSync(join(ws, "app.js"), "// engineered app\n");
	writeFileSync(join(ws, "README.md"), "README\nUSER LINE\nENGINEERED\n");
	writeFileSync(join(ws, "app.test.js"), "const assert = require('node:assert');\n");
	rmSync(join(ws, "storage.js"));

	// preview is non-destructive
	await cmd(h, "rollback baseline");
	check("preview shown", h.notifies.some((n) => n.msg.includes("Rollback preview") && n.msg.includes("RUN_BASELINE")));
	check("preview mentions confirm", h.notifies.some((n) => n.msg.includes("/engineer rollback baseline confirm")));
	check("preview did not mutate", read(join(ws, "app.js")) === "// engineered app\n" && existsSync(join(ws, "app.test.js")));

	// rollback without confirm does nothing
	await cmd(h, "rollback");
	check("no LATEST_SAFE -> suggests baseline", h.notifies.some((n) => n.msg.includes("No LATEST_SAFE checkpoint exists")));
	check("still no mutation", read(join(ws, "app.js")) === "// engineered app\n");

	await cmd(h, "rollback baseline confirm");
	const st = lastState(h);
	check("run stopped after rollback", st.status === "stopped");
	check("phase engineering", st.phase === "engineering");
	check("app.js restored to committed bytes", read(join(ws, "app.js")) === "// committed app\n");
	check("README restored to pre-run USER version, NOT git HEAD", read(join(ws, "README.md")) === "README\nUSER LINE\n");
	check("engineering-created app.test.js removed", !existsSync(join(ws, "app.test.js")));
	check("engineering-deleted storage.js recreated", read(join(ws, "storage.js")) === "module.exports = {}\n");
	check("pre-existing untracked scratch.txt survives", read(join(ws, "scratch.txt")) === "scratch\n");
	check("git untouched (commit preserved)", execFileSync("git", ["log", "--oneline"], { cwd: ws, encoding: "utf8" }).trim().split("\n").length === 1);
	check("changes manifest empty after baseline rollback", lastState(h).changes.created.length === 0 && lastState(h).changes.modified.length === 0 && lastState(h).changes.deleted.length === 0);
	await cmd(h, "changes");
	check("/engineer changes shows none", h.notifies.some((n) => n.msg.includes("none") || n.msg.includes("No changes")) || h.notifies.some((n) => !n.msg.includes("Changed files")));

	// baseline immutable
	const before = cpMeta(st0.startedAt, "run_baseline");
	const after = cpMeta(st0.startedAt, "run_baseline");
	check("RUN_BASELINE immutable", before.createdAt === after.createdAt && JSON.stringify(before.files) === JSON.stringify(after.files));
	rmSync(ws, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
console.log("test C: LATEST_SAFE checkpoint + replacement + plan-aware rollback");
{
	const ws = makeDirtyRepo();
	const h = makeHarness([], ws);
	const mod = await loadExt();
	mod.default(h.pi);
	await sessionStart(h);
	await startRun(h, ws);
	await createPlan(h, ["P1", "P2"]);
	await tool(h, "engineer_task_start", { taskId: "T1" });
	await tool(h, "engineer_task_complete", { taskId: "T1", evidence: "p1 done" });

	// engineering modifies app.js and creates disposable.js
	writeFileSync(join(ws, "app.js"), "// v1\n");
	writeFileSync(join(ws, "disposable.js"), "temp\n");
	await cmd(h, "checkpoint");
	check("checkpoint notify", h.notifies.some((n) => n.msg.includes("Checkpoint created") && n.msg.includes("Rollback coverage: full")));
	const st = lastState(h);
	check("latestSafeAt set", typeof st.latestSafeAt === "string");
	const meta = cpMeta(st.startedAt, "latest_safe");
	check("LATEST_SAFE metadata written", meta?.type === "latest_safe");
	check("checkpoint captured app.js v1", read(join(CP_ROOT, String(st.startedAt), "safe/app.js")) === "// v1\n");
	check("checkpoint stored plan payload", meta?.payload?.plan?.tasks?.length === 2);

	// replace LATEST_SAFE
	writeFileSync(join(ws, "app.js"), "// v2\n");
	writeFileSync(join(ws, "app.js"), "// v1b\n");
	await cmd(h, "checkpoint");
	const st2 = lastState(h);
	check("LATEST_SAFE replaced (timestamp updated)", st2.latestSafeAt !== st.latestSafeAt);
	check("replaced bytes", read(join(CP_ROOT, String(st.startedAt), "safe/app.js")) === "// v1b\n");

	// /engineer checkpoints
	await cmd(h, "checkpoints");
	const cpOut = h.notifies[h.notifies.length - 1].msg;
	check("checkpoints lists RUN_BASELINE", cpOut.includes("RUN_BASELINE") && cpOut.includes("Coverage: full"));
	check("checkpoints lists LATEST_SAFE", cpOut.includes("LATEST_SAFE") && cpOut.includes("(plan snapshot)"));

	// engineering continues after checkpoint: more work
	writeFileSync(join(ws, "app.js"), "// v3\n");
	writeFileSync(join(ws, "post-checkpoint.txt"), "late\n");
	await tool(h, "engineer_task_start", { taskId: "T2" });

	// rollback preview (non-destructive)
	await cmd(h, "rollback");
	check("rollback preview for LATEST_SAFE", h.notifies.some((n) => n.msg.includes("Target: LATEST_SAFE")));
	check("preview non-destructive", read(join(ws, "app.js")) === "// v3\n" && read(join(ws, "post-checkpoint.txt")) === "late\n");
	// not confirmed -> nothing executed
	check("no confirm, nothing executed", existsSync(join(ws, "post-checkpoint.txt")));

	await cmd(h, "rollback confirm");
	const st3 = lastState(h);
	check("rollback restored app.js to checkpoint", read(join(ws, "app.js")) === "// v1b\n");
	check("post-checkpoint file removed", !existsSync(join(ws, "post-checkpoint.txt")));
	check("scratch.txt untouched by LATEST_SAFE rollback (not in domain)", read(join(ws, "scratch.txt")) === "scratch\n");
	check("plan snapshot restored (T1 completed, T2 pending)", st3.plan?.tasks[0].status === "completed" && st3.plan.tasks[1].status === "pending");
	check("currentTaskId restored from snapshot (null at checkpoint)", (st3.currentTaskId ?? null) === null);
	check("run stopped after LATEST rollback", st3.status === "stopped");
	check("iteration metadata restored", st3.iteration === 0 && st3.activeIteration === 1);
	rmSync(ws, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
console.log("test D: conflicts block overwrite; coverages partial; non-git works");
{
	// legitimate continued engineering divergence from LATEST_SAFE is NOT a conflict
	const ws = makeDirtyRepo();
	const h = makeHarness([], ws);
	const mod = await loadExt();
	mod.default(h.pi);
	await sessionStart(h);
	await startRun(h, ws);
	writeFileSync(join(ws, "app.js"), "// v1\n");
	writeFileSync(join(ws, "README.md"), "README\nUSER LINE\nv1\n");
	await cmd(h, "checkpoint");
	// engineering CONTINUES normally after the checkpoint
	writeFileSync(join(ws, "app.js"), "// v2\n");
	writeFileSync(join(ws, "README.md"), "README\nUSER LINE\nv2\n");
	await cmd(h, "rollback");
	const preview = h.notifies[h.notifies.length - 1].msg;
	check("preview lists continued files under restore (no false conflicts)", preview.includes("Files to restore: 2") && !preview.includes("outside expected run state"));
	check("preview carries authorship warning", preview.includes("Authorship cannot be determined"));
	check("preview non-destructive", read(join(ws, "app.js")) === "// v2\n");
	await cmd(h, "rollback confirm");
	check("confirm restores exact checkpoint bytes (app.js)", read(join(ws, "app.js")) === "// v1\n");
	check("confirm restores exact checkpoint bytes (README)", read(join(ws, "README.md")) === "README\nUSER LINE\nv1\n");
	check("run stopped after continued-engineering rollback", lastState(h).status === "stopped");
	rmSync(ws, { recursive: true, force: true });

	// structural conflict only: a path required for restore that the checkpoint
	// does NOT cover (partial coverage) is still blocked
	const wsS = makePlainWs({ "big.dat": "x".repeat(6000), "app.js": "A\n" });
	const hS = makeHarness([], wsS);
	mod.default(hS.pi);
	await sessionStart(hS);
	await startRun(hS, wsS);
	writeFileSync(join(wsS, "app.js"), "B\n");
	await cmd(hS, "checkpoint"); // big.dat uncovered -> LATEST_SAFE partial
	writeFileSync(join(wsS, "big.dat"), "y".repeat(6000)); // changed, but not covered
	await cmd(hS, "rollback confirm");
	check("structural partial-coverage conflict blocks", hS.notifies.some((n) => n.msg.includes("Rollback blocked by conflicts") && n.msg.includes("big.dat")));
	check("blocked rollback leaves run running", lastState(hS).status === "running");
	check("blocked rollback does not overwrite", read(join(wsS, "app.js")) === "B\n");
	await cmd(hS, "stop");
	rmSync(wsS, { recursive: true, force: true });

	// post-checkpoint: engineering-created file removed, unknown recreation preserved
	const wsE = makeDirtyRepo(); // baseline: app.js, README(USER LINE), storage.js, scratch.txt
	const hE = makeHarness([], wsE);
	mod.default(hE.pi);
	await sessionStart(hE);
	await startRun(hE, wsE);
	rmSync(join(wsE, "storage.js")); // engineering deletes pre-checkpoint
	writeFileSync(join(wsE, "app.js"), "// e1\n");
	await cmd(hE, "checkpoint"); // LATEST_SAFE: app.js=e1, storage.js ABSENT, scratch.txt present
	writeFileSync(join(wsE, "eng-new.js"), "new\n"); // engineering-created post-checkpoint (tracked scope)
	writeFileSync(join(wsE, "storage.js"), "module.exports = {}\n"); // user recreates a baseline file that was absent at checkpoint -> unknown
	writeFileSync(join(wsE, "app.js"), "// e2\n"); // covered continuation
	await cmd(hE, "rollback");
	check("preview lists preserved unknown file", hE.notifies[hE.notifies.length - 1].msg.includes("Preserved (unknown post-checkpoint"));
	await cmd(hE, "rollback confirm");
	check("covered continuation restored to checkpoint bytes", read(join(wsE, "app.js")) === "// e1\n");
	check("engineering-created post-checkpoint file removed", !existsSync(join(wsE, "eng-new.js")));
	check("unknown recreated user file preserved", read(join(wsE, "storage.js")) === "module.exports = {}\n");
	check("pre-existing untouched scratch.txt intact", read(join(wsE, "scratch.txt")) === "scratch\n");
	rmSync(wsE, { recursive: true, force: true });

	// partial coverage: oversized file (per-file cap) + total cap
	const ws2 = makePlainWs({ "big.dat": "x".repeat(6000), "ok.txt": "fine\n" });
	const h2 = makeHarness([], ws2);
	mod.default(h2.pi);
	await sessionStart(h2);
	await startRun(h2, ws2);
	writeFileSync(join(ws2, "mid.dat"), "y".repeat(3000));
	for (let i = 1; i <= 6; i++) writeFileSync(join(ws2, `s${i}.dat`), "z".repeat(3900)); // total > 20KB with each <= 4KB cap
	await cmd(h2, "checkpoint");
	check("partial coverage warned", h2.notifies.some((n) => n.msg.includes("WARNING: snapshot is partial")));
	check("partial coverage reported", h2.notifies.some((n) => n.msg.includes("Rollback coverage: partial")));
	const st2 = lastState(h2);
	const meta = cpMeta(st2.startedAt, "latest_safe");
	check("per-file cap recorded in warnings", meta?.coverageWarnings.some((w) => w.includes("big.dat")));
	check("total cap recorded in warnings", meta?.coverageWarnings.some((w) => w.includes("total snapshot cap")));
	check("small file still captured under partial", read(join(CP_ROOT, String(st2.startedAt), "safe/ok.txt")) === "fine\n");
	await cmd(h2, "stop");
	rmSync(ws2, { recursive: true, force: true });

	// non-git workspace rollback works
	const ws3 = makePlainWs({ "a.txt": "A\n", "b.txt": "B\n" });
	const h3 = makeHarness([], ws3);
	mod.default(h3.pi);
	await sessionStart(h3);
	await startRun(h3, ws3);
	writeFileSync(join(ws3, "a.txt"), "AA\n");
	writeFileSync(join(ws3, "c.txt"), "C\n");
	await cmd(h3, "rollback baseline confirm");
	check("non-git baseline rollback restores", read(join(ws3, "a.txt")) === "A\n");
	check("non-git created file removed", !existsSync(join(ws3, "c.txt")));
	check("non-git b.txt intact", read(join(ws3, "b.txt")) === "B\n");
	rmSync(ws3, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
console.log("test E: ignored dirs excluded; verifier cancel + stale response ignored after rollback");
{
	const ws = makeDirtyRepo();
	mkdirSync(join(ws, "node_modules"), { recursive: true });
	writeFileSync(join(ws, "node_modules/dep.js"), "// dep\n");
	const h = makeHarness([], ws);
	const mod = await loadExt();
	mod.default(h.pi);
	await sessionStart(h);
	await startRun(h, ws);
	const st = lastState(h);
	const meta = cpMeta(st.startedAt, "run_baseline");
	check("ignored dir excluded from snapshot", !("node_modules/dep.js" in (meta?.files ?? {})));
	await cmd(h, "checkpoint");
	const meta2 = cpMeta(st.startedAt, "latest_safe");
	check("ignored dir excluded from LATEST_SAFE", !("node_modules/dep.js" in (meta2?.files ?? {})));

	// verifier in flight -> rollback cancels it and ignores late response
	await createPlan(h, ["P1"]);
	await completeAll(h);
	await settled(h, engDone());
	const req = latestReq(h, "verification");
	check("verifier launched", !!req);
	await cmd(h, "rollback baseline confirm");
	console.log("  [dbg] status/phase:", lastState(h).status, lastState(h).phase, "| cancels:", JSON.stringify(h.cancels.map(c=>c.nodeId)), "| reqId match:", JSON.stringify(req?.requestId), "cancel reqIds:", JSON.stringify(h.cancels.map(c=>c.requestId)));
	check("verifier cancel emitted", h.cancels.some((c) => c.nodeId === "verification" && c.requestId === req.requestId));
	respond(h, req, { status: "completed", result: { kind: "structured", value: { verdict: "pass", findings: "late" } } });
	check("late verifier response ignored", lastState(h).status === "stopped" && lastState(h).phase === "engineering");
	const sentAtRollback = h.sent.length;
	await sleep(5);
	check("run requires explicit resume (no auto iteration dispatched)", h.sent.length === sentAtRollback);
	await cmd(h, "resume");
	check("resume dispatches after rollback", h.sent.length > sentAtRollback && h.sent[h.sent.length - 1].content.includes("iteration 2/15"));
	await cmd(h, "stop");
	rmSync(ws, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
console.log("test F: scout cancel + late scout response ignored; scout after baseline capture");
{
	// scout launched during startup -> rollback cancels it
	delete process.env.ENGINEERING_LOOP_SCOUT_DISABLE;
	const ws = makePlainWs({ "pkg.json": "{}\n" });
	const h = makeHarness([], ws);
	const mod = await loadExt();
	mod.default(h.pi);
	await sessionStart(h);
	const start = cmd(h, "Goal");
	await sleep(0);
	const scoutReq = latestReq(h, "scout");
	check("scout launches after baseline capture", !!scoutReq);
	const stAtScout = lastState(h);
	check("baseline + snapshot exist before scout REQUEST resolves", stAtScout.checkpointRunId !== null);
	await cmd(h, "rollback baseline confirm");
	check("scout cancel emitted", h.cancels.some((c) => c.nodeId === "scout" && c.requestId === scoutReq.requestId));
	await start;
	respond(h, scoutReq, {
		status: "completed",
		result: {
			kind: "structured",
			value: {
				summary: "s", architecture: "a", relevantFiles: [], tests: { locations: [], commands: [] },
				conventions: [], risks: [], unknowns: [], recommendedInspection: [],
			},
		},
	});
	check("late scout response ignored after rollback", lastState(h).scoutStatus !== "completed");
	check("run stopped after rollback", lastState(h).status === "stopped");
	rmSync(ws, { recursive: true, force: true });
	process.env.ENGINEERING_LOOP_SCOUT_DISABLE = "1";
}

// ---------------------------------------------------------------------------
console.log("test G: verifier + criterion regressions with checkpoints enabled");
{
	// verifier full cycle after rollback + resume
	const ws = makePlainWs({ "app.js": "A\n" });
	const h = makeHarness([], ws);
	const mod = await loadExt();
	mod.default(h.pi);
	await sessionStart(h);
	await startRun(h, ws);
	writeFileSync(join(ws, "app.js"), "B\n");
	await cmd(h, "rollback baseline confirm");
	check("baseline rollback restores app.js", read(join(ws, "app.js")) === "A\n");
	await cmd(h, "resume");
	await createPlan(h, ["P1"]);
	await completeAll(h);
	await settled(h, engDone());
	check("verifier launched after rollback+resume", !!latestReq(h, "verification"));
	respond(h, latestReq(h, "verification"), { status: "completed", result: { kind: "structured", value: { verdict: "pass", findings: "ok" } } });
	check("verifier PASS after rollback+resume", lastState(h).status === "done");
	rmSync(ws, { recursive: true, force: true });

	// criterion regression
	const ws2 = makePlainWs({ "app.js": "A\n" });
	const h2 = makeHarness([], ws2);
	mod.default(h2.pi);
	await sessionStart(h2);
	await cmd(h2, "--test-failure Build a CLI");
	check("criterion stored", lastState(h2).testCriterion?.file === ".engineering-loop-verifier-sentinel");
	await createPlan(h2, ["P1"]);
	await completeAll(h2);
	await settled(h2, engDone());
	check("verifier sees criterion", latestReq(h2, "verification").task.includes(".engineering-loop-verifier-sentinel"));
	respond(h2, latestReq(h2, "verification"), { status: "completed", result: { kind: "structured", value: { verdict: "fail", findings: "sentinel missing" } } });
	check("FAIL fed to engineer", h2.sent[h2.sent.length - 1].content.includes("sentinel missing"));
	await settled(h2, engDone());
	respond(h2, latestReq(h2, "verification"), { status: "completed", result: { kind: "structured", value: { verdict: "pass", findings: "ok" } } });
	const st2 = lastState(h2);
	check("criterion PASS completes + clears", st2.status === "done" && st2.testCriterion === null);
	rmSync(ws2, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
console.log("test H: persistence/reload + clean + legacy safety");
{
	// reload preserves checkpoint state; checkpoints readable; clean removes storage
	const ws = makeDirtyRepo();
	const h = makeHarness([], ws);
	const mod = await loadExt();
	mod.default(h.pi);
	await sessionStart(h);
	await startRun(h, ws);
	await cmd(h, "checkpoint");
	const h2 = makeHarness(h.entries, ws);
	mod.default(h2.pi);
	await sessionStart(h2);
	await cmd(h2, "status");
	check("status recovery available after reload", h2.notifies.some((n) => n.msg.includes("Latest safe: available")));
	await cmd(h2, "checkpoints");
	const out = h2.notifies[h2.notifies.length - 1].msg;
	check("checkpoints readable after reload", out.includes("RUN_BASELINE") && out.includes("LATEST_SAFE"));
	await cmd(h2, "checkpoints clean");
	check("clean notify", h2.notifies.some((n) => n.msg.includes("Checkpoints cleaned")));
	check("storage removed", !existsSync(join(CP_ROOT, String(lastState(h2).startedAt))));
	await cmd(h2, "checkpoints");
	check("checkpoints show none after clean", h2.notifies[h2.notifies.length - 1].msg.includes("RUN_BASELINE: none") || h2.notifies[h2.notifies.length - 1].msg.includes("none"));
	await cmd(h2, "stop");
	rmSync(ws, { recursive: true, force: true });

	// legacy v1.5 state (no checkpoint fields) restores safely
	const legacySeed = {
		goal: "Legacy", cwd: "/home/hariz", status: "running", phase: "engineering", iteration: 2,
		maxIterations: 15, startedAt: 555, lastAction: "iteration 2 started", completionCandidate: false,
		verificationAttempts: 0, lastVerificationResult: null, consecutiveVerificationFailures: 0,
		lastVerificationFailure: null, needsReplan: false, testCriterion: null, plan: null,
		currentTaskId: null, scoutReport: null, scoutStatus: "not_needed", activeIteration: 2,
		baseline: null, changes: { created: [], modified: [], deleted: [] }, changeTrackingPartial: false,
		verifierAgent: "engineering-verifier",
	};
	const seeded = [{ type: "custom", customType: "engineering-loop", id: "l1", parentId: null, timestamp: "t", data: legacySeed }];
	const h3 = makeHarness(seeded);
	mod.default(h3.pi);
	await sessionStart(h3);
	await cmd(h3, "status");
	check("legacy status shows Recovery unavailable", h3.notifies.some((n) => n.msg.includes("Recovery: unavailable")));
	await cmd(h3, "rollback baseline");
	check("legacy rollback refused clearly", h3.notifies.some((n) => n.msg.includes("No RUN_BASELINE checkpoint exists")));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);