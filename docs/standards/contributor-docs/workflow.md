---
id: contributor-docs-workflow
title: Contributor Documentation Workflow
---

# Contributor Documentation Workflow

Systematically generate contributor documentation for this repository by analyzing git diffs, planning the doc structure, writing files with parallel agents, and auditing the result.

## When to Use

- Documenting a new module or feature branch
- Generating technical docs from code changes
- Refreshing `docs/contributor/` after a large change lands

## Invocation

```text
generate contributor docs                    → analyze the current branch vs main, generate docs
generate contributor docs <base-branch>      → analyze the current branch vs a specified base
generate contributor docs --phase <phase>    → skip to a specific phase
```

The orchestrator is whichever agent picks up the request. Everything below is the contract it follows.

## Reference Documentation

Knowledge about what contributor docs are, their structure, and formatting rules:

- [What are contributor docs](./index.md)
- [Folder structure](./structure.md)
- [Frontmatter schemas](./frontmatter.md)
- [Formatting checklist](./checklist.md)
- [Classification heuristics](./classification.md)

Operational references (instructions for the agents, not for humans reading the docs):

- [Body templates](./common/templates.md)
- [Writing order](./common/writing-order.md)

## Agent Taxonomy

| Type             | Spawning              | State transition            | Purpose                               |
| ---------------- | --------------------- | --------------------------- | ------------------------------------- |
| **State agent**  | `Task`, direct result | No                          | State reads/writes (haiku)            |
| **Worker agent** | `Task`, direct result | Yes — corresponds to a step | Analysis, planning, writing, auditing |

Model shorthand used in the diagrams below: `H` = haiku, `S` = sonnet, `O` = opus.

## Orchestrator Model

```text
ORCHESTRATOR (you)
├── STATE AGENTS (stateless, direct result):
│   ├── plan-state-agent (H) — plan phase state reads/writes
│   ├── write-state-agent (H) — write phase state reads/writes
│   └── audit-state-agent (H) — audit phase state reads/writes
│
├── WORKER AGENTS (spawned via the Task tool):
│   ├── diff-analyzer (S) — reads git diff, catalogs all changes
│   ├── doc-planner (O) — classifies changes, plans doc structure
│   ├── scaffolder (S) — creates all files with frontmatter + TODOs
│   ├── doc-writer (S) ×N — writes one doc file (file-processor loop)
│   ├── big-picture-auditor (O) — holistic structure and coherence audit
│   └── fact-checker (S) ×N — per-file accuracy audit (file-processor loop)
│
└── State: Per-phase state agents handle all state writes. The orchestrator NEVER reads/writes JSON directly.
```

**Key principle:** The orchestrator NEVER reads step files directly. Always spawn a worker agent and tell it which step file to read and execute.

## Glossary

| Term             | Scope         | Description                                                 |
| ---------------- | ------------- | ----------------------------------------------------------- |
| **Module**       | Doc structure | Bounded context grouping (e.g., `release-pipeline/`)        |
| **Section type** | Doc structure | Content category: feature, concept, algorithm, surface, ADR |
| **Tier**         | Write phase   | Dependency level for writing order (1-6)                    |
| **Doc plan**     | Plan phase    | YAML manifest listing all files to create with metadata     |
| **Scaffold**     | Write phase   | File with frontmatter + TODO notes but no body content      |

## Two-Level State

All run state lives in a single scratch directory at the repository root. It is disposable: delete it to start over, and never commit it.

```text
.contributor-docs/
├── task-state.json          # Overall: which phase, base branch, docs root
├── plan-state.json          # Plan phase steps
├── write-state.json         # Write phase steps + tier tracking
├── audit-state.json         # Audit phase steps
├── write-tier-N/            # File-processor state per tier (created during write)
│   ├── state.json
│   └── findings/
├── fact-check/              # File-processor state for audit (created during audit)
│   ├── state.json
│   └── findings/
└── transitions.log          # Append-only step transition log
```

