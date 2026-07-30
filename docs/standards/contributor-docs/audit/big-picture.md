---
id: contributor-docs-audit-big-picture
title: 'Contributor Docs: Big Picture Audit Step'
---

# Big Picture Audit — Worker Agent (Opus)

## Agent Context

- Working directory: repository root
- Doc plan: `.contributor-docs/doc-plan.yaml`
- Docs root: from the `docsRoot` field in `task-state.json`
- Docs references:
  - `docs/standards/contributor-docs/structure.md` — expected folder structure
  - `docs/standards/contributor-docs/checklist.md` — formatting rules

## Agent Report Format

```text
RESULT: <success|error>
ISSUES_FOUND: <count>
REPORT_FILE: .contributor-docs/big-picture-report.md
ERROR: <error message if any>
```

**Do NOT update state files.** Report back to the orchestrator only.

## Task

Perform a holistic audit of the generated documentation. Read all doc files at a high level (frontmatter + H2 headings + the first paragraph per section). Check structural coherence, coverage, cross-references, and terminology. Write a report.

## What to Check

### 1. Structural Coherence

- Do modules represent clean bounded contexts?
- Are there files that should be in a different module?
- Are there modules that should be merged or split?

### 2. Coverage

- Does every capability identified in `.contributor-docs/diff-summary.md` have corresponding documentation?
- Are there obvious gaps (for example, a feature with no concept explaining its "why")?
- Do features with complex logic have corresponding algorithm docs?

### 3. Cross-Reference Integrity

- Do all `related`, `concepts`, `algorithms`, `surfaces` paths in frontmatter resolve to real files?
- Do all inline `[text](path)` links resolve to real files?
- Are there orphan files not linked from any index or other file?
- Are cross-links bidirectional where appropriate?

### 4. Terminology Consistency

- Is the same concept called the same name across all files?
- Do module overviews establish terminology that features and concepts follow?

### 5. Navigation Completeness

- Can every file be reached from `00-overview.md` through links and indexes?
- Does every module have an overview file?
- Do all section directories have an index file?

### 6. Index Completeness

- Does every file in each directory appear in its corresponding index?
- Are index groupings logical?

## Steps

### 1. Read All Files (High Level)

For each doc file under the docs root:

1. Read the full frontmatter
2. Read the H2 headings
3. Read the first paragraph after each H2

Do NOT read full file content. Focus on structure and metadata.

### 2. Read the Plan

Read `.contributor-docs/doc-plan.yaml` and `.contributor-docs/diff-summary.md` for what was planned vs what was built.

### 3. Run Each Check

Evaluate each of the 6 check categories above. For each issue found, record:

- **Category**: which check (structural, coverage, cross-ref, terminology, navigation, index)
- **Severity**: error (must fix) or warning (should fix)
- **File(s)**: affected file path(s)
- **Description**: what the issue is and how to fix it

### 4. Write Report

Write `.contributor-docs/big-picture-report.md`:

```markdown
# Big Picture Audit Report

## Summary

- Errors: <count>
- Warnings: <count>
- Files audited: <count>

## Issues

### Errors

#### 1. <description>

- **Category**: <category>
- **File(s)**: <paths>
- **Fix**: <how to fix>

### Warnings

#### 1. <description>

- **Category**: <category>
- **File(s)**: <paths>
- **Fix**: <how to fix>

## Pass

- <list of checks that passed cleanly>
```

### 5. Report

Report the result with the issue count and report file path.

## Resumability

- If `.contributor-docs/big-picture-report.md` already exists: report success with the existing issue count
- If not: start from Step 1

## Important

- Do NOT update state files
- Do NOT fix any issues — only report them
- Do NOT read full file content — stick to frontmatter + H2 headings + first paragraphs
- Do NOT read source code — that's the fact-checker's job
