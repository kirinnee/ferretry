---
id: contributor-docs-plan-classify
title: 'Contributor Docs: Classify Step'
---

# Classify Changes — Worker Agent (Opus)

## Agent Context

- Working directory: repository root
- Diff summary: `.contributor-docs/diff-summary.md`
- Previous feedback (if re-running): {reviewFeedback} from plan-state.json
- Docs references:
  - `docs/standards/contributor-docs/classification.md` — classification heuristics
  - `docs/standards/contributor-docs/structure.md` — folder structure
  - `docs/standards/contributor-docs/frontmatter.md` — frontmatter schemas

## Agent Report Format

```text
RESULT: <success|error>
PLAN_FILE: .contributor-docs/doc-plan.yaml
MODULES: <count>
FEATURES: <count>
CONCEPTS: <count>
ALGORITHMS: <count>
SURFACES: <count>
ADRS: <count>
ERROR: <error message if any>
```

**Do NOT update state files.** Report back to the orchestrator only.

## Task

Read the diff summary and classify every identified capability into doc types. Group into modules. Map cross-links. Output a complete documentation plan as YAML.

## Steps

### 1. Read Inputs

Read `.contributor-docs/diff-summary.md` for the analysis.
Read the classification heuristics, structure, and frontmatter docs.
If `reviewFeedback` is provided, read it and adjust accordingly.

### 2. Identify Modules

Group related capabilities into bounded contexts. Each module should own a clear domain. Workspace package boundaries are a hint, not the answer — a module may span packages, and one package may hold several modules.

### 3. Classify Each Capability

For each identified capability:

1. Determine the primary doc type (feature, concept, algorithm, surface, ADR)
2. Determine secondary docs needed (does a feature also need a concept? algorithm? surfaces?)
3. Assign to a module (or `shared/` if cross-cutting)
4. Write a 1-2 line description of what the file will contain
5. List the source files relevant to this doc

### 4. Map Cross-Links

For each planned doc file, identify:

- Which concepts it needs (for features)
- Which algorithms it uses (for features)
- Which surfaces expose it (for features)
- What it's related to (for concepts, algorithms, surfaces)

### 5. Assign Writing Tiers

Group files per [writing-order.md](../common/writing-order.md):

- Tier 1: overviews, ADRs, development docs
- Tier 2: concepts
- Tier 3: algorithms
- Tier 4: features
- Tier 5: surfaces
- Tier 6: index files

### 6. Write Plan File

Write `.contributor-docs/doc-plan.yaml`:

```yaml
docsRoot: docs/contributor
modules:
  - name: terminal-adapters
    description: 'Injected terminal ports and their concrete implementations'
    files:
      - path: terminal-adapters/overview.md
        type: module-overview
        tier: 1
        description: 'Overview of the terminal adapter module'
        sources: [packages/cli/src/adapters/terminal/]
      - path: terminal-adapters/features/spinner-port.md
        type: feature
        tier: 4
        description: 'Spinner behavior behind an injected port'
        sources: [packages/cli/src/adapters/terminal/spinner.ts]
        crossLinks:
          concepts: [terminal-adapters/concepts/ports-vs-direct-console.md]
          algorithms: []
          surfaces: []
        tags: [terminal, di]
      - path: terminal-adapters/concepts/ports-vs-direct-console.md
        type: concept
        conceptType: comparison
        tier: 2
        description: 'Why terminal IO goes through ports instead of direct console calls'
        sources: [packages/cli/src/adapters/terminal/console-io.ts]
        tags: [terminal, di]

shared:
  files:
    - path: shared/concepts/name-derivation.md
      type: concept
      conceptType: design
      tier: 2
      description: 'Single source of truth for the product and binary names'
      sources: [scripts/local/rename.sh]
      tags: [build]

topLevel:
  - path: 00-overview.md
    tier: 1
    description: 'Project overview'
  - path: 01-architecture/index.md
    tier: 1
    description: 'Architecture overview'
  - path: 02-modules.md
    tier: 1
    description: 'Module map'
  - path: 03-development/index.md
    tier: 1
    description: 'Development setup'
  - path: 03-development/folder-structure.md
    tier: 1
    description: 'Repository folder structure'
  - path: 03-development/commands.md
    tier: 1
    description: 'Available task commands'

adrs:
  - path: 01-architecture/adr-001-compile-standalone-binary.md
    tier: 1
    description: 'Decision to ship a compiled standalone binary'
    sources: [scripts/release/compile.sh]
    tags: [release, architecture]

indexes:
  - path: terminal-adapters/features/index.md
    tier: 6
  - path: terminal-adapters/concepts/index.md
    tier: 6
```

### 7. Report

Report the result with counts per doc type.

## Resumability

- If `.contributor-docs/doc-plan.yaml` exists and there is no reviewFeedback: report success
- If reviewFeedback is present: re-read and revise the plan
- If there is no plan: start from Step 1

## Important

- Do NOT update state files
- Do NOT create documentation files — only the plan YAML
- Do NOT scaffold files — that's the next phase