## Task-Level State (`task-state.json`)

| Field          | Type   | Description                                                   |
| -------------- | ------ | ------------------------------------------------------------- |
| `currentPhase` | string | Active phase: `plan`, `write`, `audit`, `completed`, `failed` |
| `baseBranch`   | string | Base branch to diff against (default: `main`)                 |
| `docsRoot`     | string | Output directory (default: `docs/contributor`)                |
| `planFile`     | string | Path to doc plan YAML (`.contributor-docs/doc-plan.yaml`)     |

## Top-Level State Machine

```text
task-state.json.currentPhase:
  plan → write → audit → completed
```

### Phase 1: Plan

```text
[diff_analysis] → [classify] → [review] → completed
   worker(S)       worker(O)     inline
```

Dispatch: `plan/PHASE.md`

### Phase 2: Write

```text
[scaffold] → [write_tier_1] → [write_tier_2] → ... → [write_tier_6] → completed
 worker(S)     file-processor    file-processor         file-processor
                 loop(S)×N         loop(S)×N               loop(S)×N
```

Dispatch: `write/PHASE.md`

### Phase 3: Audit

```text
[big_picture] → [fact_check] → completed
   worker(O)     file-processor
                   loop(S)×N
```

Dispatch: `audit/PHASE.md`

## Phase Dispatch

**On invocation, spawn a state agent to assess `task-state.json`, then dispatch:**

| `currentPhase` | Action                                                                  |
| -------------- | ----------------------------------------------------------------------- |
| No state file  | Parse arguments (base branch), create state via state agent, start Plan |
| `plan`         | Spawn the plan state agent to assess, dispatch per `plan/PHASE.md`      |
| `write`        | Spawn the write state agent to assess, dispatch per `write/PHASE.md`    |
| `audit`        | Spawn the audit state agent to assess, dispatch per `audit/PHASE.md`    |
| `completed`    | Report completion, list generated files                                 |
| `failed`       | Report error, offer retry                                               |

**Transition logging:** When advancing phases, the state agent appends:

```bash
echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) phase-transition from={old_phase} to={new_phase}" >>.contributor-docs/transitions.log
```

## File-Processor Pattern

The write phase (per-tier) and the audit fact-check use the file-processor loop. The scripts live in `scripts/` next to this file and follow the repository's [shell script conventions](../shell-scripts/index.md):

```bash
# 1. Initialize: pipe the file list into init-state.sh
printf '%s\n' file1.md file2.md |
  ./docs/standards/contributor-docs/scripts/init-state.sh <state-file> '<source-paths-json>' <N> '<output-dir>'

# 2. Loop: get the next batch, spawn agents, mark done
./docs/standards/contributor-docs/scripts/next-file.sh <state-file> --batch <N>

# 3. After each agent completes:
./docs/standards/contributor-docs/scripts/mark-done.sh <state-file> <filename>
```

Progress survives context loss. Re-running resumes from where it left off.

## Rules

### Autonomy

1. Proceed autonomously through diff analysis and classification. Stop at the review gate and wait for user approval.
2. If the plan is rejected, return to classify with user feedback.

### Safety

3. Never overwrite existing documentation files without user confirmation.
4. Never commit generated docs automatically.
5. Never write into `docs/standards/` — that tree is hand-authored doctrine, not generated output.

### Conventions

6. All generated files must pass [checklist.md](./checklist.md).
7. Follow the tier-based writing order in [writing-order.md](./common/writing-order.md). Never skip tiers.
8. Reference the body templates in [templates.md](./common/templates.md) for every file written.

### State

9. The orchestrator NEVER reads/writes state JSON directly — always use state agents.
10. Worker agents NEVER update state — they report back, and the orchestrator uses state agents.

## Prerequisites

- Run everything inside the nix devshell (`direnv` loads it automatically), which provides `git` and `jq`
- The current branch must have commits ahead of the base branch
