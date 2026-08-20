# Architecture

Implementation-level notes for maintainers of `pi-engineering-loop`.

## Roles

- **Extension** — the deterministic orchestrator. One `index.ts` factory registered via `pi.extensions`. All loop decisions, state transitions, gates, tool registrations, and subagent launches live here. Subagents never control the loop.
- **Parent Engineer** — the ordinary Pi agent. It receives iteration prompts, calls the planning/ledger tools, edits the workspace, and emits `<ENGINEER_DONE>` (or `<ENGINEER_CONTINUE>`).
- **engineering-scout** — isolated subagent (`context: fresh`), tool allowlist `read,grep,find,ls`. Repository reconnaissance only. Structured `SCOUT_SCHEMA` result persisted as `scoutReport`.
- **engineering-verifier** — isolated subagent (`context: fresh`), allowlist `read,grep,find,ls,bash`. Runs its own checks and returns a structured `{ verdict, findings }` via the pi-subagents structured-delegation protocol.

## State machine

State lives in Pi session custom entries (`pi.appendEntry("engineering-loop", state)`), so it survives `/reload`, restart, stop/resume, and compaction. Core fields:

```
goal, cwd, status, phase (engineering|verifying),
iteration, activeIteration, maxIterations,
plan, currentTaskId,
scoutReport, scoutStatus,
baseline, changes, changeTrackingPartial,
consecutiveVerificationFailures, lastVerificationFailure, needsReplan,
verificationAttempts, lastVerificationResult, completionCandidate testCriterion,
checkpointRunId, rollbackCoverage, latestSafeAt, verifierAgent
```

The loop is driven by `agent_settled`. Only ONE parent turn is ever in flight (`inFlightPhase` consumed synchronously); `lastProcessedAssistantId` prevents duplicate-settle double-processing. Child-agent delegation identity (`ownerRunId` from `startedAt`, per-attempt `requestId`, stable `nodeId`) plus stale-response guards prevent late subagent results from affecting a restarted/stopped run.

## Flow

1. `/engineer <goal>` → `startLoop`:
   - v1.5 baseline capture (`captureWorkspaceBaseline`) once, before anything else.
   - v1.6 RUN_BASELINE byte snapshot via `captureCheckpoint`.
   - optional dependency availability check.
   - Scout (if `config.scout` and the workspace looks non-empty) awaited; failure falls back to direct inspection.
   - iteration 1 via `triggerEngineering` (`activeIteration` set).
2. Each engineering iteration prompt carries: workspace rules, goal, optional `PREVIOUS VERIFICATION FAILURE`, `RE-PLAN REQUIRED`, `COMPLETION REJECTED`, `SCOUT REPORT`, and the `ENGINEERING PLAN` snapshot (or `PLANNING REQUIRED`).
3. `agent_settled` (engineering) → if `<ENGINEER_DONE>`: the **completion gate** (`evaluateCompletionGate`) mechanically checks plan state. No plan / pending / in-progress / blocked → reject, notify, schedule the next iteration with `COMPLETION REJECTED` showing unfinished tasks. Otherwise → phase `verifying`, persist, `launchVerifier`.
4. `launchVerifier` emits a pi-subagents structured-delegation request (`agent: engineering-verifier`, `context: fresh`, `cwd`, thinking high, `SCOUT_/VERIFIER_SCHEMA`); the response routes to `handleVerifierResponse`:
   - `completed` + `pass` → reset counters, `status = done`, final report.
   - `completed` + `fail` → feed findings into the next engineering iteration (consecutive/replan/stall/attempt limits apply).
   - infrastructure statuses → `blocked` with a clear reason (never pretended to be a verdict).
   - runtime failures/timeouts → conservative counted failures.
5. The verifier's `structure` never manages the plan; the engineer reopens tasks explicitly via `engineer_task_reopen` when findings implicate completed work.

## Delegation (pi-subagents)

`verifier.ts` owns all pi-subagents interaction: runtime package resolution (`PI_CODING_AGENT_DIR` → `~/.pi/agent` → managed `npm/node_modules/pi-subagents`), dynamic import of the public `delegation` and `capability-ceiling` API modules, schema/task builders. `index.ts` wires the event-bus request/response lifecycle (subscribe-before-emit, deadline backstop). A capability ceiling restricts subagent launches during a run to `engineering-verifier` + `engineering-scout` with the 5-tool set (intersection keeps bash verifier-only).

## Change tracking (v1.5)

`workspace.ts` captures a bounded workspace snapshot (paths, size, mtime, sha1 for source-sized files) plus read-only git facts at run start, then compares the live workspace to produce `{ created, modified, deleted }`. Git is informational only; fs tracking works with or without git. `refreshChangeManifest` is invoked before verifier launches, on settles, on FAIL, and on rollback.

## Checkpoints & rollback (v1.6)

`checkpoints.ts` stores byte snapshots outside the workspace:

```
<agent dir>/engineering-loop/checkpoints/<run-id>/
  metadata.json   (store: { run_baseline: {...}, latest_safe: {...} })
  baseline/       (RUN_BASELINE bytes)
  safe/           (LATEST_SAFE bytes)
```

`planRollback` produces RESTORE / RECREATE / REMOVE actions from a target checkpoint. RUN_BASELINE domain = the refreshed manifest (never overwrites pre-existing untouched files; restores exact pre-run bytes). LATEST_SAFE treats ordinary divergence as RESTORE (authorship unknowable), removes post-checkpoint creations only inside the tracked scope, preserves the rest, and blocks only on structural impossibilities (partial coverage, missing blob, path safety). `executeRollback` refuses entirely when conflicts exist. Rollback is slash-command + preview + confirm only.

## Configuration (v1.7)

`config.ts` reads `<agent dir>/engineering-loop/config.json`, clamps values, and provides effective settings with defaults preserving v1.6 behavior. Never configurable: workspace confinement and rollback confirmation.

## Files

```
extension/
  index.ts        orchestrator: state machine, prompts, gates, tools, commands
  verifier.ts     pi-subagents delegation + schemas + task builders
  workspace.ts    baseline + change manifest
  checkpoints.ts  snapshot + rollback storage/planning
  config.ts       optional user configuration
agents/           engineering-scout.md, engineering-verifier.md (pi.package manifest)
docs/, tests/     docs and smoke suites
```
