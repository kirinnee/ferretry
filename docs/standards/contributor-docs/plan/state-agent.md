---
id: contributor-docs-plan-state-agent
title: 'Contributor Docs: Plan State Agent'
---

# Plan State Agent — Sub-Agent (Haiku)

**Sub-agent. Stateless.** Returns its result directly to the orchestrator.

Manages state transitions for the Plan phase. The orchestrator NEVER reads/writes state JSON directly — this agent handles all state operations.

## Agent Context

- Working directory: repository root
- State files: `.contributor-docs/plan-state.json`, `.contributor-docs/task-state.json`
- Mode: {assess|update}

## Mode 1: Assess (determine current state)

When prompted: "Assess plan phase state"

### Procedure

1. Read `.contributor-docs/plan-state.json` (if it exists)
2. Read `.contributor-docs/task-state.json` for shared context
3. Check if `.contributor-docs/diff-summary.md` exists
4. Check if `.contributor-docs/doc-plan.yaml` exists
5. Report the current state

### Report Format

```text
CURRENT_STEP: <step from plan-state.json>
CONTEXT:
- diffSummaryReady: <true|false>
- planFile: <exists|absent>
- approved: <true|false>
- reviewFeedback: <present|absent>
```

## Mode 2: Update (write state)

When prompted: "Update plan state: {UPDATES_JSON}"

### Procedure

1. Read `.contributor-docs/plan-state.json`
2. Apply each field update from {UPDATES_JSON}
3. Write back to `.contributor-docs/plan-state.json`
4. If `step` changed, append a transition log line:
   ```bash
   echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) phase=plan from={old_step} to={new_step}" >>.contributor-docs/transitions.log
   ```
5. Report what changed

When prompted to update `task-state.json` (phase transitions only):

1. Read `.contributor-docs/task-state.json`
2. Apply the updates
3. Write back
4. Append a phase transition log line:
   ```bash
   echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) phase-transition from={old} to={new}" >>.contributor-docs/transitions.log
   ```

### Report Format

```text
RESULT: <updated|error>
FIELDS_UPDATED: <list>
NEW_STEP: <step value if changed>
ERROR: <error message if any>
```

### Validation Rules

- `step` must be one of: `diff_analysis`, `classify`, `review`, `completed`
- `diffSummaryReady` must be boolean
- `approved` must be boolean
- `planFile` must be a string path or null
- `reviewFeedback` must be a string or null

## Important

- Manage `plan-state.json` and `task-state.json` (phase transitions only)
- Do NOT execute any phase steps — just assess and update state
