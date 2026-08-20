# pi-engineering-loop

A **bounded autonomous engineering loop** for [Pi](https://github.com/earendil-works/pi): a deterministic orchestration extension that gives Pi a goal, scouts the repository, plans concrete tasks, engineers them, independently verifies the result, and can recover to user-controlled checkpoints.

Engineering Loop is an *extension* — Pi remains the orchestrator, the parent engineer, and the executor. This package adds a state machine, structured task ledger, two isolated child subagents (Scout and Verifier), change tracking, and byte-based recovery on top of Pi's normal agent runtime.

## What it is

A single `/engineer <goal>` command turns Pi into a self-supervising engineering worker with:

- a **bounded autonomous loop** (configurable iteration and verification caps),
- **workspace confinement** (iterations are bound to the workspace the run started in),
- an **isolated repository Scout** that reconnoiters before planning,
- a **persistent structured plan** and task ledger with evidence-backed completion,
- an **independent Verifier** subagent that rejects untrustworthy work,
- a **repair loop** (verifier failure → findings → engineer fixes → re-verify),
- **change tracking** and dirty-workspace protection (baseline vs. current diff),
- **checkpoints + explicit, previewed, confirmed rollback** — never git reset/clean.

## Architecture

```
Goal
 → baseline                 (v1.5 change snapshot + v1.6 byte snapshot)
 → Scout                    (isolated, read-only repository recon)
 → plan                     (engineer creates a structured task ledger)
 → Engineer                 (parent Pi agent, one iteration at a time)
 → plan completion gate     (mechanical: DONE rejected until all tasks complete)
 → isolated Verifier        (fresh context, structured { verdict, findings })
 → repair if needed         (findings fed back into the next engineering iteration)
 → PASS
```

## Features

- Bounded autonomous loop (`maxIterations`, `maxVerificationAttempts`, stall detection)
- Workspace confinement and read-only subagents
- Isolated repository Scout (`engineering-scout`)
- Structured persistent plan + task tools (`engineer_plan_create`, `engineer_task_start`, `engineer_task_complete`, `engineer_task_block`, `engineer_task_reopen`)
- Independent Verifier (`engineering-verifier`) with structured verdicts
- Verifier-driven repair loop with re-plan hints
- Change tracking + dirty-workspace protection (`/engineer changes`)
- Checkpoints (`RUN_BASELINE` auto, `LATEST_SAFE` on demand)
- Explicit safe rollback with preview + confirmation
- Reload / resume / session restoration that keeps state coherent
- Deterministic TEST-ONLY fault injection (`/engineer --test-failure`)

## Requirements

- **Pi** (the coding agent) — see `pi --version`
- **pi-subagents** — required runtime for the isolated Scout/Verifier subagents:
  ```sh
  pi install npm:pi-subagents
  ```
- A supported Node runtime (according to the installed Pi)
- **Git is optional** — `engineering-loop` runs in filesystem-only mode when git is unavailable; git is observed, never mutated.

## Install

Development/local:

```sh
pi install /path/to/pi-engineering-loop
```

From Git:

```sh
pi install npm:pi-subagents        # prerequisite (once)
pi install git:github.com/USER/pi-engineering-loop
```

If Pi is already running, run `/reload` after installing.

## Update

For a moving Git ref/tag, re-run:

```sh
pi update <source>        # refresh an installed source (see `pi update --help`)
```

or reinstall from the new ref. Migration of saved state (sessions, checkpoints) is automatic because state lives in Pi sessions and in `<agent dir>/engineering-loop/`.

## Remove

```sh
pi remove pi-engineering-loop
# or: pi remove git:github.com/USER/pi-engineering-loop
```

> Note: checkpoint files under `<agent dir>/engineering-loop/` are **not** removed by uninstalling. Delete that directory yourself if you want them gone.

## Usage

```sh
# Start an engineering run in the current directory
/engineer Add a health endpoint at GET /health that returns JSON {"status":"ok"}, with tests and docs.

# Inspect progress at any time
/engineer status
/engineer plan
/engineer changes

# Create and use a recovery checkpoint, then roll back if needed
/engineer checkpoint
/engineer rollback          # preview only
/engineer rollback confirm  # restores LATEST_SAFE
/engineer rollback baseline confirm  # restores the pre-run workspace

# Stop and resume
/engineer stop
/engineer resume
```

## Commands

| Command | Purpose |
| --- | --- |
| `/engineer <goal>` | Start a new engineering run and trigger iteration 1 |
| `/engineer --test-failure <goal>` | **TEST-ONLY** — start a run armed with a verifier-only sentinel criterion (engineer cannot see it) |
| `/engineer status` | Run summary: goal, phase, plan, changes, recovery |
| `/engineer plan` | Show the full structured plan |
| `/engineer scout` | Show the saved Scout report |
| `/engineer changes` | Show created / modified / deleted files since the baseline |
| `/engineer checkpoint` | Capture a `LATEST_SAFE` snapshot of the workspace |
| `/engineer checkpoints` | List recovery snapshots (`/engineer checkpoints clean` removes them) |
| `/engineer rollback` | **Preview** rollback to `LATEST_SAFE` (non-destructive) |
| `/engineer rollback confirm` | Execute rollback to `LATEST_SAFE` |
| `/engineer rollback baseline` / `… baseline confirm` | Preview / execute rollback to `RUN_BASELINE` |
| `/engineer stop` | Stop the loop (state preserved) |
| `/engineer resume` | Resume a stopped run |
| `/engineer config` | Show effective configuration |
| `/engineer help` | Show this command reference |

Rollback always requires a preview followed by `… confirm`. It is slash-command-only: the model can never invoke rollback.

## Safety model

- **No automatic git reset/clean/checkout/restore.** Recovery is byte-based from extension-owned snapshots stored outside the workspace.
- **Baseline = actual pre-run workspace**, not Git HEAD. A file you modified before the run is restored to your exact pre-run content.
- **Change manifests are tracking, not authorship attribution.** Engineering Loop does not claim to know who wrote post-checkpoint bytes.
- **Rollback previews require confirmation.** Conflicts (paths that cannot be safely restored) block rollback entirely.
- **Partial snapshot coverage is warned loudly** and never silently claimed as full.
- **Subagents are tool-restricted:** Scout is read-only (read/grep/find/ls); the Verifier adds bash (read/grep/find/ls/bash) but has no write/edit.

See [`docs/SAFETY.md`](docs/SAFETY.md) for the full guarantees and non-guarantees.

## Configuration

Optional JSON config in `<agent dir>/engineering-loop/config.json` (all fields optional):

```json
{
  "maxIterations": 15,
  "maxVerificationAttempts": 5,
  "maxConsecutiveVerificationFailures": 4,
  "replanAfterFailures": 2,
  "scout": true,
  "verifier": true,
  "scoutTimeoutMs": 600000,
  "verifierTimeoutMs": 600000,
  "checkpointPerFileLimitMiB": 4,
  "checkpointTotalLimitMiB": 100
}
```

Malformed values fall back to safe defaults with a notification. Configuration never weakens safety invariants (workspace confinement and explicit rollback confirmation are hard-coded). Edit then `/reload`.

## Limitations

- **LATEST_SAFE authorship is unknowable.** A file changed after a checkpoint is rolled back to checkpoint bytes; Engineering Loop cannot tell whether a post-checkpoint edit came from the engineer or from you. Review the rollback preview before confirming. A file created after the checkpoint is removed only when it is inside the run's tracked change scope; anything else is preserved and listed as unknown.
- The parent engineer still needs real project inspection before large changes; Scout findings are reconnaissance, not truth.

## Windows

Install on Windows exactly the same way:

```sh
pi install npm:pi-subagents
pi install git:github.com/USER/pi-engineering-loop
```

No Unix-only copy commands are needed for a normal Git-package install. Paths resolve through `node:path`/`os.homedir()` and the `PI_CODING_AGENT_DIR` environment override; checkout/rollback uses only Node filesystem APIs. Git is optional and observed read-only when present.

## Development

See [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) for local development, validation of the custom agents, running the smoke suites, and the release checklist.

## License

MIT — see [LICENSE](LICENSE).
