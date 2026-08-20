# Changelog

## 1.0.0-beta.1

First packaged beta. Summation of the v1.0–v1.6 development series, packaging + usability polish.

- **v1.0** — Bounded autonomous engineering loop driven by `agent_settled`; `<ENGINEER_DONE>` vs `<ENGINEER_CONTINUE>` markers; workspace binding.
- **v1.1** — Independent verification phase (`<VERIFY_PASS>`/`<VERIFY_FAIL>`), repair loop, consecutive-failure re-plan + stall blocking, deterministic TEST-ONLY fault-injection command.
- **v1.2** — Truly isolated verifier via pi-subagents structured delegation (`context: fresh`, structured `{ verdict, findings }`), fresh-context Reviewer, completion-candidate semantics, atomic `--test-failure`.
- **v1.3** — Persistent structured engineering plan (plan/task tools with stable `T1..Tn` ids), mechanical plan completion gate, `engineer_task_reopen`, plan snapshots in prompts.
- **v1.4** — Isolated repository Scout (`engineering-scout`, read-only), workspace emptiness heuristic, one-shot startup scouting.
- **v1.5** — Workspace baseline + run change manifest (dirty-workspace protection), readonly git observation, `/engineer changes`.
- **v1.6** — Extension-owned recoverable checkpoints (RUN_BASELINE + LATEST_SAFE) and explicit safe rollback with preview + confirm; byte-based recovery that never uses git reset/clean; conflict safeguards; authorship-unknown semantics for LATEST_SAFE.
- **v1.7 (this release)** — Distributable Pi package (`pi install git:…`), optional `config.json`, `/engineer config`, `/engineer help`, final completion report, cross-platform path audit, docs (README / SAFETY / ARCHITECTURE / DEVELOPMENT).
