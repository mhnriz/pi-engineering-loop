/**
 * engineering-loop → pi-subagents delegation helper (v1.2).
 *
 * This module owns ALL direct interaction with the installed `pi-subagents`
 * package so the main extension file stays a pure state machine.
 *
 * TECHNICAL DEBT (v1.2): pi installs npm packages into its managed npm
 * directory (`<agentDir>/npm/node_modules`, agentDir = `$PI_CODING_AGENT_DIR`
 * or `~/.pi/agent`). A bare `import ... from "pi-subagents/delegation"` does
 * NOT resolve from this extension's arbitrary location under the current
 * jiti/loader setup (verified during v1.2 inspection). We therefore resolve
 * the installed package at runtime and dynamically import its public API
 * files (`src/api/delegation.ts` and `src/api/capability-ceiling.ts`, both
 * public entries in the package's exports map). Replace this resolution with
 * portable package resolution (e.g. a loader-provided package path) when Pi
 * exposes one.
 *
 * Only public API files are imported — never private internals.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { EngineeringChangeManifest } from "./workspace.ts";

/** Actionable message shown when the pi-subagents prerequisite is missing. */
export const DEPENDENCY_MISSING_MSG =
	"Engineering Loop requires pi-subagents. Install with: pi install npm:pi-subagents";

// Informs whether the pi-subagents delegation API is currently resolvable.
export function isSubagentsDependencyAvailable(): boolean {
	return resolveSubagentsPackageDir() !== null;
}

export const VERIFIER_AGENT = "engineering-verifier";
export const VERIFIER_NODE_ID = "verification";
// TEST-ONLY override hook so the smoke tests can exercise the deadline path
// without waiting 10 minutes.
export const VERIFIER_TIMEOUT_MS: number =
	Number(process.env.ENGINEERING_LOOP_VERIFIER_TIMEOUT_MS) || 600_000;
// TEST-ONLY override hook for the deadline backstop in the smoke tests.
export const VERIFIER_DEADLINE_GRACE_MS: number =
	Number(process.env.ENGINEERING_LOOP_VERIFIER_GRACE_MS) || 30_000;

// v1.4 isolated repository scouting.
// TEST-ONLY override hooks so the smoke tests can exercise scout paths quickly.
export const SCOUT_AGENT = "engineering-scout";
export const SCOUT_NODE_ID = "scout";
export const SCOUT_TIMEOUT_MS: number =
	Number(process.env.ENGINEERING_LOOP_SCOUT_TIMEOUT_MS) || 600_000;
export const SCOUT_DEADLINE_GRACE_MS: number =
	Number(process.env.ENGINEERING_LOOP_SCOUT_GRACE_MS) || 30_000;

/** Verifier tool allowlist — deliberately excludes write/edit. */
export const VERIFIER_ALLOWED_TOOLS = ["read", "grep", "find", "ls", "bash"];

/** Structured result contract: both fields required, verdict enum enforced. */
export const VERIFIER_SCHEMA = {
	type: "object",
	properties: {
		verdict: { type: "string", enum: ["pass", "fail"] },
		findings: { type: "string" },
	},
	required: ["verdict", "findings"],
	additionalProperties: false,
};

// --- v1.4 scouting ----------------------------------------------------------

/** Structural subset of the scout structured report (runtime values only). */
export interface ScoutReport {
	summary: string;
	architecture: string;
	relevantFiles: Array<{ path: string; reason: string }>;
	tests: { locations: string[]; commands: string[] };
	conventions: string[];
	risks: string[];
	unknowns: string[];
	recommendedInspection: string[];
}

/** v1.5: compact run-change context handed to the verifier (audit aid only). */
export interface VerifierChangeContext {
	changes: EngineeringChangeManifest;
	preExistingCount: number;
	partial: boolean;
	warnings: string[];
}

/** JSON Schema for the scout structured report. Array sizes are capped so the
 * persisted + injected report stays compact. */
export const SCOUT_SCHEMA = {
	type: "object",
	properties: {
		summary: { type: "string", maxLength: 2000 },
		architecture: { type: "string", maxLength: 4000 },
		relevantFiles: {
			type: "array",
			maxItems: 15,
			items: {
				type: "object",
				properties: {
					path: { type: "string", maxLength: 1000 },
					reason: { type: "string", maxLength: 1000 },
				},
				required: ["path", "reason"],
				additionalProperties: false,
			},
		},
		tests: {
			type: "object",
			properties: {
				locations: { type: "array", maxItems: 10, items: { type: "string", maxLength: 1000 } },
				commands: { type: "array", maxItems: 10, items: { type: "string", maxLength: 1000 } },
			},
			required: ["locations", "commands"],
			additionalProperties: false,
		},
		conventions: { type: "array", maxItems: 15, items: { type: "string", maxLength: 1000 } },
		risks: { type: "array", maxItems: 10, items: { type: "string", maxLength: 1000 } },
		unknowns: { type: "array", maxItems: 10, items: { type: "string", maxLength: 1000 } },
		recommendedInspection: { type: "array", maxItems: 10, items: { type: "string", maxLength: 1000 } },
	},
	required: [
		"summary",
		"architecture",
		"relevantFiles",
		"tests",
		"conventions",
		"risks",
		"unknowns",
		"recommendedInspection",
	],
	additionalProperties: false,
};

