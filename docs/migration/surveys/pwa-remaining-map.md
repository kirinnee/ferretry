# PWA remaining-work map

Audited 2026-08-01 against `${KTEAM_SRC}/ui/src`, `packages/pwa/src`, merged
PWA PR bodies, and `docs/migration/HANDOFF.md` §14. This is the **43
TypeScript/TSX files** that a basename-only survey reported as missing (17,215
LOC). Tests and CSS are intentionally outside this executable-source count.

`PORTED-AS` means the capability is present, often under a feature-oriented
name. `BLOCKED-ON-APP-ROOT` is reserved for work that needs the deliberately
absent PWA router/mount/bundler; it is not an empty-state claim. The public
PWA must continue to obtain every daemon URL and credential through runtime
pairing, and any resulting store/cache/subscription must remain daemon scoped.

| Source path                                      |   LOC | Disposition         | Ferretry path / evidence                                                                                                                                                                                             |
| ------------------------------------------------ | ----: | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/App.tsx`                                    |   465 | BLOCKED-ON-APP-ROOT | The router, pairing, retained pages and top-level composition have no PWA mount; deliberate decision recorded in `HANDOFF.md` §14.                                                                                   |
| `src/components/AnalyticsSurface.tsx`            |   282 | PORTED-AS           | `src/features/analytics/session-analytics-surface.tsx`, `session-analytics-query.ts`, and `analytics-api.ts` (PR #135).                                                                                              |
| `src/components/AttachmentImage.tsx`             |   420 | PORTED-AS           | `src/components/attachment-gallery.tsx` and `src/lib/attachment-source.ts` (PR #137).                                                                                                                                |
| `src/components/AttentionPanel.tsx`              | 1,003 | PORTED-AS           | `src/features/attention/attention-board.tsx` and `attention-api.ts`; daemon/session scope is explicit (PR #121).                                                                                                     |
| `src/components/Harness.tsx`                     |    48 | DROPPED             | Source-only development gallery; replaced by the PWA screenshot harness in PR #49 and explicitly dropped in PR #61.                                                                                                  |
| `src/components/PinSheet.tsx`                    |   971 | PORTED-AS           | `src/features/pins/pins-board.tsx` and `pins-trigger.tsx`, backed by daemon-scoped pin storage (PRs #103, #105).                                                                                                     |
| `src/components/QuotaBadge.tsx`                  |   107 | PORTED-AS           | `src/shell/quota-readout.tsx` (PR #67; re-verified in PR #142).                                                                                                                                                      |
| `src/components/TerminalView.tsx`                |   160 | PORTED-AS           | `src/components/terminal-snapshot.tsx` and `terminal-snapshot-model.ts` (PR #137).                                                                                                                                   |
| `src/components/UnifiedBrowserSurface.tsx`       |   694 | GENUINELY-UNPORTED  | `src/features/browser/unified-browser-model.ts` carries address/history decisions, but the workspace component still needs the remote-pane chrome/status hand-off (PR #137).                                         |
| `src/components/composer-autocomplete-engine.ts` |   614 | PORTED-AS           | `src/components/composer-autocomplete.ts`, `composer-autocomplete-providers.ts`, and `src/shell/palette-model.ts` (PR #146).                                                                                         |
| `src/hooks/useLiveTick.ts`                       |   544 | PORTED-AS           | `src/hooks/use-live-clock.ts`; the selection hold and cap were completed in PR #143.                                                                                                                                 |
| `src/hooks/useNotifications.ts`                  |   367 | BLOCKED-ON-APP-ROOT | Its once-only fleet watch needs the root-owned live store and service worker. Scoped preference/device pieces already exist in `notification-ledger.ts`, `notification-preferences.ts`, and `push-subscriptions.ts`. |
| `src/hooks/useServiceWorkerUpdate.ts`            |   445 | BLOCKED-ON-APP-ROOT | Requires the public PWA bundler/release worker and app-bar mount; no production app currently exists (`HANDOFF.md` §14).                                                                                             |
| `src/lib/agent-mention-context.tsx`              |    30 | PORTED-AS           | `src/lib/agent-references.ts` and `src/lib/reference-host.ts`, supplied from the daemon-scoped fleet snapshot (PR #129).                                                                                             |
| `src/lib/agent-mentions.ts`                      |   110 | PORTED-AS           | `src/lib/agent-references.ts` and `src/lib/references.ts` (PR #129).                                                                                                                                                 |
| `src/lib/api.ts`                                 |   297 | PORTED-AS           | `src/lib/api-client.ts`, `daemon-transport.ts`, and `daemon-connection.ts`; each request is bound to a runtime `DaemonConnection` (PRs #39, #42).                                                                    |
| `src/lib/attention.ts`                           |   443 | PORTED-AS           | `src/lib/attention-client.ts`, `attention-store.ts`, and `features/attention/attention-api.ts`; cache keys include daemon/session scope (PRs #54, #121).                                                             |
| `src/lib/code-references.ts`                     |    19 | PORTED-AS           | `src/lib/references.ts` and `agent-references.ts` (PR #129).                                                                                                                                                         |
| `src/lib/fuzzy.ts`                               |   272 | PORTED-AS           | `src/shell/palette-ranking.ts` (PR #92; re-used and verified in PR #144).                                                                                                                                            |
| `src/lib/grouping.ts`                            |   222 | PORTED-AS           | `src/lib/fleet-grouping.ts` and `src/hooks/use-fleet-view.ts` (PR #124).                                                                                                                                             |
| `src/lib/learning-types.ts`                      |    86 | PORTED-AS           | `@ferretry/protocol` learning schemas/types; no duplicate browser mirror (PR #132).                                                                                                                                  |
| `src/lib/lineage-costs.ts`                       |   164 | PORTED-AS           | `src/lib/lineage.ts` and `src/features/lineage/lineage-surface-model.ts`; cost/evidence are daemon-provided (PR #135).                                                                                               |
| `src/lib/model-cost.ts`                          |    13 | DROPPED             | It is only a UI re-export shim for server pricing. Ferretry prices at the daemon/protocol boundary; a browser copy would drift (PR #132).                                                                            |
| `src/lib/notify.ts`                              |   418 | BLOCKED-ON-APP-ROOT | The active-page notification watch needs root composition and the service worker. Per-daemon preferences and push registration are already ported; no global watch may be invented.                                  |
| `src/lib/pins.ts`                                |   616 | PORTED-AS           | `src/lib/pin-client.ts`, `pin-store.ts`, and `features/pins/*`; daemon-qualified cache and optimistic reconciliation (PRs #105, #122).                                                                               |
| `src/lib/push-api.ts`                            |    82 | PORTED-AS           | `src/lib/push-subscriptions.ts` plus `features/settings/notification-settings.tsx`, with a per-daemon registration (PR #111).                                                                                        |
| `src/lib/remark-session-references.ts`           |    12 | PORTED-AS           | `src/lib/references.ts`, `agent-references.ts`, and `pin-links.ts`; the obsolete compatibility export was intentionally removed with the source-only session-reference behavior (PR #129).                           |
| `src/lib/router.tsx`                             |    84 | BLOCKED-ON-APP-ROOT | Daemon-qualified route parsing/link construction is in `src/lib/pages/routes.ts` and `src/shell/route-link.tsx`; history subscription and rendering await the root (PR #144).                                        |
| `src/lib/sends.ts`                               |   671 | PORTED-AS           | `src/lib/send-ledger.ts`, `send-ledger-join.ts`, `send-badge.ts`, and `src/components/ledger-message.tsx` (PRs #78, #81, #117).                                                                                      |
| `src/lib/settings.ts`                            |   248 | PORTED-AS           | `src/features/settings/settings-catalog.ts`, `settings-page.tsx`, and preference modules; daemon data remains injected rather than ambient (PR #128).                                                                |
| `src/lib/store.tsx`                              |   928 | BLOCKED-ON-APP-ROOT | `src/lib/fleet-store.ts` and `event-transport.ts` replace its singleton with per-daemon slices, but provider/subscription composition belongs to the missing root (PR #97).                                          |
| `src/lib/stt/live-transcription.ts`              |   708 | BLOCKED-ON-APP-ROOT | Browser-local live decoding depends on the intentionally absent local-engine/bundler asset path. The shipped daemon transcription path is `src/lib/stt/daemon-engine.ts` (PRs #126, #134).                           |
| `src/lib/stt/local-engine.ts`                    |   814 | BLOCKED-ON-APP-ROOT | Requires `onnxruntime-web`, Parakeet assets, and a production bundler; deliberately replaced by paired-daemon transcription (PR #126).                                                                               |
| `src/lib/stt/ort-assets.ts`                      |    99 | BLOCKED-ON-APP-ROOT | Build-fingerprinted browser-local ONNX assets belong to the deferred local-engine/bundler slice (PR #126).                                                                                                           |
| `src/lib/stt/vite-asset-urls.d.ts`               |    16 | DROPPED             | Type declarations solely for the deliberately absent Vite local-engine assets (PR #126).                                                                                                                             |
| `src/lib/task-views.ts`                          |   266 | PORTED-AS           | `src/features/tasks/task-projections.ts`, `task-status-filter.tsx`, and `task-dag.ts` (PRs #53, #85).                                                                                                                |
| `src/lib/tasks.ts`                               |   588 | PORTED-AS           | Protocol task schemas plus `src/features/tasks/task-board-model.ts`, `task-projections.ts`, and task surfaces (PRs #53, #124).                                                                                       |
| `src/lib/utils.ts`                               |   106 | PORTED-AS           | Split into `src/lib/class-names.ts`, `usage.ts`, and the dedicated status/presentation modules; no shared singleton remains.                                                                                         |
| `src/lib/ws.ts`                                  |   139 | PORTED-AS           | `src/lib/event-transport.ts`; ticketed URLs are constructed from the paired daemon, never page origin (PR #44).                                                                                                      |
| `src/main.tsx`                                   |    30 | BLOCKED-ON-APP-ROOT | The browser entry is intentionally deferred with `App.tsx`; the harness entry is not a deployable application (`HANDOFF.md` §14).                                                                                    |
| `src/pages/SessionChatPage.tsx`                  | 1,809 | BLOCKED-ON-APP-ROOT | Its model/parts live in `src/components/session-chat-{model,parts}.tsx`, while live history/event/side-pane composition must wait for the root (PR #140).                                                            |
| `src/pages/SessionsListPage.tsx`                 | 1,080 | PORTED-AS           | `src/components/session-dashboard*.tsx` plus `src/hooks/use-dashboard-view.ts`; root data loading is deliberately injected (PR #144).                                                                                |
| `src/types.ts`                                   |   725 | PORTED-AS           | `@ferretry/protocol` schemas/types and narrow PWA view contracts; the daemon, not a browser mirror, is authoritative.                                                                                                |

## Result

The filename survey's **17,215 apparent LOC** resolve to 28 PORTED-AS files
(10,277 LOC), 11 app-root-blocked files (6,167 LOC), 3 deliberate drops (77
LOC), and **one genuinely unported feature**: `UnifiedBrowserSurface.tsx` (694
LOC). The counts overlap source-file boundaries only; a file that has a
ported model but an unported root component is correctly counted as blocked or
genuine above.

Two CSS apparent misses are also already carried: `components/attention-views.css`
→ `features/attention/attention-board.css`, and `components/task-views.css` →
the task feature's tokenized component styles / `task-dag-graph.css`. They are
not part of the 43 executable-file denominator.

## Next work, in order

1. `UnifiedBrowserSurface.tsx` — the only genuine gap, but not cheap: first
   refactor `RemoteBrowserPane` to expose the chrome/status/location contract,
   then mount the unified workspace with daemon-scoped browser state.
2. The app root (`App.tsx`, `main.tsx`, router/store) — unlocks the blocked
   session-chat, notification-watch, and service-worker work as one coherent
   public-static PWA increment.
3. Optional browser-local STT — only if product chooses the large asset and
   privacy trade-off; the current daemon-bound dictation capability is complete.

No small, self-contained genuinely-unported file remains in this survey, so
this unit deliberately adds no speculative port.
