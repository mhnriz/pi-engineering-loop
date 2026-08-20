/**
 * engineering-loop v1.6 — extension-owned recoverable checkpoints + safe rollback.
 *
 * Recovery is based on extension-owned snapshots stored OUTSIDE the project
 * workspace, under Pi's agent directory:
 *
 *   <agentDir>/engineering-loop/checkpoints/<run-id>/
 *     metadata.json
 *     baseline/     (RUN_BASELINE — captured automatically at run start)
 *     safe/         (LATEST_SAFE — captured on /engineer checkpoint)
 *
 * Each snapshot stores exact file bytes for every covered file (within caps).
 *
 * SAFETY RULES (never violated):
 * - Rollback NEVER uses `git reset --hard`, `git clean`, `git checkout .`, or
 *   `git restore .`. Git is informational only; recovery is byte-based.
 * - Files modified before the engineering run are restored to their exact
 *   pre-run checked-in/working bytes — NOT Git HEAD.
 * - Only paths inside the run's change manifest (attributed to the run) are
 *   ever touched; `.git/**`, ignored/generated dirs, and everything outside
 *   the workspace are never mutated.
 * - If a file diverges from every known checkpoint state and cannot be
 *   attributed to the run, rollback is a CONFLICT: it is reported and NOT
 *   overwritten (false-negative rollback preferred over destroying user edits).
 *
 * Symlinks are never followed (workspace-boundary safety).
 */
import { createHash } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { IGNORED_DIRS } from "./workspace.ts";

// TEST-ONLY overrides so smoke tests can isolate/pin the storage root.
const CHECKPOINT_DIR_ENV = "ENGINEERING_LOOP_CHECKPOINT_DIR";

export const CHECKPOINT_METADATA_VERSION = 1;
// Per-file snapshot cap (spec suggestion 2–5 MiB). TEST-ONLY env override for smoke tests.
export const PER_FILE_SNAPSHOT_MAX: number =
	Number(process.env.ENGINEERING_LOOP_SNAPSHOT_FILE_MAX) || 4 * 1024 * 1024;
// Total recovery snapshot cap. TEST-ONLY env override for smoke tests.
export const TOTAL_SNAPSHOT_MAX: number =
	Number(process.env.ENGINEERING_LOOP_SNAPSHOT_TOTAL_MAX) || 100 * 1024 * 1024;
/** Aligned with the v1.5 baseline file cap. */
export const MAX_CHECKPOINT_FILES = 4000;

export type CheckpointType = "run_baseline" | "latest_safe";

export interface CheckpointFileRecord {
	/** Workspace-relative path (forward slashes). */
	path: string;
	/** Whether the path existed (had content) at capture time. */
	existed: boolean;
	/** sha1 of the stored content. */
	hash?: string;
	size?: number;
	/** Basic file mode (e.g. 0o644) restored on rollback. */
	mode?: number;
}

export interface CheckpointMetadata {
	version: 1;
	runId: string;
	type: CheckpointType;
	createdAt: string;
	/** "full" only when every relevant file within caps was snapshotted. */
	coverage: "full" | "partial";
	/** Per-path reasons for non-captured files (large, capped, unreadable). */
	coverageWarnings: string[];
	/** Path -> record for every covered file. */
	files: Record<string, CheckpointFileRecord>;
	/** Opaque run-state payload (plan snapshot etc.); never contents. */
	payload?: unknown;
	totalBytes: number;
}

export interface RollbackAction {
	action: "restore" | "remove" | "recreate";
	path: string;
	reason: string;
}

export interface RollbackConflict {
	path: string;
	reason: string;
}

export interface RollbackPlan {
	target: CheckpointType;
	actions: RollbackAction[];
	conflicts: RollbackConflict[];
	coverage: "full" | "partial";
	created: number;
	modified: number;
	deleted: number;
	/** Post-checkpoint files that were preserved (NOT removed) because they are
	 * outside the run's tracked change scope. Shown in the preview for review. */
	preserved: string[];
}

/** File names that are likely secret-bearing (recovery keeps bytes; never echoes them). */
export const SENSITIVE_FILENAMES = [".env", ".env.local", ".npmrc", ".netrc", "credentials", "id_rsa", "id_ed25519", "*.pem", "*.key"];

