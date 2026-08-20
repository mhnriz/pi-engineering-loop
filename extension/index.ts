/**
 * engineering-loop — bounded autonomous engineering loop for pi.
 *
 * Commands:
 *   /engineer <goal>             Start a new engineering run and trigger iteration 1.
 *   /engineer --test-failure <g> TEST-ONLY: start the run AND arm a deterministic
 *                               verifier-only acceptance criterion (the engineer
 *                               never sees it; only the isolated verifier does).
 *   /engineer status             Show goal, status, phase, iteration, verification info.
 *   /engineer stop               Stop the loop (no further iterations).
 *   /engineer resume             Resume a stopped run (or a run left dormant by /reload).
 *
 * The loop is driven by the agent_settled lifecycle event: each engineering
 * iteration is an ordinary user message sent to the parent agent. When the
 * agent fully settles, the final assistant message is inspected for
 * <ENGINEER_DONE> and the next step is triggered automatically.
 *
 * Verification (v1.2) is NOT a parent-agent turn: on <ENGINEER_DONE> the
 * run switches to the "verifying" phase and an isolated `engineering-verifier`
 * subagent is launched through the pi-subagents structured delegation API
 * (fresh context, structured { verdict, findings } result). The extension
 * remains the deterministic orchestrator — the subagent never controls the
 * loop.
 *
 * State is persisted as session custom entries (pi.appendEntry), so it
 * survives /reload. An in-flight phase flag guarantees at most one engineering
 * turn is ever in flight and prevents a reloaded instance from restarting a
 * duplicate turn. After a reload the loop is intentionally dormant until
 * /engineer resume; resume continues whichever phase (engineering or
 * verifying) was active.
 *
 * Each run is bound to the workspace it was started in (state.cwd). Iteration
 * prompts carry the workspace rules, and the loop refuses to send iterations
 * when the workspace no longer exists (status = "blocked").
 *
 * <ENGINEER_DONE> means the engineer believes the goal is complete and is
 * requesting verification. The isolated verifier's structured verdict decides:
 * pass completes the run; fail returns to the engineering phase with the
 * findings attached. Verification runs never consume an engineering iteration
 * and are capped (MAX_VERIFICATION_ATTEMPTS). Repeated consecutive
 * verification failures set a re-plan requirement (REPLAN_AFTER_FAILURES) and
 * finally block the run (BLOCK_AFTER_FAILURES). A TEST-ONLY deterministic
 * acceptance injection (/engineer --test-failure) arms a verifier-only
 * criterion (a required workspace file with exact content) that the engineer
 * never sees in its prompt; the isolated verifier enforces it, its FAIL
 * findings teach the engineer the repair, and the criterion is cleared when
 * the run completes or terminates. It is never enabled automatically.
 *
 * v1.3 persistent structured planning: the extension owns a structured task
 * ledger (EngineeringPlan) persisted as part of run state. The engineer
 * creates the plan with engineer_plan_create after inspecting the repo (never
 * auto-generated from the goal), then start/complete/block/reopen tasks with
 * the engineer_task_* tools. Iteration prompts carry a compact plan snapshot;
 * <ENGINEER_DONE> only launches the isolated verifier once the plan exists
 * and every task is completed (pending/in-progress/blocked tasks reject
 * completion). Plans survive /reload, restart, stop/resume, verification
 * failures, and compaction.
 */
import { Type } from "typebox";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	SCOUT_AGENT,
	SCOUT_DEADLINE_GRACE_MS,
	SCOUT_NODE_ID,
	SCOUT_SCHEMA,
	SCOUT_TIMEOUT_MS,
	VERIFIER_AGENT,
	VERIFIER_ALLOWED_TOOLS,
	VERIFIER_DEADLINE_GRACE_MS,
	VERIFIER_NODE_ID,
	VERIFIER_SCHEMA,
	VERIFIER_TIMEOUT_MS,
	buildScoutTask,
	buildVerifierTask,
	loadSubagentsCapabilityCeiling,
	loadSubagentsDelegationApi,
	type ScoutReport,
	type VerifierResponse,
} from "./verifier.ts";
import {
	type ChangeBaseline,
	type EngineeringChangeManifest,
	captureWorkspaceBaseline,
	computeSafetyWarnings,
	formatChangeList,
	refreshWorkspaceChanges,
} from "./workspace.ts";
import {
	captureCheckpoint,
	cleanCheckpoints,
	executeRollback,
	listCheckpoints,
	planRollback,
	readCheckpoint,
	type CheckpointType,
} from "./checkpoints.ts";
import {
	configPath,
	loadConfig,
	type EngineeringLoopConfig,
} from "./config.ts";
import { DEPENDENCY_MISSING_MSG, isSubagentsDependencyAvailable } from "./verifier.ts";

const CUSTOM_TYPE = "engineering-loop";

// v1.7: effective settings from <agentDir>/engineering-loop/config.json
// (safe defaults preserve v1.6 behavior). Read once at extension load.
const CONFIG: EngineeringLoopConfig = loadConfig();
const MAX_ITERATIONS = CONFIG.maxIterations;
const MAX_VERIFICATION_ATTEMPTS = CONFIG.maxVerificationAttempts;
// After this many consecutive verification failures, the next engineering
// prompt requires a re-plan (attack the problem differently).
const REPLAN_AFTER_FAILURES = CONFIG.replanAfterFailures;
// After this many consecutive verification failures, block the run instead
// of burning further iterations.
const BLOCK_AFTER_FAILURES = CONFIG.maxConsecutiveVerificationFailures;
const MIB = 1024 * 1024;
// Effective timeouts: test-only/CI env overrides win, else config.
const scoutTimeout = (): number =>
	Number(process.env.ENGINEERING_LOOP_SCOUT_TIMEOUT_MS) || CONFIG.scoutTimeoutMs;
const verifierTimeout = (): number =>
	Number(process.env.ENGINEERING_LOOP_VERIFIER_TIMEOUT_MS) || CONFIG.verifierTimeoutMs;
const checkpointLimits = (): { perFileBytes: number; totalBytes: number } => ({
	perFileBytes: Number(process.env.ENGINEERING_LOOP_SNAPSHOT_FILE_MAX) || Math.round(CONFIG.checkpointPerFileLimitMiB * MIB),
	totalBytes: Number(process.env.ENGINEERING_LOOP_SNAPSHOT_TOTAL_MAX) || Math.round(CONFIG.checkpointTotalLimitMiB * MIB),
});
// --- v1.3 structured planning limits ---
const MAX_PLAN_TASKS = 30;
const MAX_EVIDENCE_LENGTH = 1000;
const MAX_REASON_LENGTH = 500;
const DONE_MARKER = "<ENGINEER_DONE>";

// Delegation statuses that mean the verifier never ran / the request was
// rejected (infrastructure), as opposed to the verifier running and
// rejecting the implementation (verdict) or crashing (runtime failure).
const INFRASTRUCTURE_FAILURE_STATUSES = new Set([
	"invalid_request",
	"unavailable_context",
	"duplicate_node",
]);

// TEST-ONLY: deterministic verifier-only acceptance criterion armed by
// /engineer --test-failure. The engineer prompt NEVER contains this; only
// the isolated verifier task does. Never enabled automatically.
const TEST_CRITERION_FILE = ".engineering-loop-verifier-sentinel";
const TEST_CRITERION_CONTENT = "VERIFIER_REPAIR_CONFIRMED";

// Shown in the engineering prompt after repeated consecutive failures.
const RE_PLAN_INSTRUCTION = [
	"RE-PLAN REQUIRED:",
	"",
	"Previous attempts have repeatedly failed verification.",
	"Before editing anything:",
	"",
	"1. Re-read the original goal.",
	"2. Re-read the verifier findings.",
	"3. Inspect the relevant implementation and tests.",
	"4. Explain internally what assumption or approach was wrong.",
	"5. Choose a materially different corrective approach.",
	"6. Then implement and verify it.",
].join("\n");

// v1.3: shown at the start of an engineering iteration that has no plan yet.
const PLANNING_REQUIRED = [
	"PLANNING REQUIRED",
	"",
	"No engineering plan exists yet.",
	"",
	"Before substantial implementation:",
	"",
	"1. Inspect the repository and original goal.",
	"2. Break the goal into a concise ordered engineering plan.",
	"3. Use engineer_plan_create to persist it.",
	"4. Start the highest-value first task with engineer_task_start.",
	"5. Then begin implementation.",
	"",
	"Even small goals should have a minimal plan.",
	"Do not create unnecessary micro-tasks.",
	"",
	"Workspace recovery is available through user-controlled checkpoints (/engineer checkpoint, /engineer rollback). Do not attempt Git reset/clean/restore operations.",
].join("\n");

// v1.3: engineer behavior once a plan exists.
const PLAN_BEHAVIOR_INSTRUCTIONS = [
	"Plan instructions:",
	"1. Read the current plan (engineer_plan_read).",
	"2. Continue the current in-progress task if one exists.",
	"3. Otherwise select the highest-value pending task.",
	"4. Call engineer_task_start.",
	"5. Perform the work.",
	"6. Verify the work.",
	"7. Call engineer_task_complete only with real evidence.",
	"8. Move to another task if useful within the same turn.",
	"9. Keep the task ledger accurate.",
	"10. Never mark work completed merely because code was written.",
	"",
	"You may complete multiple small tasks in one iteration if appropriate.",
	"Do not force exactly one task per turn.",
	"",
	"Workspace recovery is available through user-controlled checkpoints (/engineer checkpoint, /engineer rollback). Do not attempt Git reset/clean/restore operations.",
].join("\n");

const TASK_MARKERS: Record<EngineeringTaskStatus, string> = {
	completed: "[x]",
	in_progress: "[>]",
	pending: "[ ]",
	blocked: "[!]",
};

type EngineerStatus = "running" | "stopped" | "done" | "limit-reached" | "blocked";
type EngineerPhase = "engineering" | "verifying";

// TEST-ONLY: a deterministic acceptance criterion enforced ONLY by the
// isolated verifier. The engineer never sees it in its prompt.
interface TestCriterion {
	file: string;
	content: string;
}

// --- v1.3 structured planning types ---------------------------------------
type EngineeringTaskStatus = "pending" | "in_progress" | "completed" | "blocked";

interface EngineeringTask {
	id: string;
	title: string;
	description?: string;
	status: EngineeringTaskStatus;
	evidence?: string;
	notes?: string;
}

interface EngineeringPlan {
	version: 1;
	createdAt: string;
	updatedAt: string;
	tasks: EngineeringTask[];
}

interface VerifierResult {
	verdict: "pass" | "fail" | "none";
	findings: string;
}

// Concise persistent record of the latest verifier failure (not a transcript).
interface VerifierFailure {
	summary: string;
	attempt: number;
	timestamp: string;
}

interface EngineerState {
	goal: string;
	cwd: string;
	status: EngineerStatus;
	phase: EngineerPhase;
	iteration: number;
	maxIterations: number;
	startedAt: number;
	lastAction: string;
	completionCandidate: boolean;
	verificationAttempts: number;
	lastVerificationResult: VerifierResult | null;
	// v1.1 reliability hardening:
	consecutiveVerificationFailures: number;
	lastVerificationFailure: VerifierFailure | null;
	needsReplan: boolean;
	// TEST-ONLY deterministic acceptance criterion (armed via
	// /engineer --test-failure). Persisted so stop/resume and reloads behave
	// correctly; cleared when the run completes or terminates.
	testCriterion: TestCriterion | null;
	// v1.3 structured planning: extension-owned task ledger.
	plan: EngineeringPlan | null;
	currentTaskId: string | null;
	// v1.4 isolated repository scouting (startup snapshot; advisory only).
	scoutReport: ScoutReport | null;
	scoutStatus: "not_needed" | "pending" | "running" | "completed" | "failed";
	scoutError?: string;
	// v1.3.1: human-visible iteration currently active (dispatched but not
	// necessarily settled), so status shows 1/15 while iteration 1 runs.
	activeIteration: number;
	// v1.5 workspace change tracking: one-time baseline + run change manifest.
	baseline: ChangeBaseline | null;
	changes: EngineeringChangeManifest;
	changeTrackingPartial: boolean;
	// v1.6 recoverable checkpoints: extension-owned byte snapshots outside the
	// workspace. checkpointRunId is the stable storage key (derived from
	// startedAt); rollbackCoverage reflects the RUN_BASELINE snapshot coverage.
	checkpointRunId: string | null;
	rollbackCoverage: "full" | "partial" | null;
	rollbackWarnings?: string[];
	latestSafeAt?: string | null;
	// v1.2 isolated verification:
	verifierAgent: string;
}

