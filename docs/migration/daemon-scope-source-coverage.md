---
id: daemon-scope-source-coverage
title: Daemon scoping — source coverage
---

# Daemon scoping — source coverage

Unit SCOPE was asked to make daemon scoping an enforced invariant rather than a thing every unit
remembers, and to check two surfaces the owner named: **learning** and **boards**.

The deliverable is [the contract](../standards/contracts/README.md#daemon-scoping). This document
records what was already correct, what the two surfaces actually are, and what is still missing.

## What "daemon-scoped" has to mean

A daemon's ids — session, task, pin, board — are unique only **within** the daemon that minted
them, and `daemonId` itself is **durable across a re-pair**: the same id can later name a new
endpoint and a new device grant (`packages/pwa/src/lib/daemon-connection.ts`). Two consequences
follow, and both are load-bearing:

- **Keys.** Anything the browser remembers about daemon-owned data is keyed by `(daemonId, …)`, or
  the second daemon reads the first daemon's answer.
- **Liveness.** Anything holding a credential compares the **whole connection** field by field, not
  the id, or the old pairing's late answer lands in the new one.

## Learning — already scoped, and carefully

The owner's note said learning "should be daemon-scoped too although the learning isn't there yet".
It is there, and it is scoped. This is reported as a result, not corrected as a bug.

| Source capability                                              | Ferretry path                                          | State                              |
| -------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------- |
| `ui/src/lib/learning-api.ts` — relative paths, global token    | `packages/pwa/src/lib/learning-api.ts`                 | PORTED, takes a `DaemonConnection` |
| `ui/src/pages/LearningPage.tsx` — proposals, evidence, actions | `packages/pwa/src/features/learning/learning-page.tsx` | PORTED, daemon-scoped              |
| `src/learning-aggregate.ts` — proposal mining                  | daemon side, outside this unit                         | not examined                       |

`LearningPage` does more than take a connection. It carries a **monotonic `scopeRef` epoch** that
advances on every `daemonId` change and is never reused, so an A→B→A round trip gives the second A a
fresh epoch and the first A's late settle — whose `daemonId` would match again — is still dropped
(`learning-page.tsx:74-110`). The epoch advances and the view clears **during render**, in the same
pass that sees the new id, so the new daemon never briefly paints the old one's proposals. Evidence
links are built as `/d/<daemonId>/session/<sessionId>`, so a quote cannot deep-link into another
daemon's session.

That is the strongest daemon fence in the bundle, and the reason the `retain` pass does not report
it: the state is React state under a component that receives a `DaemonConnection`, not module-scope
memory. The gate's `access` pass is what holds the transport half.

## Boards — the reading, from the source

The owner said boards should be daemon **and session** scoped. A shared board exists so that several
sessions collaborate on it, so it cannot simply be partitioned per session or it stops being shared.
Read against `modules/kteam-ts/src/task-boards.ts` and `packages/daemon/src/lib/task-boards/`, the
two words turn out to name two different things:

- **Daemon scoping is IDENTITY and OWNERSHIP.** A board lives in one daemon's state home, is minted
  by that daemon, and is serialized on a **daemon-global** queue because board ids are independently
  random (`task-boards.ts:191-193`). A `boardId`, like every other id, means nothing outside the
  daemon that minted it. A browser holding two pairings must key a board by `(daemonId, boardId)`.

- **Session scoping is MEMBERSHIP and AUTHORIZATION, not partition.** A session's relationship to a
  board is a **grant**: `TaskBoardGrant` carries `sessionId`, `sessionIncarnation`,
  `runtimeGeneration`, a `role`, and an explicit `allowedActions` list; `TaskBoardBinding` binds one
  session to one board — "a session may have only one board binding" (`task-boards.ts:194-196`) —
  and `packages/daemon/src/lib/task-boards/policy.ts` derives what each role may do. Sessions look
  at the **same** board through different permissions; they do not each get a copy.

So: **a board belongs to a daemon; a session's relationship to it is membership and visibility.**
If that reading is wrong, it is wrong in one line and everything below changes with it.

The incarnation and generation fields on a grant are the session-side equivalent of the connection
comparison above: a session id alone is not a liveness test, because a restarted session reuses it.
PR #212 hardened the membership handover for the same reason.

## Boards — what Ferretry actually carries today

| Source capability                                                      | Ferretry path                                         | State                                              |
| ---------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------- |
| `src/task-boards.ts` — board creation, grants, bindings, invitations   | `packages/daemon/src/lib/task-boards/`                | PORTED (daemon side)                               |
| `ui/src/lib/tasks.ts` — lane meta, workflow labels, `&F12` sigil       | `packages/pwa/src/features/tasks/task-board-model.ts` | PORTED                                             |
| `ui/src/lib/tasks.ts` — lane grouping, ordering, conflicts             | `packages/pwa/src/features/tasks/task-projections.ts` | PORTED, pure functions over a caller-fetched array |
| A PWA client that FETCHES tasks or boards                              | —                                                     | **GAP**                                            |
| A PWA surface carrying `boardId`, membership, role, or allowed actions | —                                                     | **GAP**                                            |

**The PWA has no board transport and no board identity.** `task-projections.ts` is explicit that it
holds no module-level state to key by `DaemonId` because it is pure passes over an array "the caller
already fetched through a `(daemonId, …)`-scoped client" — and no such client exists in
`packages/pwa/src`. Nothing in the bundle calls a task or board route.

That means there is nothing to make daemon-and-session scoped yet, and inventing a scope primitive
for a client that does not exist would fail the reachability gate for good reason. What this unit
can do instead is make the scope **unforgettable when the client is written**: a board client that
retains anything by `boardId` alone, or fetches without a `DaemonConnection`, now fails
`scripts/validate/daemon-scope.sh` before it can be committed.

The **boards a reader can see today** — the pins board
(`packages/pwa/src/features/pins/pins-board.tsx`) and the attention board
(`packages/pwa/src/features/attention/attention-board.tsx`) — both take a `DaemonConnection` and are
correctly scoped. Neither is mounted: `DaemonPinClient` and `DaemonAttentionClient` have no
construction site in `packages/pwa/src`, which the gate records as a GAP in
`scripts/validate/daemon-scope-allowlist.txt` rather than as a passing surface.

## The defect the gate found

`DaemonDraftStore` was a module default inside `composer.tsx`, which made it the one daemon-scoped
store in the bundle the connection registry could not reach: `clearDaemon` existed, was tested, and
was called by nothing. Unpairing a daemon left that daemon's drafts in `localStorage` under
`fy-drafts-v1`, where the next pairing to mint the same daemon id would read them back — and minting
the same id is exactly what a re-pair does. The store now lives in `packages/pwa/src/lib/drafts.ts`
and is registered in `createAppStore`.

## Still missing

- **A task/board client for the PWA.** Projections, lane vocabulary, references and the DAG are all
  ported; the transport is not. Until it exists the task surfaces render only what a host hands them,
  and no host fetches anything.
- **Board membership in the UI.** No surface shows a board's coordinator, a session's role, or its
  allowed actions, so a reader cannot see who may do what on a shared board.
- **Four unmounted daemon-scoped stores** — `DaemonPinClient`, `DaemonAttentionClient`,
  `DaemonBrowserLoginStore`, `DaemonRuntimeModelCatalogStore`. Each is listed in the allowlist with
  its blocker, and each line must be deleted by the change that mounts it.
