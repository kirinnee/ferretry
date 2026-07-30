# Kickoff — Ferretry migration lead

You are the long-running interactive lead for **Ferretry** at `~/Workspace/personal/ferretry`
(public repo `github.com/kirinnee/ferretry`). The human (Kirin) will attach and drive this
session; between their messages, work autonomously within the phase order.

**First: read these, in order.**

1. `docs/PROMPT.md` — the mission, phase order, sources of truth, and rules. It is binding.
2. `handover.md` — the imported feature backlog (phase 3; do not start it yet).
3. `docs/design/split-proposal.md` — architecture, pairing protocol, security model.
4. `CLAUDE.md` + `.claude/skills/cli-authoring/SKILL.md` — repo invariants.

**Phase 1 (start now): port diene's standards.**
`git -C /home/kirin/Workspace/atomi/diene/diene.all ls-tree -r bun-cli --name-only -- docs`
lists 57 files; read each via `git ... show bun-cli:<path>`. Port `docs/standards/**` into this
repo: keep three-layer-architecture, stateless-oop-di, solid-principles, functional-practices,
testing, validation, datetime, linting, nix, taskfile, semantic-release, shell-scripts,
conventional-commits, software-design-philosophy, contracts, ci-cd, utilities, contributor-docs;
drop or park AtomiCloud-specifics (infisical, service-tree, docker for now, authorization until
phase 3 needs it — park = a stub noting why). Strip AtomiCloud branding/urls; adapt examples to
this repo (bun workspaces, fy/ferretry two-name model). Rewire `CLAUDE.md` as the pure index.
Commit in reviewable chunks (conventional commits), keep pre-commit green, push to main.

**Phase 2 (after standards): plan, then replicate kteam.**
Write `docs/design/migration-plan.md` first: subsystem-by-subsystem port order for
`modules/kteam-ts` (daemon 9k-line session-manager, tmux controller, storage, api-server, CLI,
ui/) and `modules/kfleet-ts` into `packages/{protocol,daemon,cli,fleet,pwa}`, with the
fleet-manifest decoupling and the kteam→fy renames from docs/PROMPT.md. Present the plan to the
human for approval BEFORE porting (raise it via needs-help/attention if they are not attached).
You may spawn kteam teammates for bounded port units once the plan is approved — assign explicit
per-file ownership, `git commit --only`, never two agents on one file.

**Ground rules recap** (full set in docs/PROMPT.md): one bounded feature at a time; snapshot
publish + task test + pre-commit stay green on main; public repo — write accordingly; never
touch the live `~/.kteam` / `kteamd` installation; kloge and loctl stay external.