/** Resolves the checkpoint storage root under Pi's agent directory. */
export function resolveCheckpointRoot(): string {
	const override = process.env[CHECKPOINT_DIR_ENV];
	if (override) return resolve(override);
	const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
	return join(agentDir, "engineering-loop", "checkpoints");
}

/** Stable, filesystem-safe run id derived from the engineering run identity. */
export const checkpointRunDirFor = (runId: string): string =>
	join(resolveCheckpointRoot(), runId.replace(/[^A-Za-z0-9._-]/g, "_"));

const safeRelative = (cwd: string, full: string): string | null => {
	const rel = relative(cwd, full).split(sep).join("/");
	if (!rel || rel.startsWith("..") || resolve(cwd, rel) !== resolve(full)) return null;
	for (const pre of [".git/", ...Array.from(IGNORED_DIRS, (d) => `${d}/`)]) {
		if (rel.startsWith(pre) || rel === pre.slice(0, -1)) return null;
	}
	return rel;
};

const hashOf = (buf: Buffer): string => createHash("sha1").update(buf).digest("hex");

interface ScanResult {
	files: Array<{ rel: string; full: string; content: Buffer; mode: number }>;
	warnings: string[];
	coverage: "full" | "partial";
	totalBytes: number;
}

/** Bounded workspace scan for snapshotting (same exclusions as v1.5 scan).
 * `limits` (optional) override the module defaults (config-driven). */
const scanForSnapshot = (cwd: string, limits?: { perFileBytes?: number; totalBytes?: number }): ScanResult => {
	const perFileMax = limits?.perFileBytes ?? PER_FILE_SNAPSHOT_MAX;
	const totalMax = limits?.totalBytes ?? TOTAL_SNAPSHOT_MAX;
	const files: ScanResult["files"] = [];
	const warnings: string[] = [];
	let totalBytes = 0;
	let count = 0;
	let coverage: "full" | "partial" = "full";
	const walk = (dir: string): void => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			coverage = "partial";
			warnings.push(`unreadable directory: ${relative(cwd, dir)}`);
			return;
		}
		entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		for (const e of entries) {
			if (count >= MAX_CHECKPOINT_FILES) {
				coverage = "partial";
				warnings.push(`file count cap (${MAX_CHECKPOINT_FILES}) reached`);
				return;
			}
			if (IGNORED_DIRS.has(e.name)) continue;
			const full = join(dir, e.name);
			if (e.isDirectory()) {
				walk(full);
				continue;
			}
			if (e.isSymbolicLink() || !e.isFile()) continue;
			const rel = safeRelative(cwd, full);
			if (!rel) {
				coverage = "partial";
				warnings.push(`skipped unsafe path: ${relative(cwd, full)}`);
				continue;
			}
			let st;
			try {
				st = statSync(full);
			} catch {
				coverage = "partial";
				warnings.push(`unreadable file: ${rel}`);
				continue;
			}
			if (st.size > perFileMax) {
				coverage = "partial";
				warnings.push(`${rel} (${st.size} bytes) exceeds per-file snapshot cap`);
				continue;
			}
			if (totalBytes + st.size > totalMax) {
				coverage = "partial";
				warnings.push(`total snapshot cap (${totalMax} bytes) reached at ${rel}`);
				return;
			}
			let content: Buffer;
			try {
				content = readFileSync(full);
			} catch {
				coverage = "partial";
				warnings.push(`unreadable file: ${rel}`);
				continue;
			}
			files.push({ rel, full, content, mode: st.mode & 0o777 });
			totalBytes += content.length;
			count++;
		}
	};
	walk(cwd);
	return { files, warnings, coverage, totalBytes };
};

type CheckpointStore = { run_baseline?: CheckpointMetadata; latest_safe?: CheckpointMetadata };