export default function (pi: ExtensionAPI) {
	let state: EngineerState | null = null;
	// Phase of the loop-triggered PARENT-AGENT turn currently in flight
	// (waiting for agent_settled): "engineering" for an engineer iteration,
	// null when idle. (v1.2: verification is an isolated subagent, not a
	// parent turn, so this is never "verifying" anymore.) Consumed
	// synchronously in agent_settled so two settled events can never both
	// process the same turn.
	let inFlightPhase: "engineering" | null = null;
	// Id of the last assistant message this instance processed at a settled
	// event. A settled event that fires with no new assistant work (duplicate
	// event, aborted turn) is skipped, which makes overlapping turns
	// impossible rather than merely unlikely.
	let lastProcessedAssistantId: string | null = null;
	// v1.2: the currently running isolated verification delegation (module
	// state only — never persisted; a restarted session re-launches fresh).
	interface ActiveVerification {
		requestId: string;
		ownerRunId: string;
		settled: boolean;
		cancel: () => void;
		unsubscribe: () => void;
		deadline: NodeJS.Timeout;
	}
	let activeVerification: ActiveVerification | null = null;
	// v1.4: the currently running isolated scout delegation (module state only).
	interface ActiveScout {
		requestId: string;
		ownerRunId: string;
		cancel: () => void;
	}
	let activeScout: ActiveScout | null = null;
	// v1.2: optional session-scoped capability ceiling while a run is active
	// (defense-in-depth; disposal is best-effort).
	let capCeiling: { dispose(): void } | null = null;

	const persistState = (): void => {
		if (state) pi.appendEntry(CUSTOM_TYPE, { ...state });
	};

	// v1.3: validates and normalizes a persisted plan (or returns null for
	// legacy/absent states). Task ids are preserved so they stay stable across
	// reloads and restarts.
	const restorePlan = (raw: unknown): EngineeringPlan | null => {
		const p = raw as EngineeringPlan | undefined;
		if (!p || !Array.isArray(p.tasks)) return null;
		if (p.tasks.length === 0 || p.tasks.length > MAX_PLAN_TASKS) return null;
		const tasks: EngineeringTask[] = [];
		for (let i = 0; i < p.tasks.length; i++) {
			const t = p.tasks[i];
			if (!t || typeof t.title !== "string" || !t.title.trim()) return null;
			const status =
				t.status === "completed" ||
				t.status === "in_progress" ||
				t.status === "blocked" ||
				t.status === "pending"
					? t.status
					: "pending";
			tasks.push({
				id: typeof t.id === "string" && t.id.trim() ? t.id : `T${i + 1}`,
				title: t.title.trim(),
				...(typeof t.description === "string" && t.description ? { description: t.description } : {}),
				status,
				...(typeof t.evidence === "string" && t.evidence ? { evidence: t.evidence } : {}),
				...(typeof t.notes === "string" && t.notes ? { notes: t.notes } : {}),
			});
		}
		return {
			version: 1,
			createdAt: typeof p.createdAt === "string" ? p.createdAt : new Date().toISOString(),
			updatedAt: typeof p.updatedAt === "string" ? p.updatedAt : new Date().toISOString(),
			tasks,
		};
	};

	// Validates and normalizes a persisted scout report (or null).
	const restoreScoutReport = (raw: unknown): ScoutReport | null => {
		const r = raw as ScoutReport | undefined;
		if (!r || typeof r.summary !== "string" || typeof r.architecture !== "string") return null;
		if (!Array.isArray(r.relevantFiles) || !r.tests || !Array.isArray(r.tests.locations)) return null;
		if (!Array.isArray(r.conventions) || !Array.isArray(r.risks)) return null;
		if (!Array.isArray(r.unknowns) || !Array.isArray(r.recommendedInspection)) return null;
		return {
			summary: r.summary.slice(0, 2000),
			architecture: r.architecture.slice(0, 4000),
			relevantFiles: r.relevantFiles
				.slice(0, 15)
				.map((f) => ({
					path: String(f?.path ?? "").slice(0, 1000),
					reason: String(f?.reason ?? "").slice(0, 1000),
				}))
				.filter((f) => f.path),
			tests: {
				locations: Array.isArray(r.tests.locations) ? r.tests.locations.slice(0, 10).map((s) => String(s).slice(0, 1000)) : [],
				commands: Array.isArray(r.tests.commands) ? r.tests.commands.slice(0, 10).map((s) => String(s).slice(0, 1000)) : [],
			},
			conventions: Array.isArray(r.conventions) ? r.conventions.slice(0, 15).map((s) => String(s).slice(0, 1000)) : [],
			risks: Array.isArray(r.risks) ? r.risks.slice(0, 10).map((s) => String(s).slice(0, 1000)) : [],
			unknowns: Array.isArray(r.unknowns) ? r.unknowns.slice(0, 10).map((s) => String(s).slice(0, 1000)) : [],
			recommendedInspection: Array.isArray(r.recommendedInspection)
				? r.recommendedInspection.slice(0, 10).map((s) => String(s).slice(0, 1000))
				: [],
		};
	};

	// v1.5: validates/normalizes a persisted baseline (or null).
	const restoreBaseline = (raw: unknown): ChangeBaseline | null => {
		const b = raw as ChangeBaseline | undefined;
		if (!b || typeof b.capturedAt !== "string" || !Array.isArray(b.files)) return null;
		const strArr = (v: unknown, max: number): string[] =>
			Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, max) : [];
		return {
			capturedAt: b.capturedAt,
			gitAvailable: b.gitAvailable === true,
			...(typeof b.gitRoot === "string" && b.gitRoot ? { gitRoot: b.gitRoot } : {}),
			...(typeof b.branch === "string" && b.branch ? { branch: b.branch } : {}),
			trackedModified: strArr(b.trackedModified, 2000),
			trackedDeleted: strArr(b.trackedDeleted, 2000),
			untracked: strArr(b.untracked, 2000),
			files: b.files
				.slice(0, 4000)
				.map((f) => ({
					path: typeof f?.path === "string" ? f.path : "",
					size: typeof f?.size === "number" ? f.size : 0,
					...(typeof f?.mtimeMs === "number" ? { mtimeMs: f.mtimeMs } : {}),
					...(typeof f?.hash === "string" && f.hash ? { hash: f.hash } : {}),
				}))
				.filter((f) => f.path),
			partial: b.partial === true,
		};
	};

	const restoreChangeManifest = (raw: unknown): EngineeringChangeManifest => {
		const c = raw as EngineeringChangeManifest | undefined;
		const strArr = (v: unknown): string[] =>
			Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 2000) : [];
		return { created: strArr(c?.created), modified: strArr(c?.modified), deleted: strArr(c?.deleted) };
	};

	// v1.5: refresh the run change manifest against the current workspace.
	// Captures a one-time (possibly late) baseline for legacy runs with a
	// transparency warning. Never recaptures an existing baseline.
	const refreshChangeManifest = (ctx: ExtensionContext, silent = false): void => {
		if (!state) return;
		if (state.baseline === null) {
			const baseline = captureWorkspaceBaseline(state.cwd);
			if (!baseline) return; // TEST-ONLY disable
			state.baseline = baseline;
			state.changes = { created: [], modified: [], deleted: [] };
			state.changeTrackingPartial = baseline.partial;
			persistState();
			if (!silent) {
				ctx.ui.notify(
					"Late baseline captured — changes before this point cannot be attributed to the run",
					"warning",
				);
			}
			return;
		}
		const { changes, partial } = refreshWorkspaceChanges(state.baseline, state.cwd);
		state.changes = changes;
		state.changeTrackingPartial = partial;
		persistState();
	};

	const restoreState = (ctx: ExtensionContext): void => {
		state = null;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === CUSTOM_TYPE) {
				const data = entry.data as EngineerState | undefined;
				if (
					data &&
					typeof data.goal === "string" &&
					typeof data.status === "string" &&
					typeof data.iteration === "number" &&
					typeof data.maxIterations === "number"
				) {
					const rawResult = data.lastVerificationResult as VerifierResult | undefined;
					const rawFailure = data.lastVerificationFailure as VerifierFailure | undefined;
					// v1.3: restore the structured plan (validated) and its current
					// task. Legacy states without a plan restore as null/null.
					const restoredPlan = restorePlan(data.plan);
					state = {
						...data,
						// Legacy entries (pre-workspace-binding) fall back to the
						// current working directory; new runs always restore the
						// workspace they were started in.
						cwd: typeof data.cwd === "string" && data.cwd.length > 0 ? data.cwd : ctx.cwd,
						completionCandidate: data.completionCandidate === true,
						phase:
							data.phase === "verifying" || data.phase === "engineering"
								? data.phase
								: "engineering",
						verificationAttempts:
							typeof data.verificationAttempts === "number" && data.verificationAttempts >= 0
								? data.verificationAttempts
								: 0,
						lastVerificationResult:
							rawResult &&
							typeof rawResult.findings === "string" &&
							(rawResult.verdict === "pass" ||
								rawResult.verdict === "fail" ||
								rawResult.verdict === "none")
								? rawResult
								: null,
						consecutiveVerificationFailures:
							typeof data.consecutiveVerificationFailures === "number" &&
							data.consecutiveVerificationFailures >= 0
								? data.consecutiveVerificationFailures
								: 0,
						lastVerificationFailure:
							rawFailure &&
							typeof rawFailure.summary === "string" &&
							typeof rawFailure.attempt === "number" &&
							typeof rawFailure.timestamp === "string"
								? rawFailure
								: null,
						needsReplan: data.needsReplan === true,
						// TEST-ONLY: the verifier-only criterion is restored as
						// persisted so stop/resume (including after /reload) keeps
						// enforcing the SAME criterion. It is cleared on run
						// completion or termination, so a restored terminal run
						// never carries a stale criterion.
						testCriterion:
							data.testCriterion &&
							typeof data.testCriterion.file === "string" &&
							typeof data.testCriterion.content === "string"
								? { file: data.testCriterion.file, content: data.testCriterion.content }
								: null,
						verifierAgent:
							typeof data.verifierAgent === "string" && data.verifierAgent.length > 0
								? data.verifierAgent
								: VERIFIER_AGENT,
						plan: restoredPlan,
						currentTaskId:
							restoredPlan &&
							typeof data.currentTaskId === "string" &&
							restoredPlan.tasks.some((t) => t.id === data.currentTaskId)
								? data.currentTaskId
								: null,
						// v1.4 scout fields (legacy states restore safely: no report,
						// not_needed).
						scoutReport: restoreScoutReport(data.scoutReport),
						scoutStatus:
							data.scoutStatus === "completed" ||
							data.scoutStatus === "failed" ||
							data.scoutStatus === "running" ||
							data.scoutStatus === "pending"
								? data.scoutStatus
								: "not_needed",
						scoutError:
							typeof data.scoutError === "string" && data.scoutError ? data.scoutError : undefined,
						activeIteration:
							typeof data.activeIteration === "number" && data.activeIteration >= 0
								? data.activeIteration
								: data.iteration,
						// v1.5: baseline + manifest (legacy states restore as no tracking).
						baseline: restoreBaseline(data.baseline),
						changes: restoreChangeManifest(data.changes),
						changeTrackingPartial: data.changeTrackingPartial === true,
						// v1.6: checkpoint state (legacy states restore with no recovery).
						checkpointRunId:
							typeof data.checkpointRunId === "string" && data.checkpointRunId ? data.checkpointRunId : null,
						rollbackCoverage:
							data.rollbackCoverage === "full" || data.rollbackCoverage === "partial"
								? data.rollbackCoverage
								: null,
						rollbackWarnings: Array.isArray(data.rollbackWarnings)
							? data.rollbackWarnings.filter((w): w is string => typeof w === "string").slice(0, 200)
							: undefined,
						latestSafeAt:
							typeof data.latestSafeAt === "string" && data.latestSafeAt ? data.latestSafeAt : null,
					};
				}
			}
		}
		// A reload may have aborted the in-flight turn. Never auto-restart it:
		// the run stays dormant until the user runs /engineer resume.
		inFlightPhase = null;
		lastProcessedAssistantId = null;
	};

	const buildIterationPrompt = (
		goal: string,
		cwd: string,
		iteration: number,
		maxIterations: number,
		opts: {
			verificationFailure?: string;
			needsReplan?: boolean;
			completionRejection?: string;
		} = {},
	): string => {
		const lines: string[] = [
			`You are in ENGINEERING LOOP iteration ${iteration}/${maxIterations}.`,
			"",
			"WORKSPACE:",
			cwd,
			"",
			"Rules:",
			"- Work only inside this workspace unless the original goal explicitly requires otherwise.",
			"- Never silently create a replacement project elsewhere.",
			"- If the goal cannot reasonably be completed inside this workspace, explain the blocker.",
			"- Do not modify files outside the workspace merely because expected project files are missing.",
			"",
			"Goal:",
			goal,
			"",
		];
		// v1.5: pre-existing dirty workspace warning (counts only — never a dump).
		if (
			state?.baseline &&
			state.baseline.trackedModified.length + state.baseline.trackedDeleted.length + state.baseline.untracked.length > 0
		) {
			lines.push(
				"WORKSPACE SAFETY",
				"",
				"This workspace had pre-existing modifications/untracked files before this engineering run.",
				"",
				`Pre-existing: ${state.baseline.trackedModified.length} modified, ${state.baseline.untracked.length} untracked${state.baseline.trackedDeleted.length ? `, ${state.baseline.trackedDeleted.length} deleted` : ""}`,
				"",
				"Do not overwrite unrelated existing work.",
				"Only modify files necessary for the goal.",
				"",
			);
		}
		if (opts.verificationFailure) {
			lines.push(
				"PREVIOUS VERIFICATION FAILURE:",
				"",
				opts.verificationFailure,
				"",
				"You must address this failure before requesting verification again.",
				"",
			);
		}
		if (opts.needsReplan) {
			lines.push(RE_PLAN_INSTRUCTION, "", "");
		}
		if (opts.completionRejection) {
			lines.push(opts.completionRejection, "");
		}
		// v1.4: compact scout report (reconnaissance, advisory only).
		if (state?.scoutStatus === "completed" && state.scoutReport) {
			lines.push(renderScoutSection(state.scoutReport), "");
			lines.push(
				"Scout findings are reconnaissance, not absolute truth. Verify material assumptions before editing. Use Scout findings to create a better engineering plan. Do not blindly follow guessed commands/files.",
				"",
			);
		}
		// v1.3: compact structured plan snapshot (or planning requirement).
		if (state && state.plan) {
			lines.push(renderPlanSnapshot(state.plan, state.currentTaskId), "", PLAN_BEHAVIOR_INSTRUCTIONS, "");
		} else {
			lines.push(PLANNING_REQUIRED, "");
		}
		lines.push(
			"Work autonomously toward the goal.",
			"",
			"For this iteration:",
			"1. Inspect the current repository and existing work before making assumptions.",
			"2. Determine the highest-value unfinished engineering task.",
			"3. Make concrete progress using the available tools.",
			"4. Run relevant verification such as tests, builds, linters, typechecks, or targeted runtime checks.",
			"5. Inspect failures and fix them when reasonably possible.",
			"6. Do not merely describe work that could be done; perform it.",
			"7. Keep changes scoped to the goal.",
			"8. Do not claim completion without evidence.",
			"9. End your response with exactly one machine-readable marker:",
			"",
			"<ENGINEER_CONTINUE>",
			"or",
			"<ENGINEER_DONE>",
			"",
			"Use <ENGINEER_DONE> only when the original goal is genuinely complete and verification supports it.",
		);
		return lines.join("\n");
	};

	// v1.3: compact plan snapshot injected into every engineering iteration.
	// Keeps prompt size small: full per-task lines, detail only for the current
	// task and blocked tasks. Never includes historical evidence.
	const renderPlanSnapshot = (
		plan: EngineeringPlan,
		currentTaskId: string | null,
	): string => {
		const completed = plan.tasks.filter((t) => t.status === "completed").length;
		const lines: string[] = [
			"ENGINEERING PLAN",
			"",
			`Progress: ${completed}/${plan.tasks.length} completed`,
			"",
		];
		for (const t of plan.tasks) {
			lines.push(`${TASK_MARKERS[t.status]} ${t.id} ${t.title}`);
		}
		const current = plan.tasks.find((t) => t.id === currentTaskId && t.status === "in_progress");
		if (current) {
			lines.push("", "Current task:", `${current.id} — ${current.title}`);
			if (current.description) lines.push(`  Description: ${current.description}`);
		}
		const blockedTasks = plan.tasks.filter((t) => t.status === "blocked");
		for (const b of blockedTasks) {
			lines.push("", `Blocked: ${b.id} — ${b.title}`);
			if (b.description) lines.push(`  Description: ${b.description}`);
			if (b.notes) lines.push(`  Reason: ${b.notes}`);
		}
		return lines.join("\n");
	};

	// v1.3: rendered when <ENGINEER_DONE> was rejected by the completion gate,
	// so the next engineering prompt explicitly shows the unfinished tasks.
	const renderCompletionRejection = (reason: string, tasks: EngineeringTask[]): string => {
		const lines: string[] = [
			"COMPLETION REJECTED:",
			reason,
			"",
			...(tasks.length > 0
				? [
						"Unfinished tasks:",
						...tasks.map((t) => `${TASK_MARKERS[t.status]} ${t.id} — ${t.title} (${t.status})`),
						"",
					]
				: []),
			"Complete or resolve these tasks before requesting verification again.",
		];
		return lines.join("\n");
	};

	// v1.3 completion gate: <ENGINEER_DONE> only reaches the isolated verifier
	// when a plan exists and every task is completed. Blocked tasks also reject
	// completion (no optional-task semantics in v1.3).
	const evaluateCompletionGate = ():
		| { ok: true }
		| { ok: false; reason: string; promptBlock: string } => {
		if (!state || !state.plan) {
			return {
				ok: false,
				reason: "no engineering plan exists",
				promptBlock: renderCompletionRejection(
					"No engineering plan exists. Use engineer_plan_create to create one before requesting verification.",
				[],
			),
			};
		}
		const unfinished = state.plan.tasks.filter((t) => t.status !== "completed");
		if (unfinished.length === 0) return { ok: true };
		const blockedOnly =
			unfinished.length > 0 && unfinished.every((t) => t.status === "blocked");
		const reason = blockedOnly
			? "engineering plan contains blocked tasks"
			: "engineering plan still has unfinished tasks";
		return {
			ok: false,
			reason,
			promptBlock: renderCompletionRejection(reason, unfinished),
		};
	};

	// v1.4: compact scout report renderer (keeps prompt size small; never dumps
	// the raw report).
	const renderScoutSection = (report: ScoutReport): string => {
		const lines: string[] = ["SCOUT REPORT", "", `Summary: ${report.summary}`, "", `Architecture: ${report.architecture}`, ""];
		if (report.relevantFiles.length) {
			lines.push("Relevant files:");
			for (const f of report.relevantFiles.slice(0, 12)) lines.push(`- ${f.path} — ${f.reason}`);
			lines.push("");
		}
		if (report.tests.locations.length || report.tests.commands.length) {
			lines.push(
				`Tests: locations: ${report.tests.locations.slice(0, 5).join(", ") || "?"} | likely commands: ${report.tests.commands.slice(0, 5).join(", ") || "?"}`,
				"",
			);
		}
		if (report.conventions.length) lines.push(`Conventions: ${report.conventions.slice(0, 6).join("; ")}`, "");
		const risksUnknowns = [...report.risks, ...report.unknowns].slice(0, 6);
		if (risksUnknowns.length) {
			lines.push("Risks / unknowns:", ...risksUnknowns.map((s) => `- ${s}`), "");
		}
		if (report.recommendedInspection.length) {
			lines.push("Recommended files to inspect:", ...report.recommendedInspection.slice(0, 5).map((s) => `- ${s}`));
		}
		return lines.join("\n");
	};

	// Sends a message to the agent. No-op when no run is active or when a loop
	// turn is already in flight (never two at once). Refuses to send when the
	// bound workspace no longer exists.
	const sendTurn = (ctx: ExtensionContext, prompt: string): void => {
		if (ctx.isIdle()) {
			pi.sendUserMessage(prompt);
		} else {
			pi.sendUserMessage(prompt, { deliverAs: "followUp" });
		}
	};

	// Returns false (and blocks the run) when the bound workspace vanished.
	const guardWorkspace = (ctx: ExtensionContext): boolean => {
		if (!state || existsSync(state.cwd)) return true;
		state.status = "blocked";
		state.lastAction = "blocked: workspace no longer exists";
		state.testCriterion = null; // TEST-ONLY: never outlive a terminated run.
		persistState();
		ctx.ui.notify(
			`Engineering loop blocked: workspace no longer exists (${state.cwd})`,
			"error",
		);
		return false;
	};

	// Sends the next engineering iteration prompt. Consumes the re-plan flag
	// (applies to this iteration only). TEST-ONLY: the verifier criterion is
	// deliberately NOT sent to the engineer.
	const triggerEngineering = (
		ctx: ExtensionContext,
		verificationFailure?: string,
		completionRejection?: string,
	): void => {
		if (!state || inFlightPhase) return;
		if (!guardWorkspace(ctx)) return;
		const iteration = state.iteration + 1;
		const opts = {
			verificationFailure,
			needsReplan: state.needsReplan,
			completionRejection,
		};
		// Consume the re-plan flag now: it applies only to the prompt being sent.
		state.needsReplan = false;
		// v1.3.1: track the human-visible iteration being dispatched so status
		// shows 1/15 while iteration 1 is still running.
		state.activeIteration = iteration;
		inFlightPhase = "engineering";
		state.lastAction = `iteration ${iteration} started`;
		persistState();
		ctx.ui.notify(`Iteration ${iteration}/${state.maxIterations}`, "info");
		sendTurn(
			ctx,
			buildIterationPrompt(
				state.goal,
				state.cwd,
				iteration,
				state.maxIterations,
				opts,
			),
		);
	};

	// ---------------------------------------------------------------------------
	// v1.4 workspace emptiness heuristic (deterministic, cheap, no LLM).
	// ---------------------------------------------------------------------------

	const IGNORABLE_SCOUT_ENTRIES = new Set([".git", ".gitignore", ".DS_Store"]);

	const isEmptyDirectory = (p: string): boolean => {
		try {
			return readdirSync(p).length === 0;
		} catch {
			return false;
		}
	};

	// True when the workspace looks effectively empty (no meaningful project
	// files beyond .git/.gitignore/.DS_Store, empty directories, or the
	// TEST-ONLY verifier sentinel). Unreadable cwd counts as non-empty so a
	// real workspace-access problem surfaces through the workspace guard.
	const workspaceLooksEmpty = (cwd: string): boolean => {
		// TEST-ONLY hook: force scouting off (used by the older regression
		// suites that exercise empty-workspace flows against /home/hariz).
		if (process.env.ENGINEERING_LOOP_SCOUT_DISABLE === "1") return true;
		let entries;
		try {
			entries = readdirSync(cwd, { withFileTypes: true });
		} catch {
			return false;
		}
		for (const e of entries) {
			if (IGNORABLE_SCOUT_ENTRIES.has(e.name)) continue;
			if (e.name === TEST_CRITERION_FILE) continue;
			if (e.isDirectory()) {
				if (!isEmptyDirectory(join(cwd, e.name))) return false;
				continue;
			}
			// any file (or other non-ignored entry) means a meaningful workspace
			return false;
		}
		return true;
	};

	// ---------------------------------------------------------------------------
	// v1.4 isolated scouting via pi-subagents structured delegation
	// (mirrors the verifier's identity/deadline/duplicate pattern).
	// ---------------------------------------------------------------------------

	const isCurrentScout = (runKey: string, requestId: string): boolean =>
		!!state &&
		state.status === "running" &&
		activeScout?.requestId === requestId &&
		ownerRunId() === runKey;

	const cancelActiveScout = (): void => {
		if (!activeScout) return;
		const s = activeScout;
		activeScout = null;
		try {
			s.cancel();
		} catch {
			// best effort
		}
	};

	// Mechanical structural validation of the scout report (the delegation
	// bridge already schema-validates; this is defense in depth).
	const isValidScoutReport = (value: unknown): value is ScoutReport => {
		const r = value as ScoutReport | undefined;
		if (!r || typeof r.summary !== "string" || typeof r.architecture !== "string") return false;
		if (!Array.isArray(r.relevantFiles) || !r.tests || !Array.isArray(r.tests.locations)) return false;
		return true;
	};

	// Runs the isolated scout, awaiting its structured report (or a failure).
	// Scouting never consumes an engineering iteration and never counts against
	// verifier attempts. At most one scout attempt per run.
	const runScout = async (ctx: ExtensionContext): Promise<{ success: boolean; report?: ScoutReport; error?: string }> => {
		if (!state || activeScout) return { success: false, error: "scout already active" };
		if (state.scoutStatus === "completed" || state.scoutStatus === "not_needed") {
			return {
				success: state.scoutStatus === "completed",
				report: state.scoutStatus === "completed" && state.scoutReport ? state.scoutReport : undefined,
			};
		}

		let api;
		try {
			api = await loadSubagentsDelegationApi();
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			return { success: false, error: `scout launch failed: ${msg}` };
		}

		const requestId = crypto.randomUUID();
		const runKey = ownerRunId();
		const runTimeout = scoutTimeout();
		state.scoutStatus = "running";
		state.lastAction = "scout reconnaissance launched";
		persistState();
		ctx.ui.notify("Scout launched — repository reconnaissance", "info");

		let resolveOutcome: (o: { success: boolean; report?: ScoutReport; error?: string }) => void;
		const outcome = new Promise<{ success: boolean; report?: ScoutReport; error?: string }>((res) => {
			resolveOutcome = res;
		});
		let settled = false;
		const finish = (o: { success: boolean; report?: ScoutReport; error?: string }): void => {
			if (settled) return;
			settled = true;
			clearTimeout(deadline);
			unsubscribe();
			if (activeScout?.requestId === requestId) activeScout = null;
			resolveOutcome(o);
		};
		const cancel = (): void => {
			if (settled) return;
			settled = true;
			clearTimeout(deadline);
			unsubscribe();
			if (activeScout?.requestId === requestId) activeScout = null;
			pi.events.emit(api.SUBAGENT_DELEGATION_CANCEL_EVENT, {
				requestId,
				ownerRunId: runKey,
				nodeId: SCOUT_NODE_ID,
			});
			resolveOutcome({ success: false, error: "cancelled" });
		};
		const unsubscribe = pi.events.on(api.SUBAGENT_DELEGATION_RESPONSE_EVENT, (payload: unknown) => {
			const response = payload as VerifierResponse | undefined;
			if (!response || response.requestId !== requestId) return;
			if (!isCurrentScout(runKey, requestId)) {
				// stale (e.g. run stopped): unblock without applying anything
				finish({ success: false, error: "stale" });
				return;
			}
			finish(routeScoutResponse(response));
		});
		const deadline = setTimeout(() => {
			finish({ success: false, error: `Scout timed out after ${Math.round((runTimeout + SCOUT_DEADLINE_GRACE_MS) / 60_000)} minutes.` });
		}, runTimeout + SCOUT_DEADLINE_GRACE_MS);

		activeScout = { requestId, ownerRunId: runKey, cancel };
		pi.events.emit(api.SUBAGENT_DELEGATION_REQUEST_EVENT, {
			requestId,
			ownerRunId: runKey,
			nodeId: SCOUT_NODE_ID,
			agent: SCOUT_AGENT,
			task: buildScoutTask(state.goal, state.cwd),
			context: "fresh",
			cwd: state.cwd,
			thinking: "high",
			timeoutMs: runTimeout,
			result: { kind: "structured", schema: SCOUT_SCHEMA },
		});
		return outcome;
	};

	// Routes a scout delegation outcome. Scouting failures are NOT engineering
	// failures (optimization, not a correctness gate).
	const routeScoutResponse = (response: VerifierResponse): { success: boolean; report?: ScoutReport; error?: string } => {
		if (response.status === "completed") {
			const value = response.result?.kind === "structured" ? response.result.value : undefined;
			if (isValidScoutReport(value)) return { success: true, report: value };
			return { success: false, error: `Scout returned an invalid structured report (${response.status}).` };
		}
		const msg = response.error ? String(response.error) : "no detail provided";
		return {
			success: false,
			error: `Scout ${response.status}: ${msg}`.slice(0, 300),
		};
	};

	// Applies a scouting outcome to state; falls back to direct engineering
	// inspection on any scouting failure (never blocks the goal).
	const applyScoutOutcome = (outcome: { success: boolean; report?: ScoutReport; error?: string }, ctx: ExtensionContext): void => {
		if (!state) return;
		if (outcome.success && outcome.report) {
			state.scoutReport = outcome.report;
			state.scoutStatus = "completed";
			state.scoutError = undefined;
			state.lastAction = "scout reconnaissance completed";
		} else {
			state.scoutStatus = "failed";
			state.scoutError = outcome.error ?? "Scout unavailable";
			state.lastAction = "scout unavailable — direct inspection";
			ctx.ui.notify("Scout unavailable — continuing with direct engineering inspection", "warning");
		}
		persistState();
	};

	// ---------------------------------------------------------------------------
	// v1.2 isolated verification via pi-subagents structured delegation
	// ---------------------------------------------------------------------------

	// Stable logical owner identity for this engineering run (survives restarts
	// because startedAt is persisted).
	const ownerRunId = (): string => `${CUSTOM_TYPE}:${state?.startedAt ?? 0}`;

	// True only for the verification attempt that is CURRENT for this run:
	// guards against stale/late responses (e.g. after /engineer stop or a
	// restarted run with the same startedAt).
	const isCurrentVerification = (runKey: string, requestId: string): boolean =>
		!!state &&
		state.status === "running" &&
		state.phase === "verifying" &&
		ownerRunId() === runKey &&
		activeVerification?.requestId === requestId;

	const cancelActiveVerification = (): void => {
		if (!activeVerification) return;
		const v = activeVerification;
		activeVerification = null;
		try {
			v.cancel();
		} catch {
			// best effort: the child may already be gone
		}
	};

	// Optional defense-in-depth: while a run is active, restrict subagent
	// launches in this session to the verifier and its tool allowlist. The
	// agent allowlist is mandatory; this ceiling is best-effort only — any
	// failure is swallowed so the extension never becomes brittle.
	const registerCapCeiling = (ctx: ExtensionContext): void => {
		if (capCeiling || !state || state.status !== "running") return;
		loadSubagentsCapabilityCeiling()
			.then((api) => {
				if (capCeiling || !state || state.status !== "running") return;
				capCeiling = api.registerSubagentCapabilityCeiling({
					sessionId: ctx.sessionManager.getSessionId(),
					source: "engineering-loop",
					ceiling: {
						// Both isolated agents are allowed. The shared allowedTools
						// set includes bash only for the verifier: the scout AGENT'S
						// own allowlist has no bash, and the ceiling intersects with
						// agent allowlists, so scout never gains bash.
						allowedAgents: [VERIFIER_AGENT, SCOUT_AGENT],
						allowedTools: [...VERIFIER_ALLOWED_TOOLS],
					},
				});
			})
			.catch(() => {
				// ceiling is optional; ignore registration failures
			});
	};

	const disposeCapCeiling = (): void => {
		try {
			capCeiling?.dispose();
		} catch {
			// best effort
		}
		capCeiling = null;
	};

	// v1.5: compact run-change context for the verifier task (audit aid only).
	const buildVerifierChangeContext = ():
		| { changes: EngineeringChangeManifest; preExistingCount: number; partial: boolean; warnings: string[] }
		| undefined => {
		if (!state || !state.baseline) return undefined;
		return {
			changes: state.changes,
			preExistingCount:
				state.baseline.trackedModified.length +
				state.baseline.trackedDeleted.length +
				state.baseline.untracked.length,
			partial: state.changeTrackingPartial,
			warnings: computeSafetyWarnings(state.changes, state.changeTrackingPartial),
		};
	};

	// Launches one isolated verifier delegation. Never two at once
	// (activeVerification guard). Response is delivered asynchronously via the
	// per-request event listener; a local deadline is the backstop if the
	// bridge never answers.
	const launchVerifier = async (ctx: ExtensionContext): Promise<void> => {
		if (!state || state.phase !== "verifying" || activeVerification) return;

		// v1.5: fresh change manifest before every verifier launch.
		refreshChangeManifest(ctx, true);

		let api;
		try {
			api = await loadSubagentsDelegationApi();
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			state.status = "blocked";
			state.lastAction = `blocked: verifier launch failed (${msg})`;
			state.testCriterion = null; // TEST-ONLY: never outlive a terminated run.
			persistState();
			disposeCapCeiling();
			ctx.ui.notify(
				`Engineering loop blocked: verifier launch failed — ${truncateForNotify(msg)}`,
				"error",
			);
			return;
		}

		const requestId = crypto.randomUUID();
		const runKey = ownerRunId();
		const runTimeout = verifierTimeout();
		// TEST-ONLY: the armed criterion (if any) is passed to EVERY verifier
		// attempt of this run until the run completes or terminates — attempt 2
		// receives the same criterion as attempt 1.
		const testCriterion = state.testCriterion;
		let settled = false;
		const settle = (): void => {
			settled = true;
			clearTimeout(deadline);
			unsubscribe();
		};
		const unsubscribe = pi.events.on(
			api.SUBAGENT_DELEGATION_RESPONSE_EVENT,
			(payload: unknown) => {
				const response = payload as VerifierResponse | undefined;
				if (!response || response.requestId !== requestId || settled) return;
				// Identity guard: only accept the response while this exact
				// verification is the current one for this run.
				if (!isCurrentVerification(runKey, requestId)) return;
				settle();
				activeVerification = null;
				handleVerifierResponse(ctx, response);
			},
		);
		const deadline = setTimeout(() => {
			if (settled) return;
			settle();
			activeVerification = null;
			handleVerifierResponse(ctx, {
				requestId,
				status: "no_response",
				error: `Verifier did not respond within ${Math.round(
					(runTimeout + VERIFIER_DEADLINE_GRACE_MS) / 60_000,
				)} minutes.`,
			});
		}, runTimeout + VERIFIER_DEADLINE_GRACE_MS);

		activeVerification = {
			requestId,
			ownerRunId: runKey,
			settled: false,
			unsubscribe,
			deadline,
			cancel: () => {
				if (settled) return;
				settled = true;
				clearTimeout(deadline);
				unsubscribe();
				pi.events.emit(api.SUBAGENT_DELEGATION_CANCEL_EVENT, {
					requestId,
					ownerRunId: runKey,
					nodeId: VERIFIER_NODE_ID,
				});
			},
		};

		state.verificationAttempts += 1;
		state.lastAction = `isolated verification attempt ${state.verificationAttempts} launched`;
		persistState();
		ctx.ui.notify(
			`Engineer done — isolated verifier launched (attempt ${state.verificationAttempts}/${MAX_VERIFICATION_ATTEMPTS})`,
			"info",
		);
		// Subscribe-before-emit is guaranteed above (listener registered before
		// this emit).
		pi.events.emit(api.SUBAGENT_DELEGATION_REQUEST_EVENT, {
			requestId,
			ownerRunId: runKey,
			nodeId: VERIFIER_NODE_ID,
			agent: VERIFIER_AGENT,
			task: buildVerifierTask(state.goal, state.cwd, testCriterion, buildVerifierChangeContext()),
			context: "fresh",
			cwd: state.cwd,
			thinking: "high",
			timeoutMs: runTimeout,
			result: { kind: "structured", schema: VERIFIER_SCHEMA },
		});
	};

	// Routes a delegation outcome. Distinguishes:
	//  - infrastructure failure  -> blocked (the verifier never ran)
	//  - completed + pass        -> done
	//  - completed + fail        -> v1.1 failure machinery
	//  - completed + malformed   -> conservative failure
	//  - runtime failure         -> conservative failure with error summary
	const handleVerifierResponse = (ctx: ExtensionContext, response: VerifierResponse): void => {
		if (!state) return;
		const status = response.status;
		const error = response.error ? String(response.error) : "no detail provided";

		if (INFRASTRUCTURE_FAILURE_STATUSES.has(status)) {
			// The verifier never ran / the request was rejected: do NOT pretend
			// the implementation failed verification. Block with a clear reason.
			state.status = "blocked";
			state.lastAction = `blocked: verifier infrastructure failure (${status})`;
			state.testCriterion = null; // TEST-ONLY: never outlive a terminated run.
			persistState();
			disposeCapCeiling();
			ctx.ui.notify(
				`Engineering loop blocked: verifier infrastructure failure (${status}) — ${truncateForNotify(error)}`,
				"error",
			);
			return;
		}

		if (status === "completed") {
			const value =
				response.result?.kind === "structured" ? response.result.value : undefined;
			const record = value as { verdict?: unknown; findings?: unknown } | undefined;
			const verdict =
				record?.verdict === "pass" ? "pass" : record?.verdict === "fail" ? "fail" : null;
			const findings = typeof record?.findings === "string" ? record.findings : "";
			if (verdict === "pass") {
				handleVerifierResult(ctx, { verdict: "pass", findings });
				return;
			}
			if (verdict === "fail") {
				handleVerifierResult(ctx, {
					verdict: "fail",
					findings: findings || "Verifier returned no findings.",
				});
				return;
			}
			// completed but structurally invalid value: never assume success
			handleVerifierResult(ctx, {
				verdict: "fail",
				findings: `Verifier returned an invalid structured result: ${JSON.stringify(value).slice(0, 200)}`,
			});
			return;
		}

		// Runtime verifier failure (failed / timed_out / interrupted /
		// structured_output_failed / tool_budget_exhausted / turn_budget_exhausted
		// / no_response): conservative — never mark the goal complete; count as
		// a failed attempt with an understandable error. No automatic relaunch;
		// the existing attempt/consecutive limits bound the loop.
		handleVerifierResult(ctx, {
			verdict: "fail",
			findings: `Verifier error (${status}): ${truncateForNotify(error, 200)}`,
		});
	};

	// v1.7: concise final completion report (no huge file lists; details remain
	// available via /engineer changes | plan | checkpoints).
	const reportCompletion = (ctx: ExtensionContext, verified: boolean): void => {
		if (!state) return;
		const planTotal = state.plan?.tasks.length ?? 0;
		const planDone = state.plan?.tasks.filter((t) => t.status === "completed").length ?? 0;
		const scoutLine =
			state.scoutStatus === "completed"
				? "completed"
				: state.scoutStatus === "not_needed"
					? "skipped"
					: state.scoutStatus === "failed"
						? "failed fallback"
						: "—";
		ctx.ui.notify(
			[
				"Engineering run complete",
				`Goal: ${state.goal.length > 90 ? state.goal.slice(0, 90) + "…" : state.goal}`,
				`Iterations: ${state.iteration}`,
				`Plan: ${planDone}/${planTotal} completed`,
				`Verification attempts: ${state.verificationAttempts}`,
				"",
				`Scout: ${scoutLine}`,
				`Changes: +${state.changes.created.length} created, ~${state.changes.modified.length} modified, -${state.changes.deleted.length} deleted`,
				`Change tracking: ${state.changeTrackingPartial ? "partial" : "full"}`,
				`Verification: ${verified ? "passed" : "skipped (verifier disabled)"}`,
				"",
				"Recovery:",
				`  Run baseline: ${state.rollbackCoverage ? "available" : "none"}`,
				`  Latest safe: ${state.latestSafeAt ? "available" : "none"}`,
				`  Rollback coverage: ${state.rollbackCoverage ?? "none"}`,
			].join("\n"),
			"info",
		);
	};

	// Applies a structured verifier result to the state machine. PASS completes
	// the run; FAIL feeds the v1.1 failure machinery (consecutive counter,
	// re-plan threshold, stall block, max attempts) and returns to engineering.
	const handleVerifierResult = (
		ctx: ExtensionContext,
		result: { verdict: "pass" | "fail"; findings: string },
	): void => {
		if (!state) return;

		if (result.verdict === "pass") {
			// v1.5: final manifest refresh before completion.
			refreshChangeManifest(ctx, true);
			state.consecutiveVerificationFailures = 0;
			state.lastVerificationFailure = null;
			state.needsReplan = false;
			// TEST-ONLY: verification passed — clear the criterion so the run
			// completes as a normal run and no later run inherits it.
			state.testCriterion = null;
			state.status = "done";
			state.lastAction = "done — isolated verification passed";
			state.lastVerificationResult = { verdict: "pass", findings: result.findings };
			persistState();
			disposeCapCeiling();
			reportCompletion(ctx, true);
			return;
		}

		const summary = result.findings || "Verifier did not provide findings.";
		state.lastVerificationResult = { verdict: "fail", findings: summary };
		state.consecutiveVerificationFailures += 1;
		state.lastVerificationFailure = {
			summary,
			attempt: state.verificationAttempts,
			timestamp: new Date().toISOString(),
		};
		state.needsReplan =
			state.needsReplan || state.consecutiveVerificationFailures >= REPLAN_AFTER_FAILURES;
		persistState();

		// Repeated stall: block before burning further iterations.
		if (state.consecutiveVerificationFailures >= BLOCK_AFTER_FAILURES) {
			state.status = "blocked";
			state.lastAction = `blocked: ${state.consecutiveVerificationFailures} consecutive verification failures`;
			state.testCriterion = null; // TEST-ONLY: never outlive a terminated run.
			persistState();
			disposeCapCeiling();
			ctx.ui.notify(
				`Engineering loop blocked: ${state.consecutiveVerificationFailures} consecutive verification failures. ${truncateForNotify(summary)}`,
				"error",
			);
			return;
		}
		// Total-attempts backstop (non-consecutive failures can still add up).
		if (state.verificationAttempts >= MAX_VERIFICATION_ATTEMPTS) {
			state.status = "blocked";
			state.lastAction = "blocked: verification attempts exhausted";
			state.testCriterion = null; // TEST-ONLY: never outlive a terminated run.
			persistState();
			disposeCapCeiling();
			ctx.ui.notify(
				`Verification attempts exhausted (${MAX_VERIFICATION_ATTEMPTS}) — engineering loop blocked`,
				"error",
			);
			return;
		}
		state.phase = "engineering";
		state.lastAction = "verification failed — back to engineering";
		persistState();
		// v1.5: manifest refresh after a verifier FAIL (before the repair turn).
		refreshChangeManifest(ctx, true);
		ctx.ui.notify("Isolated verification failed — engineers fixing findings", "warning");
		triggerEngineering(ctx, summary);
	};

	// Returns the id and text of the iteration's final assistant response, or
	// null when there is nothing to inspect yet.
	const lastAssistantEntry = (
		ctx: ExtensionContext,
	): { id: string; text: string } | null => {
		for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
			const text = msg.content
				.filter(
					(part): part is { type: "text"; text: string } =>
						typeof part === "object" &&
						part !== null &&
						(part as { type?: unknown }).type === "text" &&
						typeof (part as { text?: unknown }).text === "string",
				)
				.map((part) => part.text)
				.join("\n");
			return { id: entry.id, text };
		}
		return null;
	};

	// Shortens a value for TUI notifications / status lines.
	const truncateForNotify = (text: string, max = 160): string =>
		text.length > max ? text.slice(0, max) + "…" : text;

	// --- Loop driver ---------------------------------------------------------

	pi.on("agent_settled", async (_event, ctx) => {
		// Consume the in-flight phase synchronously: a settled event belongs to
		// the turn that was in flight, and a second settled event (or a
		// reloaded instance) must never process the same turn twice.
		const settledPhase = inFlightPhase;
		inFlightPhase = null;
		if (!settledPhase) return;
		if (!state || state.status !== "running") return;

		try {
			const last = lastAssistantEntry(ctx);
			if (!last || last.id === lastProcessedAssistantId) {
				// Skip settles with no new assistant work: a duplicate settled
				// event or an aborted turn must not count as progress. Re-arm
				// the in-flight ENGINEERING phase on the skip path so an
				// over-eager flag consume can never swallow a live turn's
				// settle. (v1.2: verification is an isolated subagent tracked by
				// activeVerification, not a parent turn, so only "engineering"
				// is re-armed.)
				inFlightPhase = state.phase === "engineering" ? "engineering" : null;
				return;
			}
			lastProcessedAssistantId = last.id;

			// v1.5: refresh the run change manifest once the turn settled
			// (this also covers "before launching the verifier" for the DONE
			// path).
			refreshChangeManifest(ctx, true);

			if (settledPhase === "verifying") {
				// Defensive: v1.2 never marks a parent turn as "verifying"; a
				// stale flag from an older version is ignored.
				return;
			}

			// Engineering turn. Only <ENGINEER_DONE> matters here; verifier
			// markers in the message are ignored as stale.
			const done = last.text.includes(DONE_MARKER);

			state.iteration += 1;
			state.lastAction = `iteration ${state.iteration} complete`;
			persistState();

			if (done) {
				// v1.3 completion gate: never trust the model's completion claim
				// over structured plan state.
				const gate = evaluateCompletionGate();
				if (!gate.ok) {
					state.lastAction = `completion rejected: ${gate.reason}`;
					persistState();
					ctx.ui.notify(`Completion rejected — ${gate.reason}`, "warning");
					// /engineer stop may have raced in during the turn.
					if (state.status !== "running") return;
					if (state.iteration >= state.maxIterations) {
						state.status = "limit-reached";
						state.lastAction = "iteration limit reached";
						persistState();
						disposeCapCeiling();
						ctx.ui.notify("Iteration limit reached", "warning");
						return;
					}
					// The next prompt explicitly shows the unfinished tasks.
					triggerEngineering(ctx, undefined, gate.promptBlock);
					return;
				}

				// v1.7: config.verifier=false completes the run directly after the
				// plan completion gate (no isolated verifier). The gate still
				// enforces a fully-completed plan; nothing else is bypassed.
				if (!CONFIG.verifier) {
					refreshChangeManifest(ctx, true);
					state.completionCandidate = true;
					state.consecutiveVerificationFailures = 0;
					state.lastVerificationFailure = null;
					state.needsReplan = false;
					state.testCriterion = null;
					state.status = "done";
					state.lastAction = "done — verifier disabled";
					state.lastVerificationResult = { verdict: "pass", findings: "Verifier disabled by config." };
					persistState();
					disposeCapCeiling();
					reportCompletion(ctx, false);
					return;
				}
				// The engineer claims completion and requests verification.
				// The run is NOT done yet: phase is persisted before the
				// isolated verifier is launched.
				state.completionCandidate = true;
				state.phase = "verifying";
				state.lastAction = "engineer requested verification";
				persistState();
				// launchVerifier resolves as soon as the delegation request is
				// emitted (the response arrives later via the event bus and is
				// routed by handleVerifierResponse). It never throws — internal
				// launch failures block the run.
				await launchVerifier(ctx);
				return;
			}
			// /engineer stop may have raced in during the turn.
			if (state.status !== "running") return;
			if (state.iteration >= state.maxIterations) {
				state.status = "limit-reached";
				state.lastAction = "iteration limit reached";
				state.testCriterion = null; // TEST-ONLY: never outlive a terminated run.
				persistState();
				disposeCapCeiling();
				ctx.ui.notify("Iteration limit reached", "warning");
				return;
			}
			triggerEngineering(ctx);
		} catch (error) {
			// Any extension exception stops the loop safely instead of
			// looping forever.
			inFlightPhase = null;
			if (state) {
				state.status = "stopped";
				state.lastAction = `error: ${error instanceof Error ? error.message : String(error)}`;
				state.testCriterion = null; // TEST-ONLY: never outlive a terminated run.
				persistState();
			}
			ctx.ui.notify("Engineering loop stopped due to error", "error");
		}
	});

	// --- State restore -------------------------------------------------------

	// v1.7: if the pi-subagents prerequisite is missing, fail gracefully with an
	// actionable message instead of crashing Pi. Checked once per load.
	let dependencyWarned = false;
	const warnDependencyOnce = (ctx: ExtensionContext): void => {
		if (dependencyWarned) return;
		if (isSubagentsDependencyAvailable()) return;
		dependencyWarned = true;
		ctx.ui.notify(DEPENDENCY_MISSING_MSG, "warning");
	};

	pi.on("session_start", async (_event, ctx) => {
		restoreState(ctx);
		warnDependencyOnce(ctx);
	});

	// v1.2: on shutdown, cancel any running verifier and release the
	// capability ceiling so other subagent work is not restricted next session.
	pi.on("session_shutdown", async () => {
		cancelActiveVerification();
		cancelActiveScout();
		disposeCapCeiling();
	});

	// --- Commands ------------------------------------------------------------

	const showStatus = (ctx: ExtensionContext): void => {
		if (!state) {
			ctx.ui.notify("No engineering run active", "info");
			return;
		}
		// v1.5: status shows fresh change counts.
		refreshChangeManifest(ctx, false);
		ctx.ui.notify(
			[
				`Goal: ${state.goal}`,
				`Workspace: ${state.cwd}`,
				`Status: ${state.status}`,
				`Phase: ${state.phase}`,
				`Verifier: ${state.verifierAgent}`,
				...(activeVerification ? ["Verifier active: yes"] : []),
				...(state.scoutStatus === "running" ? ["Scout: running"] : []),
				...(() => {
					const line =
						state.scoutStatus === "completed"
							? "Scout: completed"
							: state.scoutStatus === "not_needed"
								? "Scout: skipped (empty workspace)"
								: state.scoutStatus === "failed"
									? "Scout: failed — direct inspection fallback"
									: null;
					return line && state.scoutStatus !== "running" ? [line] : [];
				})(),
				`Iteration: ${Math.max(state.activeIteration ?? 0, state.iteration)}/${state.maxIterations}`,
				`Verification attempts: ${state.verificationAttempts}/${MAX_VERIFICATION_ATTEMPTS}`,
				`Consecutive verification failures: ${state.consecutiveVerificationFailures}`,
				...(state.lastVerificationFailure
					? [`Last verification failure: ${truncateForNotify(state.lastVerificationFailure.summary, 200)}`]
					: []),
				`Re-plan pending: ${state.needsReplan ? "yes" : "no"}`,
				...(state.testCriterion
					? [`Test verification criterion: active (TEST-ONLY)`]
					: []),
				// v1.6 recovery summary (kept concise; never dumps checkpoint contents).
				...(state.checkpointRunId
					? [
							"Recovery:",
							`  Baseline: ${state.rollbackCoverage ? "available" : "unavailable"}`,
							`  Latest safe: ${state.latestSafeAt ? "available" : "unavailable"}`,
							`  Rollback coverage: ${state.rollbackCoverage ?? "none"}`,
					  ]
					: ["Recovery: unavailable"]),
				// v1.3 compact plan section.
				...(state.plan
					? [
							`Plan: ${state.plan.tasks.filter((t) => t.status === "completed").length}/${state.plan.tasks.length} completed`,
							`Current task: ${(() => {
								const cur = state.plan?.tasks.find((t) => t.id === state?.currentTaskId && t.status === "in_progress");
								return cur ? `${cur.id} — ${cur.title}` : "none";
							})()}`,
							`Blocked: ${state.plan.tasks.filter((t) => t.status === "blocked").length}`,
							`Pending: ${state.plan.tasks.filter((t) => t.status === "pending").length}`,
					  ]
					: [`Plan: none`]),
				// v1.5 change tracking summary (counts only).
				...(state.baseline
					? [
							`Changes: +${state.changes.created.length} ~${state.changes.modified.length} -${state.changes.deleted.length}`,
							`Pre-existing dirty files: ${state.baseline.trackedModified.length + state.baseline.trackedDeleted.length + state.baseline.untracked.length}`,
							`Change tracking: ${state.changeTrackingPartial ? "partial" : "full"}`,
					  ]
					: [`Change tracking: none`]),
				`Last action: ${state.lastAction}`,
			].join("\n"),
			"info",
		);
	};

	const stopLoop = (ctx: ExtensionContext): void => {
		if (!state) {
			ctx.ui.notify("No engineering run active", "warning");
			return;
		}
		// v1.5: preserve the baseline and store the latest manifest on stop.
		refreshChangeManifest(ctx, true);
		state.status = "stopped";
		state.lastAction = "stopped";
		inFlightPhase = null;
		// TEST-ONLY: never outlive a terminated run — a later resume continues
		// as a normal run without the criterion.
		state.testCriterion = null;
		// Cancel a running isolated verifier and/or scout; their late responses
		// are ignored by the identity guards (status is no longer running).
		cancelActiveVerification();
		cancelActiveScout();
		disposeCapCeiling();
		persistState();
		ctx.ui.notify("Engineering loop stopped", "warning");
	};

	const resumeLoop = async (ctx: ExtensionContext): Promise<void> => {
		if (!state) {
			ctx.ui.notify("No engineering run to resume", "warning");
			return;
		}
		if (state.status === "running" && (inFlightPhase || activeVerification || activeScout)) {
			ctx.ui.notify("Engineering loop is already running", "warning");
			return;
		}
		if (state.status === "done" || state.status === "limit-reached" || state.status === "blocked") {
			ctx.ui.notify(
				`Engineering run is ${state.status} — start a new one with /engineer <goal>`,
				"warning",
			);
			return;
		}
		state.status = "running";
		state.lastAction = "resumed";
		persistState();
		// Resume the phase that was active when the run stopped. A verifying
		// run launches a FRESH verifier against the current workspace — the
		// old child process is never assumed to still exist.
		if (state.phase === "verifying") {
			registerCapCeiling(ctx);
			await launchVerifier(ctx);
		} else {
			registerCapCeiling(ctx);
			// v1.5: resume reuses the original baseline (never recaptures) and
			// refreshes the manifest; warn if the workspace changed while stopped.
			const baselineKey = state.baseline?.capturedAt ?? null;
			const manifestKey = JSON.stringify(state.changes);
			refreshChangeManifest(ctx, false);
			if (baselineKey && JSON.stringify(state.changes) !== manifestKey) {
				ctx.ui.notify(
					"Workspace changed while the loop was stopped — change manifest refreshed",
					"warning",
				);
			}
			// v1.4: if scouting was interrupted (not completed/failed), launch a
			// fresh scout before the next engineering iteration. Completed and
			// failed scouts are never relaunched (one attempt per run).
			if (state.scoutStatus === "pending" || state.scoutStatus === "running") {
				const outcome = await runScout(ctx);
				applyScoutOutcome(outcome, ctx);
				if (state.status !== "running") return;
			}
			triggerEngineering(ctx);
		}
	};

	const startLoop = async (
		goal: string,
		ctx: ExtensionContext,
		// TEST-ONLY: start the run with a verifier-only acceptance criterion
		// armed up front. The engineer NEVER sees it; only the isolated
		// verifier task does (appended to every verification attempt until
		// the run completes or terminates).
		opts: { testCriterion?: TestCriterion | null } = {},
	): Promise<void> => {
		if (inFlightPhase || activeVerification || activeScout) {
			ctx.ui.notify("Engineering loop is busy — use /engineer stop first", "warning");
			return;
		}
		state = {
			goal,
			cwd: ctx.cwd,
			status: "running",
			phase: "engineering",
			iteration: 0,
			maxIterations: MAX_ITERATIONS,
			startedAt: Date.now(),
			lastAction: "started",
			completionCandidate: false,
			verificationAttempts: 0,
			lastVerificationResult: null,
			consecutiveVerificationFailures: 0,
			lastVerificationFailure: null,
			needsReplan: false,
			testCriterion: opts.testCriterion ?? null,
			plan: null,
			currentTaskId: null,
			scoutReport: null,
			scoutStatus: "not_needed",
			activeIteration: 0,
			baseline: null,
			changes: { created: [], modified: [], deleted: [] },
			changeTrackingPartial: false,
			checkpointRunId: null,
			rollbackCoverage: null,
			latestSafeAt: null,
			verifierAgent: VERIFIER_AGENT,
		};
		lastProcessedAssistantId = null;
		persistState();
		// v1.5: workspace baseline captured exactly once, BEFORE scouting (the
		// scout is read-only and must not influence the baseline).
		const baseline = captureWorkspaceBaseline(state.cwd);
		if (baseline) {
			state.baseline = baseline;
			state.changes = { created: [], modified: [], deleted: [] };
			state.changeTrackingPartial = baseline.partial;
			persistState();
			// v1.6: extension-owned RUN_BASELINE recovery snapshot (exact bytes,
			// outside the workspace). Immutable for the run.
			const meta = captureCheckpoint({
				cwd: state.cwd,
				runId: runId(),
				type: "run_baseline",
				limits: checkpointLimits(),
			});
			if (meta) {
				state.checkpointRunId = runId();
				state.rollbackCoverage = meta.coverage;
				state.rollbackWarnings = meta.coverageWarnings.length ? meta.coverageWarnings : undefined;
				if (meta.coverage === "partial") {
					ctx.ui.notify(
						`Recovery baseline is PARTIAL — rollback cannot cover: ${meta.coverageWarnings.slice(0, 3).join("; ")}${meta.coverageWarnings.length > 3 ? ` (+${meta.coverageWarnings.length - 3} more)` : ""}`,
						"warning",
					);
				}
				persistState();
			}
		}
		registerCapCeiling(ctx);
		ctx.ui.notify("Engineering loop started", "info");
		if (state.testCriterion) {
			ctx.ui.notify(
				"Test verification criterion armed for isolated verifier (TEST-ONLY)",
				"warning",
			);
		}
		// v1.4: one startup Scout for existing/non-trivial workspaces. Scouting
		// does not consume an engineering iteration and never blocks the goal.
		// v1.7: config.scout=false disables the Scout step entirely.
		if (CONFIG.scout && !workspaceLooksEmpty(state.cwd)) {
			state.scoutStatus = "pending";
			persistState();
			const outcome = await runScout(ctx);
			applyScoutOutcome(outcome, ctx);
			// A concurrent /engineer stop may have marked the run stopped while
			// scouting; do not dispatch iteration 1 on a stopped run.
			if (state.status !== "running") return;
		}
		triggerEngineering(ctx);
	};

	// ---------------------------------------------------------------------------
	// v1.3 engineering plan tools (owned by this extension; the isolated
	// engineering-verifier agent does NOT receive them — its strict tool
	// allowlist excludes them and the capability ceiling intersects them
	// away). All mutations require an active (running) engineering run.
	// ---------------------------------------------------------------------------

	const requireActiveRun = (): { ok: boolean; message?: string } => {
		if (!state) return { ok: false, message: "No active engineering run." };
		if (state.status !== "running") {
			return { ok: false, message: `Engineering run is not active (status: ${state.status}).` };
		}
		return { ok: true };
	};

	const findTask = (taskId: string): EngineeringTask | undefined =>
		state?.plan?.tasks.find((t) => t.id === taskId);

	const toolResult = (text: string, details: Record<string, unknown> = {}) => ({
		content: [{ type: "text", text }],
		details: { ...details, ok: !details.error },
	});

	const toolError = (text: string, details: Record<string, unknown> = {}) =>
		toolResult(text, { ...details, error: text });

	const planSummary = (plan: EngineeringPlan, currentTaskId: string | null): string => {
		const completed = plan.tasks.filter((t) => t.status === "completed").length;
		const current = plan.tasks.find((t) => t.id === currentTaskId && t.status === "in_progress");
		const lines = [`Plan: ${completed}/${plan.tasks.length} completed`];
		if (current) lines.push(`Current task: ${current.id} — ${current.title}`);
		for (const t of plan.tasks) {
			const detail = t.status === "completed" && t.evidence ? ` — ${truncateForNotify(t.evidence, 120)}` : "";
			lines.push(`${TASK_MARKERS[t.status]} ${t.id} ${t.title}${detail}`);
		}
		return lines.join("\n");
	};

	const touchPlan = (): void => {
		if (state?.plan) state.plan.updatedAt = new Date().toISOString();
		persistState();
	};

	pi.registerTool({
		name: "engineer_plan_create",
		label: "Engineer Plan Create",
		description:
			"Create the initial structured engineering plan for the current engineering loop run. Requires an active run and no existing plan. Tasks get stable ids T1..Tn and start as pending.",
		promptSnippet: "Create the initial structured engineering plan (one-time)",
		promptGuidelines: [
			"Use engineer_plan_create once at the start of a goal when no plan exists, after inspecting the repository.",
		],
		parameters: Type.Object({
			tasks: Type.Array(
				Type.Object({
					title: Type.String({ description: "Concise task title" }),
					description: Type.Optional(Type.String({ description: "Optional task description" })),
				}),
				{ minItems: 1 },
			),
		}),
		async execute(_toolCallId, params) {
			const active = requireActiveRun();
			if (!active.ok) return toolError(active.message ?? "not active");
			if (!state) return toolError("No active engineering run.");
			if (state.plan) {
				return toolError("A plan already exists. Read it with engineer_plan_read; deleting/replacing a plan is not supported.");
			}
			const raw = Array.isArray(params.tasks) ? params.tasks : [];
			if (raw.length === 0) return toolError("Empty plan: provide at least one task.");
			if (raw.length > MAX_PLAN_TASKS) {
				return toolError(`Plan too large: ${raw.length} tasks exceeds the maximum of ${MAX_PLAN_TASKS}.`);
			}
			const tasks: EngineeringTask[] = raw.map((t, i) => ({
				id: `T${i + 1}`,
				title: String(t.title ?? "").trim(),
				...(String(t.description ?? "").trim() ? { description: String(t.description).trim() } : {}),
				status: "pending",
			}));
			if (tasks.some((t) => !t.title)) {
				return toolError("Each task requires a non-empty title.");
			}
			const now = new Date().toISOString();
			state.plan = { version: 1, createdAt: now, updatedAt: now, tasks };
			state.currentTaskId = null;
			persistState();
			return toolResult(
				`Created engineering plan with ${tasks.length} task(s) (${tasks[0].id}..${tasks[tasks.length - 1].id}). All pending.`,
				{ plan: state.plan, tasks: tasks.length },
			);
		},
	});

	pi.registerTool({
		name: "engineer_plan_read",
		label: "Engineer Plan Read",
		description:
			"Read the current structured engineering plan: progress count, current task, ordered tasks with status, and concise evidence where available. Non-destructive.",
		promptSnippet: "Read the current engineering plan",
		promptGuidelines: ["Use engineer_plan_read before deciding the next task."],
		parameters: Type.Object({}),
		async execute() {
			if (!state) return toolError("No engineering run.", { phase: "none" });
			if (!state.plan) return toolResult("No engineering plan yet.", { plan: null, tasks: [] });
			return toolResult(planSummary(state.plan, state.currentTaskId), {
				plan: state.plan,
				currentTaskId: state.currentTaskId,
				progress: {
					completed: state.plan.tasks.filter((t) => t.status === "completed").length,
					total: state.plan.tasks.length,
				},
			});
		},
	});

	pi.registerTool({
		name: "engineer_task_start",
		label: "Engineer Task Start",
		description:
			"Start an engineering plan task by id (e.g. T3). Only one task may be in_progress; starting another returns it to pending. Completed tasks must be reopened first; blocked tasks must be explicitly handled.",
		promptSnippet: "Start an engineering plan task",
		promptGuidelines: [
			"Use engineer_task_start before working on a task, and engineer_task_complete only with real evidence.",
		],
		parameters: Type.Object({
			taskId: Type.String({ description: "Task id such as T1" }),
		}),
		async execute(_toolCallId, params) {
			const active = requireActiveRun();
			if (!active.ok) return toolError(active.message ?? "not active");
			if (!state?.plan) return toolError("No engineering plan yet — create one with engineer_plan_create.");
			const task = findTask(params.taskId);
			if (!task) return toolError(`Unknown task ${params.taskId}.`);
			if (task.status === "completed") {
				return toolError(`Task ${task.id} is completed and cannot be restarted; reopen it with engineer_task_reopen.`);
			}
			if (task.status === "blocked") {
				return toolError(`Task ${task.id} is blocked; handle the block explicitly (engineer_task_reopen after resolving it) before starting.`);
			}
			const demoted: string[] = [];
			for (const t of state.plan.tasks) {
				if (t.id !== task.id && t.status === "in_progress") {
					t.status = "pending";
					demoted.push(t.id);
				}
			}
			task.status = "in_progress";
			state.currentTaskId = task.id;
			touchPlan();
			return toolResult(
				`Started ${task.id} — ${task.title}.${demoted.length ? ` ${demoted.join(", ")} returned to pending.` : ""}`,
				{ taskId: task.id, demoted },
			);
		},
	});

	pi.registerTool({
		name: "engineer_task_complete",
		label: "Engineer Task Complete",
		description:
			"Mark an in-progress engineering plan task completed with concise evidence (e.g. tests passed, file created, behavior verified, build succeeded).",
		promptSnippet: "Complete an engineering plan task with evidence",
		promptGuidelines: [
			"Use engineer_task_complete only when a task is genuinely verified with concrete evidence.",
		],
		parameters: Type.Object({
			taskId: Type.String({ description: "Task id such as T1" }),
			evidence: Type.String({ description: "Concise completion evidence" }),
		}),
		async execute(_toolCallId, params) {
			const active = requireActiveRun();
			if (!active.ok) return toolError(active.message ?? "not active");
			if (!state?.plan) return toolError("No engineering plan yet.");
			const task = findTask(params.taskId);
			if (!task) return toolError(`Unknown task ${params.taskId}.`);
			if (task.status === "completed") {
				return toolError(`Task ${task.id} is already completed; reopen it if it was wrong.`);
			}
			const evidence = String(params.evidence ?? "").trim();
			if (!evidence) return toolError("Evidence is required to complete a task.");
			task.status = "completed";
			task.evidence =
				evidence.length > MAX_EVIDENCE_LENGTH ? evidence.slice(0, MAX_EVIDENCE_LENGTH) + "…" : evidence;
			if (state.currentTaskId === task.id) state.currentTaskId = null;
			touchPlan();
			return toolResult(`Completed ${task.id} — ${task.title}.`, { taskId: task.id, evidence: task.evidence });
		},
	});

	pi.registerTool({
		name: "engineer_task_block",
		label: "Engineer Task Block",
		description:
			"Mark an engineering plan task as blocked with a meaningful reason. A blocked task prevents completion until resolved.",
		promptSnippet: "Block an engineering plan task with a reason",
		parameters: Type.Object({
			taskId: Type.String({ description: "Task id such as T1" }),
			reason: Type.String({ description: "Why the task is blocked" }),
		}),
		async execute(_toolCallId, params) {
			const active = requireActiveRun();
			if (!active.ok) return toolError(active.message ?? "not active");
			if (!state?.plan) return toolError("No engineering plan yet.");
			const task = findTask(params.taskId);
			if (!task) return toolError(`Unknown task ${params.taskId}.`);
			const reason = String(params.reason ?? "").trim();
			if (!reason) return toolError("A meaningful reason is required to block a task.");
			task.status = "blocked";
			task.notes = reason.length > MAX_REASON_LENGTH ? reason.slice(0, MAX_REASON_LENGTH) + "…" : reason;
			if (state.currentTaskId === task.id) state.currentTaskId = null;
			touchPlan();
			return toolResult(`Blocked ${task.id} — ${task.title}.`, { taskId: task.id, reason: task.notes });
		},
	});

	pi.registerTool({
		name: "engineer_task_reopen",
		label: "Engineer Task Reopen",
		description:
			"Reopen a completed or blocked engineering plan task back to pending. Requires a reason. Prior completion evidence moves into notes.",
		promptSnippet: "Reopen a completed/blocked engineering plan task as pending",
		parameters: Type.Object({
			taskId: Type.String({ description: "Task id such as T1" }),
			reason: Type.String({ description: "Why the task is being reopened" }),
		}),
		async execute(_toolCallId, params) {
			const active = requireActiveRun();
			if (!active.ok) return toolError(active.message ?? "not active");
			if (!state?.plan) return toolError("No engineering plan yet.");
			const task = findTask(params.taskId);
			if (!task) return toolError(`Unknown task ${params.taskId}.`);
			if (task.status === "pending" || task.status === "in_progress") {
				return toolError(`Task ${task.id} is ${task.status}; only completed or blocked tasks can be reopened.`);
			}
			const reason = String(params.reason ?? "").trim();
			if (!reason) return toolError("A reason is required to reopen a task.");
			const notesParts: string[] = [];
			if (task.notes) notesParts.push(task.notes);
			if (task.evidence) notesParts.push(`Prior evidence: ${task.evidence}`);
			notesParts.push(`Reopened: ${reason}`);
			task.notes = notesParts.join("\n");
			task.evidence = undefined;
			task.status = "pending";
			if (state.currentTaskId === task.id) state.currentTaskId = null;
			touchPlan();
			return toolResult(`Reopened ${task.id} — ${task.title} as pending.`, { taskId: task.id });
		},
	});

	const showConfig = (ctx: ExtensionContext): void => {
		const c = CONFIG;
		const lines = [
			"Engineering Loop config",
			"",
			`Max iterations: ${c.maxIterations}`,
			`Verification attempts: ${c.maxVerificationAttempts}`,
			`Scout: ${c.scout ? "enabled" : "disabled"}`,
			`Verifier: ${c.verifier ? "enabled" : "disabled"}`,
			`Scout timeout: ${Math.round(c.scoutTimeoutMs / 1000)}s`,
			`Verifier timeout: ${Math.round(c.verifierTimeoutMs / 1000)}s`,
			`Checkpoint per-file cap: ${c.checkpointPerFileLimitMiB} MiB`,
			`Checkpoint total cap: ${c.checkpointTotalLimitMiB} MiB`,
			"",
			"Config:",
			c.sourcePath,
		];
		if (c.malformed) lines.push("", "NOTE: config file was malformed — safe defaults are in effect.");
		ctx.ui.notify(lines.join("\n"), c.malformed ? "warning" : "info");
	};

	const showHelp = (ctx: ExtensionContext): void => {
		ctx.ui.notify(
			[
				"/engineer <goal>                      Start a new engineering run",
				"/engineer --test-failure <goal>      TEST-ONLY: start + arm a verifier-only sentinel criterion",
				"/engineer status                     Run summary (plan, changes, recovery)",
				"/engineer plan                       Show the full structured plan",
				"/engineer scout                      Show the saved Scout report",
				"/engineer changes                    Show created/modified/deleted files",
				"/engineer checkpoint                 Create a LATEST_SAFE recovery snapshot",
				"/engineer checkpoints                List recovery snapshots",
				"/engineer rollback                   Preview rollback to LATEST_SAFE",
				"/engineer rollback baseline          Preview rollback to RUN_BASELINE",
				"/engineer stop                       Stop the loop",
				"/engineer resume                     Resume a stopped run",
				"/engineer config                     Show effective configuration",
				"/engineer help                       This help",
				"",
				"Rollback requires a preview and an explicit `/engineer rollback [baseline] confirm`.",
			].join("\n"),
			"info",
		);
	};

	const showPlan = (ctx: ExtensionContext): void => {
		if (!state) {
			ctx.ui.notify("No engineering run active", "info");
			return;
		}
		if (!state.plan) {
			ctx.ui.notify("No engineering plan yet", "info");
			return;
		}
		ctx.ui.notify(
			[
				planSummary(state.plan, state.currentTaskId),
				"",
				...(state.plan.tasks
					.filter((t) => t.status === "blocked")
					.map((t) => [`Blocked: ${t.id} — ${t.title}`, t.notes ? `Reason: ${t.notes}` : ""].join("\n"))),
			].join("\n"),
			"info",
		);
	};

	const showScout = (ctx: ExtensionContext): void => {
		if (!state) {
			ctx.ui.notify("No engineering run active", "info");
			return;
		}
		if (!state.scoutReport) {
			ctx.ui.notify(
				state.scoutStatus === "failed"
					? `No Scout report — ${state.scoutError ?? "scout failed"}`
					: "No Scout report",
				"info",
			);
			return;
		}
		const r = state.scoutReport;
		ctx.ui.notify(
			[
				`Scout: completed`,
				`Summary: ${r.summary}`,
				`Architecture: ${r.architecture}`,
				"",
				...r.relevantFiles.map((f) => `- ${f.path} — ${f.reason}`),
				...(r.tests.locations.length || r.tests.commands.length
					? ["", `Tests (locations): ${r.tests.locations.join(", ") || "?"}`, `Tests (commands): ${r.tests.commands.join(", ") || "?"}`]
					: []),
				...(r.conventions.length ? ["", `Conventions: ${r.conventions.join("; ")}`] : []),
				...(r.risks.length ? ["", `Risks: ${r.risks.join("; ")}`] : []),
				...(r.unknowns.length ? ["", `Unknowns: ${r.unknowns.join("; ")}`] : []),
				...(r.recommendedInspection.length
					? ["", `Recommended inspection: ${r.recommendedInspection.join("; ")}`]
					: []),
			].join("\n"),
			"info",
		);
	};

	const showChanges = (ctx: ExtensionContext): void => {
		if (!state) {
			ctx.ui.notify("No engineering run active", "info");
			return;
		}
		refreshChangeManifest(ctx, false);
		if (!state.baseline) {
			ctx.ui.notify("Change tracking: none (no baseline)", "info");
			return;
		}
		const pre =
			state.baseline.trackedModified.length +
			state.baseline.trackedDeleted.length +
			state.baseline.untracked.length;
		ctx.ui.notify(
			[
				"Engineering changes",
				"",
				...formatChangeList(state.changes.created, "Created"),
				"",
				...formatChangeList(state.changes.modified, "Modified"),
				"",
				...formatChangeList(state.changes.deleted, "Deleted"),
				"",
				`Pre-existing workspace changes: ${pre}`,
				`Change tracking: ${state.changeTrackingPartial ? "partial" : "full"}`,
				"",
				"The manifest lists files that changed after the run started; it is not line-level authorship attribution.",
			].join("\n"),
			"info",
		);
	};

	// ---------------------------------------------------------------------------
	// v1.6 recoverable checkpoints + safe rollback (user-initiated only; no
	// model-facing rollback tool, no git mutation).
	// ---------------------------------------------------------------------------

	// Stable filesystem-safe run id for checkpoint storage (derived from the
	// persisted startedAt, so it survives reload/restart).
	const runId = (): string => String(state?.startedAt ?? 0);

	const createCheckpointCmd = (ctx: ExtensionContext): void => {
		if (!state) {
			ctx.ui.notify("No engineering run active", "warning");
			return;
		}
		if (state.status !== "running") {
			ctx.ui.notify(`Engineering run is ${state.status} — checkpoints require an active run`, "warning");
			return;
		}
		if (!state.baseline) {
			ctx.ui.notify("Checkpoint tracking requires the v1.5 baseline, which is unavailable for this run.", "warning");
			return;
		}
		refreshChangeManifest(ctx, true);
		const runIdKey = runId();
		const meta = captureCheckpoint({
			cwd: state.cwd,
			runId: runIdKey,
			type: "latest_safe",
			limits: checkpointLimits(),
			payload: {
				plan: state.plan,
				currentTaskId: state.currentTaskId,
				iteration: state.iteration,
				activeIteration: state.activeIteration,
				changeSummary: state.changes,
			},
		});
		if (!meta) {
			ctx.ui.notify("Checkpoint capture failed (disabled or workspace unreadable).", "error");
			return;
		}
		state.checkpointRunId = runIdKey;
		state.latestSafeAt = meta.createdAt;
		persistState();
		const completed = state.plan ? state.plan.tasks.filter((t) => t.status === "completed").length : 0;
		const lines = [
			"Checkpoint created",
			`Plan: ${state.plan ? `${completed}/${state.plan.tasks.length} completed` : "no plan yet"}`,
			`Files tracked: ${Object.keys(meta.files).length}`,
			`Rollback coverage: ${meta.coverage}`,
		];
		if (meta.coverage === "partial") {
			lines.push("", "WARNING: snapshot is partial —", ...meta.coverageWarnings.slice(0, 5));
			if (meta.coverageWarnings.length > 5) lines.push(`  …and ${meta.coverageWarnings.length - 5} more`);
		}
		ctx.ui.notify(lines.join("\n"), meta.coverage === "partial" ? "warning" : "info");
	};

	const showCheckpointsCmd = (ctx: ExtensionContext, clean: boolean): void => {
		if (!state) {
			ctx.ui.notify("No engineering run active", "info");
			return;
		}
		const runIdKey = state.checkpointRunId ?? runId();
		if (clean) {
			cleanCheckpoints(runIdKey);
			state.checkpointRunId = null;
			state.latestSafeAt = null;
			state.rollbackCoverage = null;
			state.rollbackWarnings = undefined;
			persistState();
			ctx.ui.notify("Checkpoints cleaned for this run.", "info");
			return;
		}
		const { baseline, safe } = listCheckpoints(runIdKey);
		const lines = ["Checkpoints"];
		if (baseline) {
			lines.push("", "RUN_BASELINE", `  Created: ${baseline.createdAt}`, `  Coverage: ${baseline.coverage}`, `  Files: ${Object.keys(baseline.files).length}`);
		} else {
			lines.push("", "RUN_BASELINE: none");
		}
		if (safe) {
			const payload = safe.payload as { plan?: unknown } | undefined;
			lines.push(
				"",
				"LATEST_SAFE",
				`  Created: ${safe.createdAt}`,
				`  Coverage: ${safe.coverage}`,
				`  Files: ${Object.keys(safe.files).length}${payload?.plan ? " (plan snapshot)" : ""}`,
			);
		} else {
			lines.push("", "LATEST_SAFE: none");
		}
		ctx.ui.notify(lines.join("\n"), "info");
	};

	// /engineer rollback [baseline] [confirm] — preview first; only `confirm`
	// executes. Cancels any active scout/verifier first, then applies the plan
	// only when there are no conflicts (never overwriting external divergence).
	const rollbackCmd = (ctx: ExtensionContext, target: CheckpointType, confirmed: boolean): void => {
		if (!state) {
			ctx.ui.notify("No engineering run active", "warning");
			return;
		}
		const runIdKey = state.checkpointRunId ?? runId();
		const targetName = target === "latest_safe" ? "LATEST_SAFE" : "RUN_BASELINE";
		const meta = readCheckpoint(runIdKey, target);
		if (!meta) {
			if (target === "latest_safe") {
				ctx.ui.notify(
					"No LATEST_SAFE checkpoint exists. Create one with /engineer checkpoint, or run /engineer rollback baseline.",
					"warning",
				);
			} else {
				ctx.ui.notify("No RUN_BASELINE checkpoint exists (tracking may be disabled for this run).", "warning");
			}
			return;
		}
		// Rollback is user-initiated and destructive; the CONFIRMED execution
		// path below stops autonomous scheduling (aborts a running engineer
		// turn and cancels child agents) instead of refusing (spec v1.6 §16).
		refreshChangeManifest(ctx, true);
		const plan = planRollback({ cwd: state.cwd, runId: runIdKey, target, manifest: state.changes });
		if (plan.conflicts.length > 0) {
			ctx.ui.notify(
				`Rollback blocked by conflicts:\n${plan.conflicts.map((c) => `  ${c.path} — ${c.reason}`).join("\n")}`,
				"error",
			);
			return;
		}
		if (!confirmed) {
			const lines = [
				"Rollback preview",
				`Target: ${targetName}`,
				`Files to restore: ${plan.modified}`,
				`Files to remove: ${plan.created}`,
				`Files to recreate: ${plan.deleted}`,
				"Pre-existing user baseline is protected.",
			];
			if (target === "latest_safe") {
				lines.push(
					"",
					"Files changed after this checkpoint may include edits made outside Engineering Loop. Authorship cannot be determined. Review the rollback paths before confirming.",
				);
			}
			if (plan.preserved.length > 0) {
				lines.push("", `Preserved (unknown post-checkpoint files, outside tracked scope): ${plan.preserved.slice(0, 8).join(", ")}${plan.preserved.length > 8 ? ` (+${plan.preserved.length - 8} more)` : ""}`);
			}
			if (plan.coverage === "partial") lines.push("WARNING: checkpoint coverage is partial.");
			lines.push("", `Run:\n/engineer rollback${target === "run_baseline" ? " baseline" : ""} confirm`);
			ctx.ui.notify(lines.join("\n"), "warning");
			return;
		}
		// Execute: stop scheduling, cancel child agents, invalidate stale
		// identities so late delegation responses are ignored.
		try {
			ctx.abort?.();
		} catch {
			// best effort: the agent turn may already be idle
		}
		cancelActiveScout();
		cancelActiveVerification();
		inFlightPhase = null;
		if (plan.actions.length > 0) {
			const result = executeRollback({ cwd: state.cwd, runId: runIdKey, target, plan });
			if (!result.ok) {
				ctx.ui.notify(
					`Rollback FAILED (conflicts/errors prevented); nothing destructive was applied:\n${result.errors.slice(0, 8).join("\n")}`,
				"error",
				);
				return;
			}
		}
		// Post-rollback state.
		if (target === "latest_safe") {
			const payload = meta.payload as
				| { plan?: unknown; currentTaskId?: string | null; iteration?: number; activeIteration?: number }
				| undefined;
			const restoredPlan = payload?.plan ? restorePlan(payload.plan) : null;
			state.plan = restoredPlan;
			state.currentTaskId =
				restoredPlan &&
				typeof payload?.currentTaskId === "string" &&
				restoredPlan.tasks.some((t) => t.id === payload.currentTaskId)
					? payload.currentTaskId
					: null;
			if (typeof payload?.iteration === "number") state.iteration = payload.iteration;
			if (typeof payload?.activeIteration === "number") state.activeIteration = payload.activeIteration;
		} else {
			state.plan = null;
			state.currentTaskId = null;
			state.testCriterion = null; // terminal cleanup
		}
		state.needsReplan = false;
		state.phase = "engineering";
		state.status = "stopped";
		state.lastAction = `rolled back to ${targetName}`;
		refreshChangeManifest(ctx, true);
		disposeCapCeiling();
		persistState();
		ctx.ui.notify(
			plan.actions.length === 0
				? `Rollback to ${targetName} (no changes needed) — run stopped. Run /engineer resume to continue.`
				: `Rollback to ${targetName} complete — restored ${plan.modified}, removed ${plan.created}, recreated ${plan.deleted}.\nThe run is stopped. Inspect the workspace, then run /engineer resume to continue.`,
			"warning",
		);
	};

	pi.registerCommand("engineer", {
		description:
			"Bounded autonomous engineering loop: /engineer [--test-failure] <goal> | config | help | status | plan | scout | changes | checkpoint(s) | rollback [baseline] [confirm] | stop | resume",
		handler: async (args, ctx) => {
			const arg = args.trim();
			if (!arg) {
				ctx.ui.notify(
					"Usage: /engineer <goal> | config | help | status | plan | scout | changes | checkpoint | checkpoints [clean] | rollback [baseline] [confirm] | stop | resume",
					"warning",
				);
				return;
			}
			try {
				const lower = arg.toLowerCase();
				if (lower === "status") return showStatus(ctx);
				if (lower === "plan") return showPlan(ctx);
				if (lower === "scout") return showScout(ctx);
				if (lower === "changes") return showChanges(ctx);
				if (lower === "stop") return stopLoop(ctx);
				if (lower === "resume") return resumeLoop(ctx);
				if (lower === "config") return showConfig(ctx);
				if (lower === "help") return showHelp(ctx);
				if (lower === "checkpoint") return createCheckpointCmd(ctx);
				if (lower === "checkpoints") return showCheckpointsCmd(ctx, false);
				if (lower === "checkpoints clean") return showCheckpointsCmd(ctx, true);
				if (lower === "rollback" || lower === "rollback confirm") {
					return rollbackCmd(ctx, "latest_safe", lower === "rollback confirm");
				}
				if (lower === "rollback baseline" || lower === "rollback baseline confirm") {
					return rollbackCmd(ctx, "run_baseline", lower === "rollback baseline confirm");
				}
				// TEST-ONLY: atomic start-and-criterion. The flag is parsed only
				// when starting a NEW run; plain /engineer <goal> is unchanged
				// and never arms the criterion.
				if (lower === "--test-failure" || lower.startsWith("--test-failure ")) {
					const goal = arg.slice("--test-failure".length).trim();
					if (!goal) {
						ctx.ui.notify("Usage: /engineer --test-failure <goal>", "warning");
						return;
					}
					return startLoop(goal, ctx, {
						testCriterion: { file: TEST_CRITERION_FILE, content: TEST_CRITERION_CONTENT },
					});
				}
				return startLoop(arg, ctx);
			} catch (error) {
				inFlightPhase = null;
				cancelActiveVerification();
				cancelActiveScout();
				disposeCapCeiling();
				if (state) {
					state.status = "stopped";
					state.lastAction = `error: ${error instanceof Error ? error.message : String(error)}`;
					state.testCriterion = null; // TEST-ONLY: never outlive a terminated run.
					persistState();
				}
				ctx.ui.notify(
					`Engineering loop command failed: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});
}