/**
 * The scout task: ORIGINAL GOAL + repository-reconnaissance contract, sent to
 * a fresh-context subagent. Scouting is an optimization — never a correctness
 * gate — and never consumes an engineering iteration.
 */
export function buildScoutTask(goal: string, cwd: string): string {
	return [
		"You are engineering-scout for the engineering-loop.",
		"",
		"You do NOT implement, plan, or edit anything. Your only job is concise, evidence-backed reconnaissance of the given repository relative to the ORIGINAL GOAL.",
		"",
		"WORKSPACE:",
		cwd,
		"",
		"ORIGINAL GOAL:",
		goal,
		"",
		"Rules:",
		"1. Inspect the repository structure, architecture, and key entry points.",
		"2. Reason from the ORIGINAL GOAL; prioritize files/directories actually relevant to it. Never dump huge file lists.",
		"3. Locate tests and the likely test/build/lint/typecheck commands.",
		"4. Identify project conventions (language, style, module system, framework, layout).",
		"5. Identify likely change surfaces.",
		"6. Identify risks and unknowns; label speculation as such.",
		"7. Do NOT propose a detailed implementation plan, a task list, or a completion judgment.",
		"8. Do NOT modify or write any files.",
		"9. Keep findings concise and evidence-backed (paths, line refs).",
		"10. Finish by calling the structured_output tool with your report matching the provided schema.",
		"",
		"The workspace is the source of truth. When in doubt, say so in unknowns.",
	].join("\n");
}

/** Structural subset of pi-subagents/delegation exports (runtime values only). */
export interface DelegationApi {
	SUBAGENT_DELEGATION_REQUEST_EVENT: string;
	SUBAGENT_DELEGATION_RESPONSE_EVENT: string;
	SUBAGENT_DELEGATION_CANCEL_EVENT: string;
}

/** Structural subset of SubagentDelegationRequest (runtime values only). */
export interface VerifierRequest {
	requestId: string;
	ownerRunId: string;
	nodeId: string;
	agent: string;
	task: string;
	context: "fresh";
	cwd: string;
	thinking: "high";
	timeoutMs: number;
	result: { kind: "structured"; schema: typeof VERIFIER_SCHEMA };
}

/** Structural subset of SubagentDelegationResponse (runtime values only). */
export interface VerifierResponse {
	requestId: string;
	status: string;
	error?: string;
	result?: { kind: "structured"; value: unknown };
	usage?: unknown;
}

/** Structural subset of pi-subagents/capability-ceiling exports. */
export interface CapabilityCeilingApi {
	registerSubagentCapabilityCeiling(options: {
		sessionId: string;
		source: string;
		ceiling: {
			allowedAgents?: string[];
			allowedTools?: string[];
			denyExtensions?: boolean;
		};
	}): { update(ceiling: unknown): void; dispose(): void };
}

/**
 * Locates the installed pi-subagents package inside Pi's managed npm
 * directory. Honors $PI_CODING_AGENT_DIR (Pi's agent-dir env override).
 */
export function resolveSubagentsPackageDir(): string | null {
	const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	const candidates = [
		join(agentDir, "npm", "node_modules", "pi-subagents"),
		join(homedir(), ".pi", "npm", "node_modules", "pi-subagents"),
		join(homedir(), ".pi", "agent", "npm", "node_modules", "pi-subagents"),
	];
	for (const dir of candidates) {
		if (existsSync(join(dir, "src", "api", "delegation.ts"))) return dir;
	}
	return null;
}

let delegationApiPromise: Promise<DelegationApi> | null = null;

/** Loads the public delegation API module of the installed package (memoized). */
export function loadSubagentsDelegationApi(): Promise<DelegationApi> {
	if (!delegationApiPromise) {
		delegationApiPromise = (async () => {
			const pkgDir = resolveSubagentsPackageDir();
			if (!pkgDir) {
				throw new Error(DEPENDENCY_MISSING_MSG);
			}
			const url = pathToFileURL(join(pkgDir, "src", "api", "delegation.ts")).href;
			const mod = (await import(url)) as unknown as DelegationApi;
			if (
				typeof mod.SUBAGENT_DELEGATION_REQUEST_EVENT !== "string" ||
				typeof mod.SUBAGENT_DELEGATION_RESPONSE_EVENT !== "string" ||
				typeof mod.SUBAGENT_DELEGATION_CANCEL_EVENT !== "string"
			) {
				throw new Error("Unexpected pi-subagents delegation API shape");
			}
			return mod;
		})();
		// Allow a later retry if the first load fails transiently.
		delegationApiPromise.catch(() => {
			delegationApiPromise = null;
		});
	}
	return delegationApiPromise;
}

