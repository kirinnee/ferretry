---
id: contributor-docs-frontmatter
title: Frontmatter Schemas
---

# Frontmatter Schemas

Every contributor doc file starts with YAML frontmatter. Frontmatter serves two purposes: structured metadata for tooling and a quick-scan summary for LLMs that can decide whether to read the full file.

These schemas apply to generated contributor docs under `docs/contributor/`. Hand-authored doctrine under `docs/standards/` follows its own minimal convention and does not use them.

---

## Features

```yaml
---
title: 'Feature Name'
description: 'One-line summary of what this feature does'
date: 2026-07-30
status: draft # draft | stable | deprecated
tags: [release, compile]
concepts: # Paths to concept files this feature relies on
  - ../concepts/compiled-binary-vs-npm.md
algorithms: # Paths to algorithm files this feature uses
  - ../algorithms/changelog-diff-for-release-notes.md
surfaces: # Paths to surface files that expose this feature
  - ../surfaces/version-flag.md
---
```

Features are the **hub** -- they link outward to concepts, algorithms, and surfaces using dedicated fields. This creates a clear navigation direction: start at a feature, fan out to details.

---

## Concepts

```yaml
---
title: 'Concept Name'
description: 'One-line summary'
date: 2026-07-30
status: stable # draft | stable | deprecated
type: comparison # comparison | flow | design | prereq
tags: [architecture, testing]
related: # Paths to any related files (concepts, algorithms, etc.)
  - ../concepts/ports-and-adapters.md
  - ../algorithms/driver-selection.md
---
```

The `type` field categorizes the concept:

| Type         | Use When                                                       |
| ------------ | -------------------------------------------------------------- |
| `comparison` | Evaluating X vs Y, with a comparison table                     |
| `flow`       | Describing an end-to-end process                               |
| `design`     | Explaining an architectural pattern or design decision         |
| `prereq`     | Providing background knowledge needed to understand other docs |

---

## Algorithms

```yaml
---
title: 'Algorithm Name'
description: 'One-line summary of what this algorithm accomplishes'
date: 2026-07-30
status: stable # draft | stable | deprecated
tags: [release, packaging]
related:
  - ../concepts/release-flow.md
  - ../algorithms/artifact-ordering.md
---
```

---

## Surfaces

```yaml
---
title: 'Surface Name'
description: 'One-line summary'
date: 2026-07-30
status: stable # draft | stable | deprecated
type: cli # api | cli | sdk | event
command: fy --version # CLI surfaces only
method: GET # API surfaces only
path: /v1/sessions/:id # API surfaces only
tags: [cli, version]
related:
  - ../surfaces/help-flag.md
---
```

Type-specific fields:

| Surface Type | Extra Fields                              |
| ------------ | ----------------------------------------- |
| `api`        | `method` (HTTP method), `path` (URL path) |
| `cli`        | `command` (CLI command string)            |
| `sdk`        | None (describe in body)                   |
| `event`      | None (describe in body)                   |

Write the binary name literally in the `command` field of a surface doc -- prose can name the
current binary. Code, scripts, and tests must still derive it, never hardcode it.

---

## ADRs

```yaml
---
title: 'ADR-001: Decision Title'
description: 'One-line summary of the decision'
date: 2026-07-30
status: accepted # proposed | accepted | superseded | deprecated
superseded_by: adr-003-<decision>.md # Only if status is superseded
tags: [release, packaging]
related:
  - adr-001-compile-standalone-binary.md
---
```

---

## Module Overviews

```yaml
---
title: 'Module Name'
description: 'One-line summary of what this module owns'
---
```

Module overviews use minimal frontmatter since their role is narrative, not linkable metadata.

---

## Index Files

```yaml
---
title: 'Module X -- Features'
description: 'Feature map for Module X'
---
```

Index files also use minimal frontmatter.

---

## Design Principles

1. **Features are the hub.** They use dedicated `concepts`, `algorithms`, `surfaces` fields. Everything else uses generic `related`.
2. **No `module` field.** The folder path encodes the module. Duplicating it in frontmatter creates drift.
3. **`related` is generic.** Concepts can link to algorithms, algorithms to concepts, surfaces to surfaces. No type restriction.
4. **`tags` is freeform.** No controlled vocabulary at the schema level. When writing docs, reuse existing tags from sibling files to keep them consistent.
5. **`status` is universal.** All content types support `draft | stable | deprecated` to track lifecycle.
