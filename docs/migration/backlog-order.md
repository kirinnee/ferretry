# Backlog orchestration order

The 48 items in `handover.md` are not independent. This records the order they should be worked in
and why, so the next person — or the next agent — does not pick items at random and stall on a hard
dependency.

Derived from the `🔒 Hard` column. An item's **unblock count** is how many other items name it as a
hard dependency.

## Wave 1 — the roots

These have no hard dependency of their own and between them gate most of the board.

|   Item | Title                             |                     Hard-blocks | Why it is first                                                                                                                                                                                       |
| -----: | --------------------------------- | ------------------------------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **16** | One reference standard everywhere | **5** (#33, #39, #43, #63, #64) | The single biggest root. References are how a human and an agent name the same thing — a file, a task, a pin, a browser tab, a terminal. Five features are waiting on the grammar being settled once. |
| **48** | Harden cross-harness migration    |        **3** (#44 ✅, #47, #67) | Migration safety underpins warden recovery policy and conversation forking.                                                                                                                           |
| **13** | Analytics ingestion               |           **3** (#28, #42, #66) | Nothing about cost or analytics can be trusted until ingestion is right.                                                                                                                              |
| **35** | Unified side-pane tabs            |                **2** (#36, #37) | Also soft-linked to nine others; it is the shell every pane lives in.                                                                                                                                 |
| **10** | Four attention kinds              |                **2** (#17, #40) | The attention model the modal and swipe actions build on.                                                                                                                                             |

Also root-level, gating one item each: **#6** (→ #37), **#15** (→ #38), **#11** (→ #8),
**#31** (→ #68), **#34** + #16 (→ #64), **#69** + #31 (→ #68).

## Wave 2 — unlocked by wave 1

`#33`, `#39`, `#43`, `#63`, `#64` after #16 · `#47`, `#67` after #48 · `#28`, `#42`, `#66` after
#13 · `#36`, `#37` after #35 · `#17`, `#40` after #10 · `#38` after #15 · `#8` after #11 ·
`#65` after #39 · `#68` after #31 and #69.

## Wave 3 — no hard dependencies, schedulable any time

`#3`, `#4`, `#5`, `#7`, `#9`, `#12`, `#14`, `#18`, `#20`, `#23`, `#26`, `#29`, `#30`, `#32`, `#41`,
`#45`, `#49`, `#62`. Useful filler when a wave-1 unit is blocked or an account frees up.

## Already done

**#44 Reap terminal tmux sessions** — PR #156. Exact registered panes only, refuses on a recycled
pane id, refuses when two records disagree, and kills nothing at all with an empty registry.

## How to use this

Work wave 1 concurrently — the roots do not depend on each other. Do not start a wave-2 item before
its root has merged; the hard dependency is real and starting early produces a rebase, not progress.

Several items only make sense together and should be one unit, not four: **#64 with #34, #35 and
#41** is the addressable co-control feature — stable session-scoped references for every browser tab
and terminal, agent-driven with live human takeover. Splitting those produces four half-features.
