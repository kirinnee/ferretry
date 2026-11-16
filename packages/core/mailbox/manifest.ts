import { definePlugin, route } from '@ferretry/kernel/manifest';
import { FerretChanged, FerretsPort } from '@ferretry/core-ferrets/contract';
import { DeliveryWays, MailboxHosts, MailboxPort, QueueChanged } from './contract/index.ts';
import {
  cap,
  COMPOSER_ACTED_AUDIT,
  MESSAGE_SENT_AUDIT,
  QUEUE_CANCELLED_AUDIT,
  QUEUE_EDITED_AUDIT,
  SEND_CANCELLED_AUDIT,
  SEND_ENTERED_AUDIT,
  SEND_RETRIED_AUDIT,
  TURN_INTERRUPTED_AUDIT,
} from './contract/policy.ts';

// Shared descriptor pieces, as Conversation's were: the fields answer independent questions (§7.1).
const FERRET = { minimum: 'operator', caller: 'any', noStore: true } as const;
const PERSON = { minimum: 'operator', caller: 'person', noStore: true } as const;
/** The body can show a ferret's words, a transcript, a pane or a draft: built inside one `Redaction.read` (§7.3). */
const SECRETS = { guard: 'secrets' } as const;
const READ = { audit: { skip: 'read' } } as const;
/** Reading a ferret's words (its send ledger, queue, handoffs) is `fleet.use` (c58-sec1). */
const FLEET_USE = { capability: cap('fleet', 'use') } as const;
const ACK = { guard: { none: 'answers an acknowledgement; no pane, page or vault text' } } as const;

/**
 * Mailbox (§2.3): the one way a message reaches a ferret. Core, because every message goes through it. It decides WHEN
 * and HOW a message is delivered (the queue, its lanes and gates, the send ledger and its proof); Conversation keeps the
 * chat. This first step (c58-m0a) only lays the package down: the contract the logic will live behind and the one slot
 * (`mailbox.host`) Conversation fills with the stores over the files it keeps. No route, tool or screen moves yet.
 */
export default definePlugin({
  id: 'mailbox',
  title: 'Mailbox',
  version: '5.0.0',
  api: 5,
  core: true,
  kinds: [],
  words: [
    { word: 'mailbox', means: 'where a message to a ferret waits until it can be delivered', insteadOf: ['outbox'] },
  ],
  needs: { ferrets: FerretsPort },
  provides: { mailbox: MailboxPort },
  data: { publishes: [QueueChanged] },
  // The Mailbox offers the delivery-way slot and contributes the first way itself (the ferret's terminal, through Ferrets).
  hooks: {
    offers: [{ hook: MailboxHosts }, { hook: DeliveryWays }],
    takes: [{ hook: FerretChanged }, { hook: DeliveryWays }],
  },
  actions: {
    routes: [
      // ── send, queue, ledger (session-send) ────────────────────────────────────────────────────
      route('POST /v1/ferrets/:ferretId/send', {
        ...FERRET,
        audit: { record: MESSAGE_SENT_AUDIT },
        // The one carve-out (today's): a composer_occupied refusal returns the composer's text from the pane (the person's
        // own draft, or a peer's message a queue left stranded there).
        guard: {
          none: "answers an acknowledgement; no page or vault text, and no pane text except the composer's text a composer_occupied refusal returns, as today",
        },
      }),
      route('POST /v1/ferrets/:ferretId/interrupt', { ...FERRET, audit: { record: TURN_INTERRUPTED_AUDIT }, ...ACK }),
      route('GET /v1/ferrets/:ferretId/sends', { ...FERRET, ...FLEET_USE, ...READ, ...SECRETS }),
      route('GET /v1/ferrets/:ferretId/queue', { ...FERRET, ...FLEET_USE, ...READ, ...SECRETS }),
      route('PATCH /v1/ferrets/:ferretId/queue/:messageId', {
        ...FERRET,
        audit: { record: QUEUE_EDITED_AUDIT },
        ...SECRETS,
      }),
      route('DELETE /v1/ferrets/:ferretId/queue/:messageId', {
        ...FERRET,
        audit: { record: QUEUE_CANCELLED_AUDIT },
        ...SECRETS,
      }),
      route('GET /v1/ferrets/:ferretId/sends/:sendId', { ...FERRET, ...FLEET_USE, ...READ, ...SECRETS }),
      route('GET /v1/ferrets/:ferretId/handoffs/:name', { ...FERRET, ...FLEET_USE, ...READ, ...SECRETS }),
      // A person's alone: a retry is the one act that clears an update-unconfirmed send's mark and types it again.
      route('POST /v1/ferrets/:ferretId/sends/:sendId/retry', {
        ...PERSON,
        audit: { record: SEND_RETRIED_AUDIT },
        ...ACK,
      }),
      route('POST /v1/ferrets/:ferretId/sends/:sendId/cancel', {
        ...FERRET,
        audit: { record: SEND_CANCELLED_AUDIT },
        ...ACK,
      }),
      route('POST /v1/ferrets/:ferretId/sends/:sendId/enter', {
        ...FERRET,
        audit: { record: SEND_ENTERED_AUDIT },
        ...ACK,
      }),
      route('POST /v1/ferrets/:ferretId/composer', {
        ...PERSON,
        capability: cap('terminal', 'use'),
        audit: { record: COMPOSER_ACTED_AUDIT },
        // The composer's draft text goes to a pane; the answer is the outcome word only. A refusal can quote the pane's
        // blocking prompt (masked), as today's refusal did; the draft itself is never in an answer.
        guard: {
          none: "answers an outcome word; a refusal may quote the pane's masked blocking prompt; no page or vault text",
        },
      }),
    ],
  },
  doctor: ['mailbox-host', 'mailbox-ways'],
});