// One metadata.json per run dir holding BOTH checkpoint types (baseline/ and
// safe/ hold bytes). Writing one type merges without clobbering the other.
const writeMetadata = (runDir: string, meta: CheckpointMetadata): void => {
	const target = join(runDir, "metadata.json");
	mkdirSync(runDir, { recursive: true, mode: 0o700 });
	const store = readStore(runDir);
	store[meta.type] = meta;
	writeFileSync(target, JSON.stringify(store, null, 1), { mode: 0o600 });
};

const readStore = (runDir: string): CheckpointStore => {
	try {
		const parsed = JSON.parse(readFileSync(join(runDir, "metadata.json"), "utf8")) as CheckpointStore;
		if (parsed && typeof parsed === "object") return parsed;
	} catch {
		// no store yet
	}
	return {};
};

/**
 * Captures a snapshot of the current workspace into checkpoint storage.
 * `payload` is opaque run-state (e.g. plan snapshot for LATEST_SAFE).
 * Returns metadata (with coverage + warnings) or null when capture is disabled
 * (TEST-ONLY) or the workspace cannot be listed at all.
 */
export function captureCheckpoint(options: {
	cwd: string;
	runId: string;
	type: CheckpointType;
	payload?: unknown;
	limits?: { perFileBytes?: number; totalBytes?: number };
}): CheckpointMetadata | null {
	if (process.env.ENGINEERING_LOOP_CHECKPOINT_DISABLE === "1") return null;
	const scan = scanForSnapshot(options.cwd, options.limits);
	const runDir = checkpointRunDirFor(options.runId);
	const typeDir = join(runDir, options.type === "run_baseline" ? "baseline" : "safe");
	mkdirSync(typeDir, { recursive: true, mode: 0o700 });
	const files: Record<string, CheckpointFileRecord> = {};
	for (const f of scan.files) {
		const target = join(typeDir, ...f.rel.split("/"));
		mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
		writeFileSync(target, f.content, { mode: 0o600 });
		files[f.rel] = { path: f.rel, existed: true, hash: hashOf(f.content), size: f.content.length, mode: f.mode };
	}
	const meta: CheckpointMetadata = {
		version: CHECKPOINT_METADATA_VERSION,
		runId: options.runId,
		type: options.type,
		createdAt: new Date().toISOString(),
		coverage: scan.coverage,
		coverageWarnings: scan.warnings,
		files,
		...(options.payload !== undefined ? { payload: options.payload } : {}),
		totalBytes: scan.totalBytes,
	};
	writeMetadata(runDir, meta);
	return meta;
}

/** Reads the stored metadata for one checkpoint type of a run. */
export function readCheckpoint(runId: string, type: CheckpointType): CheckpointMetadata | null {
	try {
		const store = readStore(checkpointRunDirFor(runId));
		const meta = store[type];
		if (!meta || meta.type !== type || meta.runId !== runId) return null;
		return meta;
	} catch {
		return null;
	}
}

/** Reads stored metadata for both checkpoint types of a run. */
export function listCheckpoints(runId: string): { baseline: CheckpointMetadata | null; safe: CheckpointMetadata | null } {
	return { baseline: readCheckpoint(runId, "run_baseline"), safe: readCheckpoint(runId, "latest_safe") };
}

/** Reads exact stored bytes for a covered path of a checkpoint type. */
const readStoredBytes = (runId: string, type: CheckpointType, rel: string): Buffer | null => {
	try {
		return readFileSync(join(checkpointRunDirFor(runId), type === "run_baseline" ? "baseline" : "safe", ...rel.split("/")));
	} catch {
		return null;
	}
};

const currentHash = (cwd: string, rel: string): string | null => {
	try {
		return hashOf(readFileSync(resolve(cwd, rel)));
	} catch {
		return null;
	}
};

const currentExists = (cwd: string, rel: string): boolean => {
	try {
		return statSync(resolve(cwd, rel)).isFile();
	} catch {
		return false;
	}
};

