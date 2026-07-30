---
id: contributor-docs-audit-fact-check
title: 'Contributor Docs: Fact Check Step'
---

# Fact Check — Worker Agent (Sonnet)

## Agent Context

- Working directory: repository root
- Doc file to check: {filePath} (from the orchestrator)
- Source files: {sources} (from doc-plan.yaml, provided by the orchestrator)
- Output dir: `.contributor-docs/fact-check/findings/`
- Docs reference: `docs/standards/contributor-docs/checklist.md` — formatting rules

## Agent Report Format

```text
RESULT: <success|error>
FILE: <doc file checked>
ISSUES_FOUND: <count>
FINDINGS_FILE: <path to findings file>
ERROR: <error message if any>
```

**Do NOT update state files.** Report back to the orchestrator only.

## Task

Check a single documentation file against its source code for accuracy, completeness, and formatting compliance. Write findings to the output directory.

## Steps

### 1. Read the Doc File

Read {filePath} completely — frontmatter and full body content.

### 2. Read the Source Code

Read all files listed in {sources}. These are the implementation files that this doc describes.

For large files (>500 lines), focus on:

- Exports / public API
- Key functions, their signatures, and inline comments
- Types and interfaces
- Error handling patterns

### 3. Check Accuracy

Compare doc claims against source code:

- **Function/method names**: does the doc reference correct names?
- **Parameter types**: do documented types match the code?
- **Behavior descriptions**: does the doc accurately describe what the code does?
- **Code examples**: are inline code snippets correct and runnable?
- **Configuration values**: are defaults, env vars, and config keys accurate?
- **Commands**: do quoted commands, tasks, and script paths actually exist?
- **Error handling**: are documented error cases real?
- **Derived names**: where the doc explains wiring, does it describe the product and binary names as derived rather than hardcoded?

### 4. Check Completeness

Compare source code capabilities against doc coverage:

- **Missing behaviors**: does the source code have significant behavior not documented?
- **Missing edge cases**: are important edge cases or error paths skipped?
- **Missing configuration**: are there configurable options not documented?

### 5. Check Staleness

Look for docs describing things that don't exist:

- **Removed functionality**: does the doc describe features/APIs not in the source?
- **Renamed items**: does the doc use old names for renamed functions/types?
- **Changed behavior**: does the doc describe behavior that differs from the current code?

### 6. Check Formatting

Run through the formatting checklist:

- [ ] All code blocks have a language specified
- [ ] All diagrams use Mermaid
- [ ] Headers follow the expected template structure for this section type
- [ ] The file does not exceed ~300 lines
- [ ] No inline explanation of content that should be in a linked file
- [ ] Cross-reference links use correct relative paths

### 7. Write Findings

Derive the findings filename from the doc file path (replace `/` with `__`).

Write to `.contributor-docs/fact-check/findings/<findings-filename>`:

```markdown
# Fact Check: {filePath}

## Summary

- Accuracy issues: <count>
- Completeness issues: <count>
- Staleness issues: <count>
- Formatting issues: <count>
- Total: <count>

## Issues

### 1. <title>

- **Type**: accuracy | completeness | staleness | formatting
- **Severity**: error | warning
- **Location**: <line number or section in the doc>
- **Source**: <source file and line if applicable>
- **Description**: <what's wrong>
- **Fix**: <how to fix>

## Clean

- <list of checks that passed>
```

If no issues are found, write a findings file with `Total: 0` and a `## Clean` section listing all passed checks.

### 8. Report

Report the result with the issue count and findings file path.

## Important

- Do NOT update state files
- Do NOT fix any issues — only report them
- Do NOT read other doc files — only the one assigned file and its source code
- Do NOT modify the doc file or the source code
- Every file gets a findings file, even if clean (for completeness tracking)
