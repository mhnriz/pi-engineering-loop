/**
 * engineering-loop v1.5 — workspace baseline + change tracking.
 *
 * Captures a bounded snapshot of the workspace before autonomous engineering
 * starts, then mechanically compares the current workspace against that
 * baseline to produce { created, modified, deleted } manifests.
 *
 * Design notes:
 * - Git status is read via `--porcelain=v1 -z` (deterministic, NUL-separated)
 *   and is ONLY observed — v1.5 never mutates git (no commit/stash/reset/
 *   clean/checkout/restore/branch/worktree).
 * - Git alone is NOT sufficient (untracked-only projects, dirty repos), so a
 *   filesystem snapshot backs the git info: relative paths, size, mtimeMs,
 *   and content hashes for source-sized files.
 * - The manifest describes "files that changed after the run started". It is
 *   NOT line-level authorship attribution: external edits during the run also
 *   appear. This is a safety boundary, not perfect attribution.
 * - Everything is synchronous and bounded: bounded file count, bounded hash
 *   size, bounded git timeouts, ignored generated/large directories.
 *
 * TEST-ONLY: ENGINEERING_LOOP_BASELINE_DISABLE=1 disables capture/refresh
 * (used by older regression suites that run against /home/hariz).
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

export interface WorkspaceFileSnapshot {
	/** Workspace-relative path with forward slashes. */
	path: string;
	size: number;
	/** Present only when the file was too large to hash (metadata-only). */
	mtimeMs?: number;
	/** sha1 hex for files at or below the hash limit. */
	hash?: string;
}

export interface ChangeBaseline {
	capturedAt: string;
	gitAvailable: boolean;
	gitRoot?: string;
	branch?: string;
	trackedModified: string[];
	trackedDeleted: string[];
	untracked: string[];
	files: WorkspaceFileSnapshot[];
	/** true when tracking became partial (cap hit, large/unreadable files, git status unavailable). */
	partial: boolean;
}

export interface EngineeringChangeManifest {
	created: string[];
	modified: string[];
	deleted: string[];
}

/** Directories never scanned (generated/vendor/cache). Conservative: project source is never ignored. */
export const IGNORED_DIRS = new Set([
	".git",
	"node_modules",
	".next",
	"dist",
	"build",
	"coverage",
	".cache",
	".pytest_cache",
	"__pycache__",
	".venv",
	"venv",
]);

/** Path prefixes that should never appear in a run manifest (defensive checks). */
export const SENSITIVE_PATH_PREFIXES = [
	".git/",
	"node_modules/",
	".next/",
	"dist/",
	"build/",
	"coverage/",
	".cache/",
	".pytest_cache/",
	"__pycache__/",
	".venv/",
	"venv/",
];

/** Files at or below this size get content hashes; larger files are metadata-only. */
export const HASH_LIMIT_BYTES = 512 * 1024;
/** Bounded baseline size (protects against huge repositories). */
export const MAX_BASELINE_FILES = 4000;
const GIT_TIMEOUT_MS = 5000;
const GIT_MAX_BUFFER = 32 * 1024 * 1024;

const runGitSync = (args: string[], cwd: string): string => {
	try {
		return execFileSync("git", args, {
			cwd,
			timeout: GIT_TIMEOUT_MS,
			maxBuffer: GIT_MAX_BUFFER,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
	} catch {
		return "";
	}
};

/** Read-only git facts: root, branch, porcelain status. Never mutates. */
const captureGitBaseline = (cwd: string): Omit<ChangeBaseline, "capturedAt" | "files"> => {
	const top = runGitSync(["rev-parse", "--show-toplevel"], cwd).trim();
	if (!top) {
		return { gitAvailable: false, trackedModified: [], trackedDeleted: [], untracked: [], partial: false };
	}
	const branchRaw = runGitSync(["rev-parse", "--abbrev-ref", "HEAD"], cwd).trim();
	const branch = branchRaw && branchRaw !== "HEAD" ? branchRaw : undefined;
	const statusRaw = runGitSync(["status", "--porcelain=v1", "-z"], cwd);
	const trackedModified: string[] = [];
	const trackedDeleted: string[] = [];
	const untracked: string[] = [];
	let partial = false;
	if (statusRaw) {
		for (const chunk of statusRaw.split("\0")) {
			if (chunk.length < 4) continue;
			const code = chunk.slice(0, 2);
			const path = chunk.slice(3);
			if (!path) continue;
			if (code === "??") untracked.push(path);
			else if (code.includes("D")) trackedDeleted.push(path);
			else if (code.includes("M") || code.startsWith("A") || code.startsWith("R") || code.startsWith("C")) {
				trackedModified.push(path);
			}
		}
	} else {
		// git exists but status failed/timed out: git side is partial; fs tracking continues.
		partial = true;
	}
	return { gitAvailable: true, gitRoot: top, branch, trackedModified, trackedDeleted, untracked, partial };
};

/**
 * Bounded workspace walk. Deterministic order; skips IGNORED_DIRS and
 * symlinks; hashes files at or below HASH_LIMIT_BYTES; records metadata-only
 * for larger files; marks partial when caps are hit or files are unreadable.
 */
const scanWorkspace = (cwd: string): { files: WorkspaceFileSnapshot[]; partial: boolean } => {
	const files: WorkspaceFileSnapshot[] = [];
	let partial = false;
	let count = 0;
	const walk = (dir: string): void => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			partial = true;
			return;
		}
		entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		for (const e of entries) {
			if (count >= MAX_BASELINE_FILES) {
				partial = true;
				return;
			}
			if (IGNORED_DIRS.has(e.name)) continue;
			const full = join(dir, e.name);
			if (e.isDirectory()) {
				walk(full);
				continue;
			}
			// Symlinks are never followed (workspace-boundary safety).
			if (e.isSymbolicLink() || !e.isFile()) continue;
			let st;
			try {
				st = statSync(full);
			} catch {
				partial = true;
				continue;
			}
			const snap: WorkspaceFileSnapshot = {
				path: relative(cwd, full).split(sep).join("/"),
				size: st.size,
			};
			if (st.size <= HASH_LIMIT_BYTES) {
				try {
					snap.hash = createHash("sha1").update(readFileSync(full)).digest("hex");
				} catch {
					partial = true;
					continue;
				}
			} else {
				// metadata-only for very large files (recorded honestly)
				snap.mtimeMs = st.mtimeMs;
				partial = true;
			}
			files.push(snap);
			count++;
		}
	};
	walk(cwd);
	return { files, partial };
};

