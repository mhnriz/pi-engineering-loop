# Safety

What Engineering Loop **guarantees** and what it explicitly does **not**.

## Guarantees

- **Workspace confinement.** Iterations and subagents are bound to the workspace captured at `/engineer` time. No rollback action can escape the workspace (path safety checks reject `..`, absolute escapes, symlinks).
- **Scout is read-only.** `engineering-scout` runs with `read, grep, find, ls` only — no bash, no write/edit, no plan tools. Its tool allowlist plus a session capability ceiling keep it isolated.
- **Verifier is read + bash, no write/edit.** `engineering-verifier` runs with `read, grep, find, ls, bash` so it can run tests/builds, but it has no write or edit tools and never modifies implementation files.
- **No git mutation.** Engineering Loop never runs `git reset --hard`, `git clean`, `git checkout .`, `git restore .`, commit, stash, branch, or worktree. Git, when present, is observed read-only. `git diff` emptiness does not weaken recovery.
- **Baseline is the real pre-run workspace.** A file modified before the run is restored to the exact pre-run bytes — never to Git HEAD.
- **Rollback requires preview + explicit confirmation.** `/engineer rollback` is preview-only; only `/engineer rollback confirm` mutates. The model can never invoke rollback (no model-facing tool).
- **Checkpoints are bounded.** Per-file (4 MiB) and total (100 MiB) snapshot caps; over-cap files are marked partial and warned about, never silently claimed as covered.
- **Partial coverage is loud.** `rollbackCoverage: "partial"` surfaces in status, checkpoint output, and rollback previews; a restore that needs uncovered bytes is blocked.
- **Dirty-workspace protection.** Pre-existing user-modified files, pre-existing untracked files, and files the run never touched are all preserved by RUN_BASELINE rollback.
- **Subagent crashes are not goal failures.** Scout failure falls back to direct engineering inspection; verifier infrastructure failures block with a clear reason instead of pretending the goal failed verification.

## Non-guarantees / limitations

- **Filesystem tracking ≠ authorship.** The v1.5 change manifest records *which files changed after the run started*, not *who* changed them (engineer vs. user). Engineering Loop does not attempt line-level authorship attribution.
- **LATEST_SAFE external edits.** Rolling back to a `LATEST_SAFE` checkpoint restores that checkpoint's exact bytes. If you (or anything outside the loop) edited a file after the checkpoint, that edit is discarded for affected paths — unless the extension could not attribute the file, in which case it is preserved and reported. Review every rollback preview carefully. A file created after the checkpoint is removed only when it is within the run's tracked change scope; un-tracked creations are preserved and listed.
- **Conservative removal, not perfect attribution.** Because authorship is unknowable, a file created after a checkpoint *inside the tracked workspace scope* is treated as a run-created file and may be removed on LATEST_SAFE rollback. This is the documented, conservative trade-off.
- **External concurrent edits during a run** are indistinguishable from loop edits from the snapshot alone. Prefer checkpoints before heavy external work; the loop never auto-reverts external files outside its tracked scope.
- **Extensions and packages execute with your user permissions.** As with any Pi extension, code installed here can read/write what your user can. Only install from sources you trust.

## Rollback decision rules (summary)

| Situation | Behavior |
| --- | --- |
| Covered file, differs from checkpoint | RESTORE exact checkpoint bytes (no conflict) |
| Covered file, deleted since checkpoint | RECREATE from checkpoint bytes |
| New file absent from LATEST_SAFE, in tracked scope | REMOVE |
| New file absent from LATEST_SAFE, outside tracked scope | PRESERVED (listed) |
| Restore requires uncovered/partial bytes | CONFLICT — blocked, nothing applied |
| Path escapes workspace / `.git` / ignored dir | Never touched |
| RUN_BASELINE domain | Only the run manifest: created→remove, modified→restore pre-run bytes, deleted→recreate; everything else untouched |
