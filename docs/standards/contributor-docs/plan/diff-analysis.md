---
id: contributor-docs-plan-diff-analysis
title: 'Contributor Docs: Diff Analysis Step'
---

# Diff Analysis — Worker Agent (Sonnet)

## Agent Context

- Working directory: repository root
- Base branch: {baseBranch} (from task-state.json)
- Docs reference: read `docs/standards/contributor-docs/classification.md` for classification heuristics

## Agent Report Format

```text
RESULT: <success|error>
CHANGED_FILES: <count>
DIFF_SUMMARY: .contributor-docs/diff-summary.md
ERROR: <error message if any>
```

**Do NOT update state files.** Report back to the orchestrator only.

## Task

Analyze all commits on the current branch relative to the base branch. Produce a structured summary of what was built, organized for documentation planning.

## Steps

### 1. Get the Diff

Run `git diff <baseBranch>...HEAD --name-status` to get the list of changed files.
Run `git log <baseBranch>..HEAD --oneline` to get the commit history.

### 2. Read Changed Files

Read the content of all added and modified files. For large files (>500 lines), read the first 200 lines and the file's exports/public API.

Skip files that carry no documentable behavior: lockfiles, generated files (for example the generated pre-commit config), formatter output, and snapshot fixtures.

### 3. Catalog Changes

For each meaningful change, record:

- **File path** and what it does
- **Category hint** (likely feature? concept? surface? internal?)
- **Complexity** (trivial, moderate, complex)
- **Dependencies** (what other changed files does it relate to?)

Use the classification heuristics from the docs reference. Remember: features are any noteworthy capability with interesting mechanics, not just user-visible behavior.

### 4. Write Summary

Write `.contributor-docs/diff-summary.md`:

```markdown
# Diff Summary

## Commits

- <commit list>

## Changed Files

- <file list with categories>

## Identified Capabilities

### <Capability Name>

- Files: <list>
- Category hint: feature/concept/algorithm/surface
- Complexity: trivial/moderate/complex
- Notes: <relevant context>

## Potential Modules

- <module name>: <files that belong to it>

## Cross-Cutting Concerns

- <items that span multiple modules>
```

### 5. Report

Report the result with the file count and summary path.

## Resumability

- Check if `.contributor-docs/diff-summary.md` already exists
- If yes: verify it's up-to-date with the current diff, report success
- If no: start from Step 1

## Important

- Do NOT update state files
- Do NOT classify changes into final doc types — that's the planner's job
- Do NOT create documentation files — only the diff summary
