---
id: contributor-docs-write-scaffold
title: 'Contributor Docs: Scaffold Step'
---

# Scaffold Files — Worker Agent (Sonnet)

## Agent Context

- Working directory: repository root
- Doc plan: `.contributor-docs/doc-plan.yaml`
- Docs references:
  - `docs/standards/contributor-docs/frontmatter.md` — frontmatter schemas
  - `docs/standards/contributor-docs/structure.md` — folder structure

## Agent Report Format

```text
RESULT: <success|error>
FILES_CREATED: <count>
DOCS_ROOT: <path>
ERROR: <error message if any>
```

**Do NOT update state files.** Report back to the orchestrator only.

## Task

Read the doc plan and create every planned file with frontmatter and a one-line summary. No body content. This ensures all cross-reference paths exist before any writing begins.

## Steps

### 1. Read Inputs

Read `.contributor-docs/doc-plan.yaml` for the complete file manifest.
Read the frontmatter schemas doc for the correct frontmatter per section type.
Read the structure doc for folder layout conventions.

### 2. Create Directory Structure

Create all necessary directories under the `docsRoot` specified in the plan:

```text
<docsRoot>/
├── 00-overview.md
├── 01-architecture/
├── 02-modules.md
├── 03-development/
├── <module-name>/
│   ├── features/
│   ├── concepts/
│   ├── algorithms/
│   └── surfaces/
└── shared/
    ├── concepts/
    └── algorithms/
```

### 3. Scaffold Each File

For each file in the plan (across `modules`, `shared`, `topLevel`, `adrs`, `indexes`):

1. Build the frontmatter from the plan entry + the frontmatter schema for its type
2. Write the file with frontmatter + a one-line summary (the `description` from the plan)
3. Do NOT write any body content beyond the one-line summary

Example scaffolded file:

```markdown
---
title: 'Name Derivation'
description: 'How the product and binary names are derived instead of hardcoded'
date: 2026-07-30
status: draft
type: design
tags: [build]
related: []
---

How the product and binary names are derived instead of hardcoded.
```

### 4. Verify Cross-References

After all files are created, verify that every path referenced in `crossLinks` across the plan resolves to an actual file on disk.

If any paths are missing, report them as warnings (they may indicate a plan error).

### 5. Report

Report the result with the total file count and docs root path.

## Resumability

- If all files from the plan already exist on disk with frontmatter: report success
- If some files exist: create only the missing ones, report
- If no files exist: start from Step 1

## Important

- Do NOT update state files
- Do NOT write body content — only frontmatter + a one-line summary
- Do NOT modify existing files that already have body content (beyond the one-line summary)
- Follow the frontmatter schemas exactly from the docs reference
- Never scaffold anything outside the plan's `docsRoot`