/**
 * v1.6 conflict strategy (documented, conservative):
 *
 * RUN_BASELINE: the domain is the refreshed v1.5 manifest itself —
 * created -> remove, modified -> restore exact pre-run bytes, deleted ->
 * recreate. Pre-existing untouched files (e.g. user scratch notes) are never
 * touched, and pre-run user-modified content is restored from the snapshot,
 * never from Git HEAD.
 *
 * LATEST_SAFE: ordinary content divergence from the checkpoint is NOT a
 * conflict. v1.5 established that change manifests are NOT authorship
 * attribution; snapshot comparison cannot tell who wrote post-checkpoint
 * bytes, so the extension does not claim to know.
 *   - covered file, differs now        -> RESTORE exact checkpoint bytes
 *   - covered file, deleted now        -> RECREATE from checkpoint bytes
 *   - file absent at the checkpoint    -> REMOVE only when it is inside the
 *     run's tracked change scope (refreshed manifest.created); everything
 *     else is preserved as an unknown post-checkpoint file
 *
 * Genuinely structural conflicts (where safe restoration cannot actually be
 * performed) are still blocked: required path not covered by the snapshot
 * (partial coverage), missing/corrupt checkpoint blob, path escaping the
 * workspace, `.git/**` or ignored/generated paths, symlink safety.
 */
export function planRollback(options: {
	cwd: string;
	runId: string;
	target: CheckpointType;
	manifest: { created: string[]; modified: string[]; deleted: string[] };
}): RollbackPlan {
	const target = readCheckpoint(options.runId, options.target);
	if (!target) {
		return { target: options.target, actions: [], conflicts: [], coverage: "partial", created: 0, modified: 0, deleted: 0, preserved: [] };
	}
	const cwd = options.cwd;
	const attributed = new Set([...options.manifest.created, ...options.manifest.modified, ...options.manifest.deleted]);
	const actions: RollbackAction[] = [];
	const conflicts: RollbackConflict[] = [];
	const preserved: string[] = [];

	// Structural path safety: only workspace-relative, non-.git, non-ignored paths.
	const domainPath = (p: string): string | null => {
		const root = resolve(cwd);
		const abs = resolve(cwd, p);
		if (abs !== root && !abs.startsWith(root + sep)) return null;
		const rel = relative(cwd, abs).split(sep).join("/");
		if (!rel || rel.startsWith("..")) return null;
		if (rel.startsWith(".git/") || rel === ".git") return null;
		for (const d of IGNORED_DIRS) {
			if (rel === d || rel.startsWith(`${d}/`)) return null;
		}
		return rel;
	};
	const covered = (rel: string): boolean => rel in target.files;

	if (options.target === "run_baseline") {
		// Domain = the run manifest itself: created -> remove, modified -> restore,
		// deleted -> recreate. Attribution is given by the manifest by definition;
		// pre-run user bytes live in the baseline snapshot, not Git HEAD.
		for (const p of options.manifest.created) {
			const rel = domainPath(p);
			if (!rel || !currentExists(cwd, rel)) continue;
			actions.push({ action: "remove", path: rel, reason: "created by run; absent at baseline" });
		}
		for (const p of options.manifest.modified) {
			const rel = domainPath(p);
			if (!rel) continue;
			if (!covered(rel)) {
				conflicts.push({ path: rel, reason: "not covered by baseline snapshot (partial coverage); safe restore impossible" });
				continue;
			}
			actions.push(
				currentExists(cwd, rel)
					? { action: "restore", path: rel, reason: "modified by run; restoring pre-run bytes" }
					: { action: "recreate", path: rel, reason: "deleted by run; restoring pre-run bytes" },
			);
		}
		for (const p of options.manifest.deleted) {
			const rel = domainPath(p);
			if (!rel) continue;
			if (!covered(rel)) {
				conflicts.push({ path: rel, reason: "not covered by baseline snapshot (partial coverage); safe recreate impossible" });
				continue;
			}
			actions.push({ action: "recreate", path: rel, reason: "deleted by run; restoring baseline bytes" });
		}
	} else {
		// LATEST_SAFE: ordinary divergence is NOT a conflict (authorship of
		// post-checkpoint bytes is unknowable from snapshot comparison).
		for (const rel of Object.keys(target.files)) {
			const relPath = domainPath(rel);
			if (!relPath) continue;
			if (currentExists(cwd, relPath)) {
				if (currentHash(cwd, relPath) === target.files[rel].hash) continue; // unchanged since checkpoint
				if (!covered(relPath)) {
					conflicts.push({ path: relPath, reason: "not covered by checkpoint snapshot (partial coverage); safe restore impossible" });
					continue;
				}
				actions.push({ action: "restore", path: relPath, reason: "changed since checkpoint; restoring checkpoint bytes" });
			} else {
				if (!covered(relPath)) {
					conflicts.push({ path: relPath, reason: "not covered by checkpoint snapshot (partial coverage); safe recreate impossible" });
					continue;
				}
				actions.push({ action: "recreate", path: relPath, reason: "removed since checkpoint; recreating from checkpoint" });
			}
		}
		// Structural conflict: a run-manifest-modified path whose restore would
		// require checkpoint bytes we do not have (partial coverage) cannot be
		// safely restored, so it is blocked instead of guessed at.
		for (const p of options.manifest.modified) {
			const relPath = domainPath(p);
			if (!relPath || relPath in target.files) continue;
			conflicts.push({ path: relPath, reason: "not covered by checkpoint snapshot (partial coverage); safe restore impossible" });
		}
		// Files absent at the checkpoint: remove ONLY within the run's tracked
		// change scope (refreshed manifest.created); otherwise preserve as an
		// unknown post-checkpoint file (no authorship claim, no conflict).
		const currentScan = scanForSnapshot(cwd);
		for (const f of currentScan.files) {
			const relPath = domainPath(f.rel);
			if (!relPath || relPath in target.files) continue;
			if (options.manifest.created.includes(relPath)) {
				actions.push({ action: "remove", path: relPath, reason: "created after checkpoint within tracked change scope; removing" });
			} else {
				preserved.push(relPath);
			}
		}
	}

	const summary = { created: 0, modified: 0, deleted: 0 };
	for (const a of actions) {
		if (a.action === "remove") summary.created++;
		else if (a.action === "recreate") summary.deleted++;
		else summary.modified++;
	}
	return { target: options.target, actions, conflicts, coverage: target.coverage, preserved, ...summary };
}

