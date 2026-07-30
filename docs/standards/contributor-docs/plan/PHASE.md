---
id: contributor-docs-plan-phase
title: 'Contributor Docs: Plan Phase'
---

# Phase 1: Plan

## State Machine

```text
[diff_analysis] → [classify] → [review] → completed
   worker(S)       worker(O)     inline
```

## State File: `plan-state.json`

```json
{
  "step": "diff_analysis | classify | review | completed",
  "diffSummaryReady": false,
  "planFile": null,
  "reviewFeedback": null,
  "approved": false
}
```

## Step Dispatch

| Step            | Agent         | Model  | Type   | File                    | Description                        |
| --------------- | ------------- | ------ | ------ | ----------------------- | ---------------------------------- |
| `diff_analysis` | diff-analyzer | sonnet | worker | `plan/diff-analysis.md` | Read git diff, catalog all changes |
| `classify`      | doc-planner   | opus   | worker | `plan/classify.md`      | Classify changes, build doc plan   |
| `review`        | —             | —      | inline | `plan/review.md`        | Present plan to user for approval  |

## Step Dispatch Logic

On entry, spawn the plan state agent to assess. **NEVER read step files directly** — spawn a worker agent and tell it which step file to read. Exception: `review` is inline.

| Condition               | Action                                                                      |
| ----------------------- | --------------------------------------------------------------------------- |
| No `plan-state.json`    | Create via state agent with `step: "diff_analysis"`, spawn diff-analyzer    |
| `step: "diff_analysis"` | Spawn diff-analyzer (sonnet) — tell it to read `plan/diff-analysis.md`      |
| `step: "classify"`      | Spawn doc-planner (opus) — tell it to read `plan/classify.md`               |
| `step: "review"`        | **Inline**: read `plan/review.md`, present the plan to the user             |
| `step: "completed"`     | Phase done — advance `task-state.currentPhase` to `"write"` via state agent |

## State Transitions

All state writes go through the **plan state agent**. Read `plan/state-agent.md` for the protocol.

**Bootstrap exceptions:** None.

## Review Loop

If the user rejects the plan:

1. The state agent captures feedback in `reviewFeedback`
2. The state agent sets `step` back to `"classify"`
3. Re-spawn doc-planner with the feedback

The loop continues until approved.

## Phase Completion

When approved:

1. The state agent updates `task-state.json`: `currentPhase: "write"`, `planFile: ".contributor-docs/doc-plan.yaml"`
2. Proceed to the write phase