/**
 * Captures the one-time workspace baseline for a run. Returns null only when
 * tracking is disabled (TEST-ONLY) or the workspace cannot be inspected at all.
 */
export function captureWorkspaceBaseline(cwd: string): ChangeBaseline | null {
	// TEST-ONLY: force tracking off (older regression suites run against /home/hariz).
	if (process.env.ENGINEERING_LOOP_BASELINE_DISABLE === "1") return null;
	const git = captureGitBaseline(cwd);
	const scan = scanWorkspace(cwd);
	return {
		capturedAt: new Date().toISOString(),
		...git,
		files: scan.files,
		partial: git.partial || scan.partial,
	};
}

/**
 * Compares the current workspace against the baseline. Hash comparison is
 * authoritative for source-sized files (mtime-only false positives avoided);
 * metadata-only comparison (size + mtimeMs) is used for very large files.
 * A deleted-then-recreated file with identical content classifies as
 * unchanged (final content wins).
 */
export function refreshWorkspaceChanges(
	baseline: ChangeBaseline,
	cwd: string,
): { changes: EngineeringChangeManifest; partial: boolean } {
	const current = scanWorkspace(cwd);
	const byPath = new Map(baseline.files.map((f) => [f.path, f]));
	const currentMap = new Map(current.files.map((f) => [f.path, f]));
	const created: string[] = [];
	const modified: string[] = [];
	const deleted: string[] = [];

	for (const [path, base] of byPath) {
		const now = currentMap.get(path);
		if (!now) {
			deleted.push(path);
			continue;
		}
		if (base.hash !== undefined && now.hash !== undefined) {
			if (base.hash !== now.hash) modified.push(path);
			continue;
		}
		if (base.hash === undefined && now.hash === undefined) {
			if (base.size !== now.size || Math.abs((base.mtimeMs ?? 0) - (now.mtimeMs ?? 0)) > 1) {
				modified.push(path);
			}
			continue;
		}
		// One side hashed, the other not: content cannot be proven identical.
		if (base.size !== now.size || base.hash !== undefined) {
			modified.push(path);
			continue;
		}
		if (Math.abs((base.mtimeMs ?? 0) - (now.mtimeMs ?? 0)) > 1) modified.push(path);
	}
	for (const path of currentMap.keys()) {
		if (!byPath.has(path)) created.push(path);
	}
	created.sort();
	modified.sort();
	deleted.sort();
	return {
		changes: { created, modified, deleted },
		partial: baseline.partial || current.partial,
	};
}

/** Bounded, readable list lines for a manifest section (30 shown + truncation note). */
export const formatChangeList = (paths: string[], label: string): string[] => {
	const lines = [`${label}:`];
	if (paths.length === 0) {
		lines.push("  none");
	} else {
		for (const p of paths.slice(0, 30)) lines.push(`  ${p}`);
		if (paths.length > 30) lines.push(`  …and ${paths.length - 30} more`);
	}
	return lines;
};

/** Mechanical safety warnings for suspicious run changes (advisory only; no auto-fail). */
export function computeSafetyWarnings(changes: EngineeringChangeManifest, partial: boolean): string[] {
	const warnings: string[] = [];
	if (partial) {
		warnings.push("Change tracking is partial; some files could not be fully compared (large, capped, or unreadable).");
	}
	const all = [...changes.created, ...changes.modified, ...changes.deleted];
	const sensitive = all.filter((p) => SENSITIVE_PATH_PREFIXES.some((pre) => p.startsWith(pre)));
	if (sensitive.length) {
		warnings.push(
			`Changes touch sensitive/generated paths: ${sensitive.slice(0, 8).join(", ")}${sensitive.length > 8 ? ` (+${sensitive.length - 8} more)` : ""}`,
		);
	}
	if (all.length > 60) {
		warnings.push(`Unusually large number of changed files (${all.length}) — verify scope.`);
	}
	return warnings;
}