/**
 * Applies a rollback plan. Refuses (no mutation) when conflicts exist.
 * Restores exact stored bytes with the recorded file mode; never touches git.
 */
export function executeRollback(options: {
	cwd: string;
	runId: string;
	target: CheckpointType;
	plan: RollbackPlan;
}): { ok: boolean; restored: number; removed: number; errors: string[] } {
	if (options.plan.conflicts.length > 0) {
		return { ok: false, restored: 0, removed: 0, errors: options.plan.conflicts.map((c) => `conflict: ${c.path} — ${c.reason}`) };
	}
	let restored = 0;
	let removed = 0;
	const errors: string[] = [];
	for (const a of options.plan.actions) {
		const abs = resolve(options.cwd, a.path);
		if (!abs.startsWith(resolve(options.cwd) + sep) && abs !== resolve(options.cwd)) {
			errors.push(`skipped outside workspace: ${a.path}`);
			continue;
		}
		try {
			if (a.action === "remove") {
				rmSync(abs, { force: true });
				removed++;
			} else {
				const bytes = readStoredBytes(options.runId, options.target, a.path);
				if (!bytes) {
					errors.push(`missing stored bytes: ${a.path}`);
					continue;
				}
				mkdirSync(dirname(abs), { recursive: true });
				writeFileSync(abs, bytes);
				const rec = readCheckpoint(options.runId, options.target)?.files?.[a.path];
				if (rec?.mode !== undefined) {
					try {
						chmodSync(abs, rec.mode);
					} catch {
						// best effort
					}
				}
				restored++;
			}
		} catch (error) {
			errors.push(`${a.path}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return { ok: errors.length === 0, restored, removed, errors };
}

/** Best-effort cleanup of the current run's checkpoint directory (user-initiated). */
export function cleanCheckpoints(runId: string): void {
	try {
		rmSync(checkpointRunDirFor(runId), { recursive: true, force: true });
	} catch {
		// best effort
	}
}

/** Copies bytes without following symlinks (workspace-boundary safety). */
export function snapshotSymlinkSafetyHint(): string {
	return "symlinks are never followed during snapshot or rollback";
}