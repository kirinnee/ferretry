# Agent-callable notifications — #12 source coverage

Checked against `/home/kirin/.config/home-manager/modules/kteam-ts` on 2026-08-05.

| kteam source capability                                                                             | Ferretry path                                                                                                                                                                                                                                                                                       | Status                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `attention-notifier.ts` direct `completed` / `failed` notification parser and actor guard           | `packages/protocol/src/lib/attention.ts`; `packages/daemon/src/lib/notifications/`; `packages/daemon/src/lib/runtime/mounts/attention.ts`.                                                                                                                                                          | **Closed on the daemon side.** The real `POST /v1/sessions/:sessionId/notify` route reuses server-derived Attention actors, confines an agent to its own session, accepts human calls for any session, requires `x-fy-request-id`, and delivers through `PushService.notify`. The durable request fingerprint makes identical retries settle exactly once in-memory and after restart. |
| `push-api.ts`, `push-subscriptions.ts`, and `push-vapid.ts` device enrolment and VAPID surface      | `packages/protocol/src/lib/push.ts`; `packages/pwa/src/lib/push-subscriptions.ts` and `push-enrolment.ts`; `packages/pwa/src/features/settings/notification-settings.tsx`; `packages/daemon/src/lib/push/`, `packages/daemon/src/adapters/push/`, `packages/daemon/src/lib/runtime/mounts/push.ts`. | **Closed on the daemon side.** All four `/v1/push/*` routes are mounted against the schemas the protocol already declared, over a durable enrolment store and a per-daemon P-256 key pair whose private half no route, error or log can carry. Governed by `pairing.use` — see `docs/grants.md`.                                                                                       |
| `PushNotifier.deliverDirect` preference-filtered Web Push delivery                                  | `packages/daemon/src/adapters/push/web-push-transport.ts`; `PushService.notify`; `packages/daemon/src/lib/notifications/service.ts`.                                                                                                                                                                | **Closed on the daemon side, with real triggers.** Direct requests and newly committed Attention items use the sole preference-filtered fan-out. Every session dispatch derives `interactive` from `SessionView.config.mode`; no status-transition watcher was added. `delivered` means accepted by a push endpoint, not observed by a person.                                         |
| `AttentionNotifier.notifyNewItem` automatic notification for a newly created durable attention item | `packages/daemon/src/lib/attention/service.ts`; `packages/daemon/src/lib/notifications/service.ts`.                                                                                                                                                                                                 | **Closed on the daemon side.** Only a genuinely `created` item is presented after its transaction commits. Refresh, answer, resolve, dismiss and session-status transitions remain silent, and observer failures cannot fail the Attention mutation. Item identity is `attention:<sessionId>:<attentionId>`, so every session's `A1` is distinct and the same item cannot push twice.  |
| Direct-notification audit journal                                                                   | `packages/daemon/src/lib/notifications/types.ts`; `packages/daemon/src/adapters/notifications/file-notification-delivery-ledger.ts`.                                                                                                                                                                | **Closed.** `state/notifications.jsonl` is a daemon-internal write-ahead delivery ledger with server-derived attribution, accepted direct request, sent payload facts, enrolment count, delivered/failed outcome and durable replay decisions. Complete malformed or phase-inconsistent records fail closed; only a torn final fragment is ignored. No audit read route is exposed.    |

Conclusion: the daemon now owns a real, audited notification presenter without enabling the PWA's automatic status watcher. Browser receipt remains the explicit gap below, so handover row 12 remains open.

## What the daemon-side landing does and does not give you

The daemon can now hold an enrolment and deliver an encrypted notification to it. One half is still
missing, named here so the next unit does not rediscover it:

- **The browser cannot receive one.** `packages/pwa` has no service worker at all — no registration, no
  `push` listener, no `showNotification`. `pushManager.subscribe` needs a registration, so in a real
  browser enrolment cannot even begin. Every daemon-side guarantee is still real (an endpoint is
  validated against its push service, not against whether a tab drew a toast), but push is not
  end-to-end until a worker lands.

The daemon-side facts this unit closes are:

- **The daemon can raise one.** `PushService.notify` fans out to every device that agreed, prunes
  endpoints a push service reports as gone, and is reached by both explicit direct notification calls
  and newly committed Attention items. Lifecycle status changes do not trigger it.
- **`interactiveOnly` has an authoritative source.** Every session notification carries whether
  `SessionView.config.mode` is `interactive`; automatic sessions are therefore suppressed for devices
  that opted into interactive-only delivery.
- **Delivery is endpoint acceptance.** Counts report what push endpoints accepted. They cannot prove a
  browser displayed the payload or that a person observed it, especially while the worker gap remains.

## Follow-up

Before adding a sixth mutation-specific copy, extract the shared non-empty request-id decision into
`requireRequestId(request, consequence)` across all five current sites:
`packages/daemon/src/lib/runtime/mounts/session-send.ts`, `session-answer.ts`, `session-migrate.ts`,
`session-control.ts`, and `attention.ts`.
