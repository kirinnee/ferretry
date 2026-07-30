---
id: contributor-docs-plan-review
title: 'Contributor Docs: Review Step'
---

# Review Plan — Inline Step

This step runs inline (not delegated) because it requires user interaction.

## Task

Present the documentation plan to the user for review and approval.

## Steps

### 1. Read the Plan

Read `.contributor-docs/doc-plan.yaml`.

### 2. Present Summary

Display a structured summary to the user:

```text
## Documentation Plan

### Modules
- <module name>: <description> (<N> features, <N> concepts, <N> algorithms, <N> surfaces)

### Shared
- <N> cross-cutting concepts
- <N> cross-cutting algorithms

### Architecture Decisions
- <N> ADRs

### Top-Level Files
- 00-overview.md
- 01-architecture/index.md
- 02-modules.md
- 03-development/ (<N> files)

### Total: <N> files across <N> tiers
```

### 3. Ask for Approval

Ask the user a single, direct question:

- "Does this documentation plan look correct?"
- Options: "Approve", "Revise" (with a field for feedback)

### 4. Handle Response

If approved:

- Via the state agent: update the plan state with `approved: true`, `step: "completed"`

If revise:

- Capture the user's feedback
- Via the state agent: update the plan state with `reviewFeedback: "<feedback>"`, `step: "classify"`

## Important

- This step MUST be inline — it requires user interaction
- Do NOT proceed to write without user approval
- The plan can go through multiple review cycles
- Use the state agent for ALL state updates
