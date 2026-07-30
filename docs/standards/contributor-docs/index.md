---
id: contributor-docs
title: Contributor Documentation
---

# Contributor Documentation

Contributor docs are a technical map of a repository. They exist so that a new contributor -- human or LLM -- can understand the codebase without reading every file.

This article defines what contributor docs contain, how they are structured, and how to write them. The [generation workflow](./workflow.md) is the executable half of this standard: it describes the phases, agents, and state machine that produce the docs. If this repository ever grows a `/contributor-docs` trigger, that trigger stays thin and points here.

Generated docs live under `docs/contributor/` in this repository. The standard itself (this tree) lives under `docs/standards/contributor-docs/` and is never generated.

---

## Goals

1. **Navigability.** A contributor should find any concept, feature, or API surface within two clicks from the overview.
2. **AI-friendliness.** LLMs should be able to read frontmatter alone and decide which files to read in full.
3. **No duplication.** Each idea lives in exactly one file. Other files link to it.
4. **Maintainability.** Adding a feature means adding a feature file and optionally a concept or algorithm file. Nothing else needs rewriting.

## What Gets Documented

Not everything in a codebase deserves documentation. The workflow uses these heuristics to decide:

| Category      | Heuristic                                                                        | Example                                                             |
| ------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **Feature**   | Any noteworthy capability worth documenting due to its mechanics                 | "Name derivation", "Terminal adapter ports"                         |
| **Concept**   | Explaining a feature requires >5 lines of background or "why"                    | "Ports and adapters vs direct console calls"                        |
| **Algorithm** | Implementation has non-obvious complexity, rejected alternatives, or workarounds | "Changelog diffing for release notes"                               |
| **Surface**   | Any external interface                                                           | `fy --version`, a daemon HTTP route                                 |
| **ADR**       | Any choice where a reasonable person could have chosen differently               | "Compile a standalone binary instead of shipping a Node entrypoint" |

See [classification.md](./classification.md) for detailed heuristics and examples.

---

## Section Types

Contributor docs use five content types, each with a distinct role:

### Features

The "what." Describes any noteworthy capability in the codebase -- anything with interesting mechanics worth commenting on. This is contributor documentation, not user documentation, so features don't need to be user-visible. Internal mechanisms like name derivation, dependency wiring, or compile-time bundling are all features. Features are the hub -- they link outward to concepts, algorithms, and surfaces. Features never explain "why" inline; they defer to concepts.

### Concepts

The "why." Background knowledge, design rationale, comparisons. Concepts come in four types:

| Type         | Purpose                           | Example                          |
| ------------ | --------------------------------- | -------------------------------- |
| `comparison` | X vs Y tradeoff analysis          | "Compiled binary vs npm install" |
| `flow`       | End-to-end process description    | "Tag-to-published-release flow"  |
| `design`     | Architectural pattern explanation | "Three-layer architecture"       |
| `prereq`     | Required background knowledge     | "Conventional commit basics"     |

Concepts can exist independently of features. Common standalone concepts include comparisons, flows, and prerequisites.

### Algorithms

The "how and why it's complicated." Documents non-trivial logic -- not step-by-step pseudocode, but the approach, the alternatives considered, the roadblocks hit, and why the current approach was chosen. The emphasis is on the reasoning, not the code.

### Surfaces

The "interface." One file per endpoint, CLI command, SDK method, or event. Contains request/response schemas, status codes, authentication requirements.

### Architecture Decision Records (ADRs)

The "we chose X because." Numbered and dated records of significant architectural choices. ADRs capture context, options considered, the decision, and consequences.

---

## Module Organization

Content is grouped by **modules** -- bounded contexts that represent the major chunks of the system (see [Domain-Driven Design](../domain-driven-design/index.md) for what makes a boundary real). Each module has:

- An **overview** explaining its purpose and boundaries
- Section folders (features, concepts, algorithms, surfaces) containing the actual content
- **Index files** in each section folder that map how items relate to each other

Cross-module content (concepts and algorithms that span multiple modules) lives in a `shared/` directory.

In this repository, modules usually track a real subsystem rather than a workspace package -- for example the terminal adapter ports, the release pipeline, or the nix toolchain. Package boundaries are a starting hint, not the rule.

---

## Detailed Reference

- [Structure](./structure.md) -- Folder layout and file organization
- [Frontmatter](./frontmatter.md) -- YAML frontmatter schemas for all section types
- [Checklist](./checklist.md) -- Formatting rules and quality checklist
- [Classification](./classification.md) -- Heuristics for deciding what goes where
- [Workflow](./workflow.md) -- How the docs get generated
