/**
 * engineering-loop v1.7 — optional user configuration.
 *
 * Config file: <PI_CODING_AGENT_DIR|~/.pi/agent>/engineering-loop/config.json
 *
 * Every field is optional; safe defaults preserve v1.6 behavior. Unknown
 * fields are ignored; invalid types/ranges fall back to defaults with a
 * malformed flag so the /engineer config command can warn. Configuration
 * NEVER weakens core safety invariants (workspace confinement and explicit
 * rollback confirmation are hard-coded in the extension, not configurable).
 *
 * Config is read once when the extension loads; edit the file and run
 * /reload to apply changes.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_DIR_NAME = ".pi"; // Pi's config directory name (rebranding-neutral)

/** Pi's agent directory: honors $PI_CODING_AGENT_DIR, then ~/.pi/agent. */
export function resolveAgentDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	if (envDir) return join(envDir);
	return join(homedir(), CONFIG_DIR_NAME, "agent");
}

export function configPath(): string {
	return join(resolveAgentDir(), "engineering-loop", "config.json");
}

export interface EngineeringLoopConfig {
	maxIterations: number;
	maxVerificationAttempts: number;
	maxConsecutiveVerificationFailures: number;
	replanAfterFailures: number;
	scout: boolean;
	verifier: boolean;
	scoutTimeoutMs: number;
	verifierTimeoutMs: number;
	checkpointPerFileLimitMiB: number;
	checkpointTotalLimitMiB: number;
	/** Absolute path of the config file actually read (for /engineer config). */
	sourcePath: string;
	/** Set when the file exists but could not be parsed or validated. */
	malformed?: boolean;
}

const DEFAULTS: EngineeringLoopConfig = {
	maxIterations: 15,
	maxVerificationAttempts: 5,
	maxConsecutiveVerificationFailures: 4,
	replanAfterFailures: 2,
	scout: true,
	verifier: true,
	scoutTimeoutMs: 600_000,
	verifierTimeoutMs: 600_000,
	checkpointPerFileLimitMiB: 4,
	checkpointTotalLimitMiB: 100,
	sourcePath: "",
};

const clampInt = (v: unknown, min: number, max: number, def: number): number =>
	typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : def;

const clampBool = (v: unknown, def: boolean): boolean => (typeof v === "boolean" ? v : def);

const clampNum = (v: unknown, min: number, max: number, def: number): number =>
	typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : def;

export function loadConfig(): EngineeringLoopConfig {
	const path = configPath();
	const base: EngineeringLoopConfig = { ...DEFAULTS, sourcePath: path };
	let raw: unknown;
	try {
		if (!existsSync(path)) return base;
		raw = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return { ...base, malformed: true };
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
		return { ...base, malformed: true };
	}
	const obj = raw as Record<string, unknown>;
	return {
		...base,
		maxIterations: clampInt(obj.maxIterations, 1, 1000, DEFAULTS.maxIterations),
		maxVerificationAttempts: clampInt(obj.maxVerificationAttempts, 1, 100, DEFAULTS.maxVerificationAttempts),
		maxConsecutiveVerificationFailures: clampInt(obj.maxConsecutiveVerificationFailures, 1, 100, DEFAULTS.maxConsecutiveVerificationFailures),
		replanAfterFailures: clampInt(obj.replanAfterFailures, 1, 100, DEFAULTS.replanAfterFailures),
		scout: clampBool(obj.scout, DEFAULTS.scout),
		verifier: clampBool(obj.verifier, DEFAULTS.verifier),
		scoutTimeoutMs: clampNum(obj.scoutTimeoutMs, 1_000, 86_400_000, DEFAULTS.scoutTimeoutMs),
		verifierTimeoutMs: clampNum(obj.verifierTimeoutMs, 1_000, 86_400_000, DEFAULTS.verifierTimeoutMs),
		checkpointPerFileLimitMiB: clampNum(obj.checkpointPerFileLimitMiB, 0.25, 8, DEFAULTS.checkpointPerFileLimitMiB),
		checkpointTotalLimitMiB: clampNum(obj.checkpointTotalLimitMiB, 1, 10_000, DEFAULTS.checkpointTotalLimitMiB),
	};
}