let capabilityCeilingApiPromise: Promise<CapabilityCeilingApi> | null = null;

/** Loads the public capability-ceiling API module of the installed package. */
export function loadSubagentsCapabilityCeiling(): Promise<CapabilityCeilingApi> {
	if (!capabilityCeilingApiPromise) {
		capabilityCeilingApiPromise = (async () => {
			const pkgDir = resolveSubagentsPackageDir();
			if (!pkgDir) {
				throw new Error(DEPENDENCY_MISSING_MSG);
			}
			const url = pathToFileURL(
				join(pkgDir, "src", "api", "capability-ceiling.ts"),
			).href;
			const mod = (await import(url)) as unknown as CapabilityCeilingApi;
			if (typeof mod.registerSubagentCapabilityCeiling !== "function") {
				throw new Error("Unexpected pi-subagents capability-ceiling API shape");
			}
			return mod;
		})();
		capabilityCeilingApiPromise.catch(() => {
			capabilityCeilingApiPromise = null;
		});
	}
	return capabilityCeilingApiPromise;
}

/**
 * The verifier task: the ORIGINAL GOAL plus the verification contract. Sent
 * to a fresh-context subagent, so the verifier never sees the engineer's
 * claims from the parent conversation.
 *
 * TEST-ONLY: when `testCriterion` is provided (only ever armed by
 * /engineer --test-failure), the criterion block is appended so the
 * isolated verifier enforces an extra acceptance condition that the
 * engineer never sees. The engineer only learns about it through the
 * verifier's findings after a FAIL.
 */
export function buildVerifierTask(
	goal: string,
	cwd: string,
	testCriterion?: { file: string; content: string } | null,
	changeContext?: VerifierChangeContext,
): string {
	const lines: string[] = [
		"You are the VERIFIER for an autonomous engineering loop.",
		"",
		"You did not implement this task.",
		"Your job is to independently determine whether the original goal is genuinely complete.",
		"",
		"WORKSPACE:",
		cwd,
		"",
		"ORIGINAL GOAL:",
		goal,
		"",
		"Rules:",
		"1. Inspect the actual current workspace before making any judgment.",
		"2. Do not trust the engineer's summary or claims — verify from source, tests, and runtime behavior.",
		"3. Determine what the original goal objectively requires.",
		"4. Inspect relevant files and changes.",
		"5. Run appropriate verification yourself: tests, build, lint, typecheck, targeted runtime checks where relevant (bash is available).",
		"6. Look for incomplete work, incorrect assumptions, broken behavior, missing requirements, regressions, or placeholder implementations.",
		"7. Detect tests that encode incorrect assumptions or pass for the wrong reasons.",
		"8. Never modify implementation files — this is a read-only verification.",
		"9. Base the verdict on evidence from the workspace: file paths, line numbers, command output.",
		"10. Finish by calling the structured_output tool with your verdict.",
		"",
		"The workspace is the source of truth.",
	];
	// TEST-ONLY: deterministic verifier-only acceptance injection. The
	// engineer never sees this block; it is only ever appended by the
	// extension when /engineer --test-failure armed the run.
	if (testCriterion) {
		lines.push(
			"",
			"TEST-ONLY VERIFICATION CRITERION:",
			"",
			"In addition to the original goal, the workspace must contain:",
			"",
			testCriterion.file,
			"",
			"with exact content:",
			"",
			testCriterion.content,
			"",
			"Treat absence or incorrect content as a verification failure.",
			"Include the required repair clearly in findings.",
		);
	}
	// v1.5: compact run-change context (audit aid only — never proof).
	if (changeContext) {
		const c = changeContext.changes;
		lines.push("", "FILES CHANGED DURING ENGINEERING RUN", "");
		lines.push("Created:", ...(c.created.length ? c.created.slice(0, 30).map((p) => `  ${p}`) : ["  none"]), "");
		lines.push("Modified:", ...(c.modified.length ? c.modified.slice(0, 30).map((p) => `  ${p}`) : ["  none"]), "");
		lines.push("Deleted:", ...(c.deleted.length ? c.deleted.slice(0, 30).map((p) => `  ${p}`) : ["  none"]), "");
		lines.push(
			`Pre-existing workspace changes: ${changeContext.preExistingCount}`,
			`Change tracking: ${changeContext.partial ? "partial" : "full"}`,
		);
		if (changeContext.warnings.length) {
			lines.push("", "SAFETY WARNINGS:", ...changeContext.warnings.map((w) => `- ${w}`));
		}
		lines.push(
			"",
			"Use this manifest only as additional audit context. Inspect the actual workspace independently. The manifest is not proof of authorship or correctness.",
		);
	}
	return lines.join("\n");
}
