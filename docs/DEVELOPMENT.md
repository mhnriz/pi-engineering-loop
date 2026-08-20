# Development

Notes for contributing to `pi-engineering-loop`.

## Quick start

```sh
git clone <url> pi-engineering-loop
cd pi-engineering-loop
pi install .            # install the local checkout as a Pi package
```

Then `/reload` in a running Pi session, or start a fresh Pi.

If the system already has the extension loaded from an older install, ensure you do not have **two** copies loaded (see "Migration / avoiding duplicates" below).

## File locations

| Thing | Location |
| --- | --- |
| Extension source | `extension/` (`index.ts`, `verifier.ts`, `workspace.ts`, `checkpoints.ts`, `config.ts`) |
| Subagents | `agents/engineering-scout.md`, `agents/engineering-verifier.md` |
| Docs | `docs/` |
| Smoke suites | `tests/` |
| Runtime config | `<PI_CODING_AGENT_DIR or ~/.pi/agent>/engineering-loop/config.json` |
| Checkpoints | `<PI_CODING_AGENT_DIR or ~/.pi/agent>/engineering-loop/checkpoints/` |

## Reload

Pi extension development is reload-friendly:

```
/reload
```

State persists in the current session's custom entries; checkpoints live on disk; the loop is intentionally dormant after reload until `/engineer resume`.

## Validating the custom agents

The subagents are ordinary pi-subagents agent files. To confirm they resolve and their tool allowlists are correct:

- `pi-subagents` preflight API can validate the launch contract programmatically (see `tests/` and `docs/ARCHITECTURE.md`).
- Check `configured tools` in the agent frontmatter:
  - `engineering-scout`: `read, grep, find, ls`
  - `engineering-verifier`: `read, grep, find, ls, bash`
- If agents do not appear, confirm `pi-subagents` is installed and the package manifest exposes `pi.subagents.agents` → `./agents` (and/or `pi-subagents.agents`).

## Running the smoke / regression suites

Suites live in `tests/` and run with Node + jiti (the same loader Pi uses). They need a development environment where pi-subagents is installed under Pi's managed npm directory, because the suites import its public API and exercise real filesystem/workspace behavior (they create throwaway temp workspaces and checkpoint roots).

From the repository:

```sh
node <pi-package>/node_modules/.bin/jiti tests/eng-loop-v12-smoke.mjs
node <pi-package>/node_modules/.bin/jiti tests/eng-loop-v13-smoke.mjs
node <pi-package>/node_modules/.bin/jiti tests/eng-loop-v14-smoke.mjs
node <pi-package>/node_modules/.bin/jiti tests/eng-loop-v16-smoke.mjs
```

(expected totals: v1.2 = 105, v1.3 = 84, v1.4 = 75, v1.6 = 94 checks.)

Each suite sets TEST-ONLY environment overrides (`ENGINEERING_LOOP_*`) and its own checkpoint root so nothing leaks into real Pi state.

## Migration / avoiding duplicates

If you previously installed Engineering Loop as loose files under `~/.pi/agent/extensions/engineering-loop` and `~/.pi/agent/agents/engineering-{scout,verifier}.md`, move those out before installing this package, otherwise Pi loads the extension twice (and pi-subagents can see duplicate agents). The package's `extension/index.ts` and `agents/` become the single source. Verify with a loader-level check that exactly one `engineering-loop` extension entry resolves.

## Release checklist

1. `tests/*` all green against `extension/index.ts` (point `EXT_PATH` at the repo).
2. `pi install .` works; `/engineer help` and `/engineer config` respond.
3. `engineering-scout` and `engineering-verifier` are discoverable from the installed package.
4. Ship with `pi install git:…` in mind: package.json exposes `pi.extensions` and `pi.subagents.agents`; `files` covers `extension/`, `agents/`, `docs/`, README, CHANGELOG, LICENSE.
5. Bump `version` in `package.json` + `CHANGELOG.md`.

## Notes

- Do **not** commit development-only smoke state, temp workspaces, or local checkpoint roots (see `.gitignore`).
- The TEST-ONLY `ENGINEERING_LOOP_*` environment hooks exist so smoke tests can exercise timeouts/caps cheaply; they are read at call time and default to safe values.
