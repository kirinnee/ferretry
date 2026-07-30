---
id: contributor-docs-structure
title: Contributor Docs Structure
---

# Contributor Docs Structure

The folder layout for contributor documentation. All files use the `.md` extension so they render directly on GitHub, and all diagrams are Mermaid fenced blocks (also rendered by GitHub).

---

## Top-Level Structure

```text
docs/contributor/
├── 00-overview.md               # Project intro, manifest of all docs
├── 01-architecture/
│   ├── index.md                 # Architecture overview, diagrams
│   └── adr-NNN-<decision>.md    # Individual ADRs (numbered, dated)
├── 02-modules.md                # Module map: names, boundaries, relationships
├── 03-development/
│   ├── index.md                 # Dev setup, workflow overview
│   ├── folder-structure.md      # Repo layout explanation
│   └── commands.md              # Task surface (`task --list`)
├── <module-name>/               # One folder per module
│   ├── overview.md
│   ├── features/
│   │   ├── index.md
│   │   └── <feature>.md
│   ├── concepts/
│   │   ├── index.md
│   │   └── <concept>.md
│   ├── algorithms/
│   │   ├── index.md
│   │   └── <algorithm>.md
│   └── surfaces/
│       ├── index.md
│       └── <surface>.md
└── shared/                      # Cross-module content
    ├── concepts/
    │   ├── index.md
    │   └── <concept>.md
    └── algorithms/
        ├── index.md
        └── <algorithm>.md
```

---

## File Roles

### Top-Level Files

| File                           | Role                                                                                      |
| ------------------------------ | ----------------------------------------------------------------------------------------- |
| `00-overview.md`               | Entry point. Project summary, tech stack, links to all modules. The LLM reads this first. |
| `01-architecture/index.md`     | High-level architecture: system diagram, component relationships, deployment topology.    |
| `01-architecture/adr-NNN-*.md` | Individual Architecture Decision Records. Numbered sequentially, dated.                   |
| `02-modules.md`                | Module map: lists all modules, their purpose, boundaries, and inter-module dependencies.  |
| `03-development/`              | Developer onboarding: folder structure, available commands, development workflow.         |

`03-development/commands.md` documents the real task surface from [Taskfile](../taskfile/index.md) — never a hand-maintained list that drifts from `task --list`.

### Per-Module Files

| File                   | Role                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------- |
| `overview.md`          | **Narrative**: what the module does, what it owns, what it doesn't. Links to key features and concepts. |
| `features/index.md`    | **Map**: groups features, shows relationships between them. Pure navigation.                            |
| `features/<name>.md`   | Individual feature: behavior, configuration, constraints. Links to concepts/algorithms/surfaces.        |
| `concepts/index.md`    | **Map**: groups concepts by type, shows how they relate.                                                |
| `concepts/<name>.md`   | Individual concept: context, explanation, decision (if applicable).                                     |
| `algorithms/index.md`  | **Map**: groups algorithms, shows which features use them.                                              |
| `algorithms/<name>.md` | Individual algorithm: problem, approach, why this way, trade-offs.                                      |
| `surfaces/index.md`    | **Map**: groups surfaces by type (API, CLI, SDK, event).                                                |
| `surfaces/<name>.md`   | Individual surface: endpoint/command details, request/response, errors.                                 |

### Overview vs Index

These serve different roles and must not overlap:

| File          | Role                                                      | Content Style        |
| ------------- | --------------------------------------------------------- | -------------------- |
| `overview.md` | **Narrative** -- tells the story of what the module is    | Paragraphs, diagrams |
| `*/index.md`  | **Map** -- shows what exists and how items group together | Lists, tables, links |

---

## Naming Conventions

- **Module folders**: kebab-case matching the bounded context name (e.g., `release-pipeline/`, `terminal-adapters/`)
- **Feature files**: kebab-case describing the capability (e.g., `name-derivation.md`, `binary-compilation.md`)
- **Concept files**: kebab-case, optionally prefixed by type (e.g., `compiled-binary-vs-npm.md`, `release-flow.md`)
- **Algorithm files**: kebab-case describing the algorithm (e.g., `changelog-diff-for-release-notes.md`)
- **Surface files**: kebab-case describing the endpoint/command (e.g., `version-flag.md`, `session-list.md`)
- **ADR files**: `adr-NNN-<kebab-case-title>.md` (e.g., `adr-001-compile-standalone-binary.md`)

---

## Section Folders Are Optional

Not every module needs all four section folders. Only create a section folder when the module has content for it:

- A thin pass-through module might only have `features/` and `surfaces/`
- A module with complex internals might have `algorithms/` but no `surfaces/`
- `concepts/` and `algorithms/` are only needed when there's something non-obvious to explain

---

## Cross-References

All cross-references use **relative Markdown paths**:

```markdown
See [Caching Concept](../concepts/cache-invalidation.md) for why we chose this approach.
```

Never use plain text names like "see the caching concept." Always link with a file path so both humans and LLMs can follow.
