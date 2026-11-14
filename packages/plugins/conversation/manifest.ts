import {
  appAction,
  definePlugin,
  panel,
  renderer,
  route,
  screen,
  settingsTab,
  socket,
  tool,
  verb,
} from '@ferretry/kernel/manifest';
import {
  ATTACHMENT_ADDED_AUDIT,
  ATTACHMENT_RELOCKED_AUDIT,
  ATTACHMENT_UNLOCKED_AUDIT,
  cap,
  COMPACT_AT_CHANGED_AUDIT,
  COMPOSER_ACTED_AUDIT,
  CONVERSATION_CONFIG,
  CONVERSATION_STATE,
  AGENDA_CONVERSATION_SLOT,
  ConversationPort,
  DRAFT_EDITED_AUDIT,
  DraftChanged,
  HYPERMEDIA_CHANGED_AUDIT,
  LINKS_ADOPTED_AUDIT,
  LinkKept,
  MESSAGE_SENT_AUDIT,
  MessageBeforeSend,
  MessageSent,
  QUESTION_ANSWERED_AUDIT,
  QUEUE_CANCELLED_AUDIT,
  QUEUE_EDITED_AUDIT,
  QueueChanged,
  QuestionAnswered,
  QuestionAsked,
  QuestionSchema,
  ReferenceCatalog,
  RELATED_SEARCHED_AUDIT,
  RENDER_SAVED_AUDIT,
  SEND_CANCELLED_AUDIT,
  SEND_ENTERED_AUDIT,
  SEND_RETRIED_AUDIT,
  SearchSources,
  SearchWorkToolInputSchema,
  TURN_INTERRUPTED_AUDIT,
  TurnEnded,
} from './contract/index.ts';
import {
  ASK_DELIVERY_KEY,
  ASK_OWNER_CHAT_KEY,
  AskAnswered,
  AskDeliveries,
  AskOwnerChats,
  AsksPort,
  AskSources,
} from '@ferretry/core-asks/contract';
import {
  ACTIONS_ROW_SLOT,
  FerretChanged,
  FerretsPort,
  FerretStopping,
  FILES_SEARCH_SLOT,
  LaunchParts,
  OPENING_ATTACHMENTS_KEY,
  OpeningAttachments,
  SitrepLines,
} from '@ferretry/core-ferrets/contract';

// Shared descriptor pieces. The fields answer independent questions (§7.1); only what repeats is shared.
const FERRET = { minimum: 'operator', caller: 'any', noStore: true } as const;
const PERSON = { minimum: 'operator', caller: 'person', noStore: true } as const;
/** The body can show a ferret's words, a transcript, a pane or a draft: built inside one `Redaction.read` (§7.3). */
const SECRETS = { guard: 'secrets' } as const;
const OWN_DRAFT = {
  guard: { none: "the owner's own draft, person caller only, served raw as today: positional edits need the raw text" },
} as const;
const READ = { audit: { skip: 'read' } } as const;
const ACK = { guard: { none: 'answers an acknowledgement; no pane, page or vault text' } } as const;

/**
 * Conversation (§2.3): what you say to a ferret and what it says back. Descriptors are today's mounts
 * (session-send, session-reads, session-answer, session-attachments, session-compact-at, session-hypermedia, renders,
 * shared-drafts, conversation-import, foreign-history, work-search), with `/v1/sessions/:sessionId/…` now
 * `/v1/ferrets/:ferretId/…` and `/v1/imports/…` now `/v1/links/…`. Gate's per-route `capability` is copied unchanged.
 */
export default definePlugin({
  id: 'conversation',
  title: 'Conversation',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['command', 'view'],
  words: [
    { word: 'message', means: 'one thing said to or by a ferret', insteadOf: ['prompt'] },
    { word: 'turn', means: 'one round of a ferret working' },
    { word: 'question', means: 'a ferret asking you mid-turn' },
    {
      word: 'link',
      means: "a conversation read from the harness's own file, not copied",
      insteadOf: ['import'],
    },
  ],

  needs: { ferrets: FerretsPort, asks: AsksPort },
  provides: { conversation: ConversationPort },

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
      route('GET /v1/ferrets/:ferretId/sends', { ...FERRET, ...READ, ...SECRETS }),
      route('GET /v1/ferrets/:ferretId/queue', { ...FERRET, ...READ, ...SECRETS }),
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
      route('GET /v1/ferrets/:ferretId/sends/:sendId', { ...FERRET, ...READ, ...SECRETS }),
      route('GET /v1/ferrets/:ferretId/handoffs/:name', { ...FERRET, ...READ, ...SECRETS }),
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

      // ── reading (session-reads) ───────────────────────────────────────────────────────────────
      route('GET /v1/ferrets/:ferretId/logs', { ...FERRET, ...READ, ...SECRETS }), // R265: strong etag over redacted text
      route('GET /v1/ferrets/:ferretId/log-page', { ...FERRET, ...READ, ...SECRETS }), // R266 (kept half)
      route('GET /v1/ferrets/:ferretId/log-search', { ...FERRET, ...READ, ...SECRETS }),
      route('GET /v1/ferrets/:ferretId/messages', { ...FERRET, ...READ, ...SECRETS }), // G41: bounded fragments
      // The composer's reference menus (lead decision Q6): each prefix's owner provides its entries through `reference.catalog`.
      // Ungoverned itself, but each provider's own demand (files, terminals, pages) is asked of the caller before it answers.
      route('GET /v1/ferrets/:ferretId/references', { ...FERRET, ...READ, ...SECRETS, consultsGrants: true }),
      // R267 / G162: an image handle never changes for an append-only transcript, so no `noStore`.
      route('GET /v1/ferrets/:ferretId/transcript-images/:handle', {
        minimum: 'operator',
        caller: 'any',
        ...READ,
        ...SECRETS,
      }),

      // ── questions, compaction, hypermedia ─────────────────────────────────────────────────────
      route('GET /v1/ferrets/:ferretId/question', { ...FERRET, ...READ, ...SECRETS }),
      route('POST /v1/ferrets/:ferretId/answer', {
        ...PERSON,
        // DELIBERATE PARITY CORRECTION: v4 declared no capability here (R-0335 `capability=none`). On 5.0 the route
        // types native keys and pastes into a pane, so a remote caller needs the terminal grant like
        // every other route that types (composer, permission, dialog). A local owner is still exempt.
        capability: cap('terminal', 'use'),
        audit: { record: QUESTION_ANSWERED_AUDIT },
        ...ACK,
      }),
      route('GET /v1/ferrets/:ferretId/compact-at', { ...FERRET, ...READ, ...ACK }),
      route('PATCH /v1/ferrets/:ferretId/compact-at', {
        ...FERRET,
        audit: { record: COMPACT_AT_CHANGED_AUDIT },
        ...ACK,
      }),
      route('GET /v1/ferrets/:ferretId/hypermedia', { ...FERRET, ...READ, ...ACK }),
      route('PATCH /v1/ferrets/:ferretId/hypermedia', {
        ...FERRET,
        audit: { record: HYPERMEDIA_CHANGED_AUDIT },
        ...ACK,
      }),

      // ── attachments (session-attachments) ─────────────────────────────────────────────────────
      route('POST /v1/ferrets/:ferretId/attachments', {
        ...FERRET,
        audit: { record: ATTACHMENT_ADDED_AUDIT },
        ...SECRETS,
      }),
      route('GET /v1/ferrets/:ferretId/attachments/:attachmentId', { ...FERRET, ...READ, ...SECRETS }),
      route('POST /v1/ferrets/:ferretId/attachments/:attachmentId/unlock', {
        ...FERRET,
        audit: { record: ATTACHMENT_UNLOCKED_AUDIT },
        ...SECRETS,
      }),
      route('DELETE /v1/ferrets/:ferretId/attachments/:attachmentId/unlock', {
        ...FERRET,
        audit: { record: ATTACHMENT_RELOCKED_AUDIT },
        ...SECRETS,
      }),

      // ── renders ───────────────────────────────────────────────────────────────────────────────
      route('POST /v1/renders', { ...FERRET, audit: { record: RENDER_SAVED_AUDIT }, ...SECRETS }),
      route('GET /v1/renders/:id/meta', { ...FERRET, ...READ, ...SECRETS }),
      // The payload is content-addressed and immutable: cacheable, so no `noStore`.
      route('GET /v1/renders/:id', { minimum: 'operator', caller: 'any', ...READ, ...SECRETS }),

      // ── shared drafts: owner-only, twice (`operator` and `person`) ────────────────────────────
      // Served raw, as today: the owner's own words, and an edit is a run of positions in the stored text, so a mask
      // of another width would move every offset after it (and the stream carries the same raw text).
      route('GET /v1/ferrets/:ferretId/shared-draft', { ...PERSON, ...READ, ...OWN_DRAFT }),
      route('POST /v1/ferrets/:ferretId/shared-draft', {
        ...PERSON,
        audit: { record: DRAFT_EDITED_AUDIT },
        ...OWN_DRAFT,
      }),

      // ── links (§6.2; today's conversation-import and foreign-history) ─────────────────────────
      route('GET /v1/links/conversations', {
        ...FERRET,
        capability: cap('fleet', 'configure'),
        ...READ,
        ...SECRETS,
      }),
      route('GET /v1/links/conversations/:harness/:conversationId/preview', {
        ...FERRET,
        capability: cap('fleet', 'configure'),
        ...READ,
        ...SECRETS,
      }),
      route('POST /v1/links/conversations/keep', {
        ...PERSON,
        capability: cap('fleet', 'configure'),
        audit: { record: LINKS_ADOPTED_AUDIT },
        ...ACK,
      }),
      route('GET /v1/links/history', { ...FERRET, ...READ, ...SECRETS }),
      route('GET /v1/links/history/:entryId', { ...FERRET, ...READ, ...SECRETS }),

      // ── search (work-search) ──────────────────────────────────────────────────────────────────
      route('GET /v1/search', { ...FERRET, capability: cap('fleet', 'use'), ...READ, ...SECRETS }),
      route('POST /v1/search/related', {
        ...FERRET,
        capability: cap('fleet', 'use'),
        audit: { record: RELATED_SEARCHED_AUDIT },
        ...SECRETS,
      }),
    ],
    sockets: [
      // The live stream of one ferret's draft, every open composer kept in step. It carries the same raw text as the
      // two shared-draft routes, never built inside a `Redaction.read`, so it declares what they declare.
      socket('GET /v1/ferrets/:ferretId/shared-draft/stream', {
        minimum: 'operator',
        caller: 'person',
        audit: { skip: 'a stream; the edits it carries are audited as drafts' },
        ...OWN_DRAFT,
      }),
    ],
    cli: [
      verb('send', { summary: 'say a message to a ferret' }),
      verb('reply', { summary: 'answer the ferret that last wrote to you' }),
      verb('answer', { summary: "answer a ferret's question" }),
      verb('interrupt', { summary: "stop a ferret's turn" }),
      verb('queue <ferret>', { summary: "a ferret's queued messages" }),
      verb('queue edit', { summary: 'change a queued message before it is typed' }),
      verb('queue cancel', { summary: 'withdraw a queued message' }),
      verb('logs', { summary: "read a ferret's conversation log" }),
      verb('compact-at', { summary: 'when a ferret squeezes its memory' }),
      verb('search', { summary: 'find cards and asks by what they say' }),
      verb('render', { summary: 'save a picture a ferret can show in a message' }),
      verb('render guide', { summary: 'how to write a render' }),
      verb('link [query...]', { summary: 'list conversations the harnesses hold, to keep as ferrets' }),
      verb('link preview', { summary: 'the first words of a conversation' }),
      verb('link keep', { summary: 'keep conversations as ferrets, read from the harness file' }),
      verb('transcript', { summary: 'the conversation transcript every runtime of a harness shares' }),
    ],
    agentTools: [
      tool('search_work', {
        minimum: 'authenticated',
        caller: 'any',
        capability: cap('fleet', 'use'),
        audit: { skip: 'read' },
        guard: 'secrets',
        summary: 'Find cards and asks by words or id before filing a duplicate; `all` adds old closed ones.',
        input: SearchWorkToolInputSchema,
      }),
    ],
    app: [
      appAction('turn.interrupt', { on: 'ferret', label: 'Stop turn', calls: 'POST /v1/ferrets/:ferretId/interrupt' }),
      appAction('queue.cancel', {
        on: 'ferret',
        label: 'Withdraw',
        calls: 'DELETE /v1/ferrets/:ferretId/queue/:messageId',
      }),
      appAction('question.answer', { on: 'ask', label: 'Answer', calls: 'POST /v1/ferrets/:ferretId/answer' }),
    ],
  },

  ui: {
    screens: [
      // The chat offers two slots of its own (`contract/slots.ts`): `conversation.row` after each transcript row and
      // `conversation.row-actions` in a row's actions, each with `{ entry }` (only {id, kind, text, at?, label?, tools?}; `tools` are
      // a tool row's shell commands) and the ferret as subject — Voice's read-aloud and Packs' card draw there. It mounts `ferret.toolbar` and
      // `ferret.side` with the ferret as subject.
      screen('chat', { path: 'ferrets/:ferret/chat' }),
      screen('links', { path: 'links', nav: { label: 'Conversations', icon: 'messages', order: 25 } }),
    ],
    panels: [
      panel('composer.tools', { id: 'attachments', order: 10 }),
      panel('ferret.side', { id: 'queue', order: 10 }),
      panel('ferret.toolbar', { id: 'compact-at', order: 30 }),
      // Lead decision Q2: today's Actions-menu switch, a toolbar panel of its own (listed before Compact memory at, as today).
      panel('ferret.toolbar', { id: 'hypermedia', order: 25 }),
      // This device's conversation width (lead decision Q11).
      panel('device.settings', { id: 'chat-width', order: 20 }),
      // Settings › Appearance › Message marks: the key to the clock, ticks and ! under a message (S-0509). Last, after
      // the conversation width, as v4 draws it.
      panel('device.settings', { id: 'message-marks', order: 30 }),
      // Contributions to other plugins' slots (§5.2), each by the offerer's slot name: Ferrets' file browser gets the
      // current-ferret search, its Actions ▾ menu gets Interrupt, and Agenda's ask page gets the ferret's conversation.
      panel(FILES_SEARCH_SLOT, { id: 'files-search', order: 10 }),
      panel(ACTIONS_ROW_SLOT, { id: 'interrupt-row', order: 10 }),
      panel(AGENDA_CONVERSATION_SLOT, { id: 'agenda-conversation', order: 10 }),
    ],
    settings: [settingsTab('conversation', { label: 'Conversation', order: 20 })],
    renderers: [renderer('ask', { source: 'question' })],
  },

  /** Never reached by a ferret, through any root: the key that signs a message token (`PrivacyDecl`). */
  privacy: {
    private: ['message-token.key'],
  },
  data: {
    state: CONVERSATION_STATE,
    config: [CONVERSATION_CONFIG],
    readModels: ['transcript', 'queue', 'sends', 'logs', 'search', 'links'],
    publishes: [QueueChanged, MessageSent, QuestionAsked, QuestionAnswered, DraftChanged, LinkKept],
    subscribes: [AskAnswered],
  },

  hooks: {
    takes: [
      { hook: AskSources, key: 'question', schema: QuestionSchema },
      { hook: SitrepLines, priority: 50 },
      // A ferret that stops has its unlocked attachments zeroed; every change of state is a look for `turn.ended`.
      { hook: FerretChanged },
      // A stop is being attempted: the unlocked attachments are zeroed whether or not it then succeeds.
      { hook: FerretStopping },
      // What a launch says about hypermedia: only a switch the owner set (a ferret with none keeps its mode default).
      { hook: LaunchParts },
      // The files a start was given (`fy start -f`): this plugin owns attachments, so it is THE one provider that plans
      // them (a security-path provide hook naming only `conversation` as its taker).
      { hook: OpeningAttachments, key: OPENING_ATTACHMENTS_KEY },
      // How an owner's agenda answer reaches a ferret: typed through this plugin's own send path (queue + ledger). The
      // one provider of this security-path hook (`takers: ['conversation']`).
      { hook: AskDeliveries, key: ASK_DELIVERY_KEY },
      // The owner's chat as `fy agenda log` copies it onto an item: this plugin's own queue and send ledger. The one
      // provider of this hook (`takers: ['conversation']`).
      { hook: AskOwnerChats, key: ASK_OWNER_CHAT_KEY },
    ],
    offers: [{ hook: MessageBeforeSend }, { hook: TurnEnded }, { hook: SearchSources }, { hook: ReferenceCatalog }],
  },

  // The harness plugins read their own history through `harness-history` (links); `imports` is the one path the owner
  // names for an attachment, once (§7.7). Transcripts are read only through the harness's `TranscriptReader`.
  doctor: ['conversation-store', 'conversation-search-index'],
  workers: ['pdf-decrypt'],
  permissions: { roots: ['harness-history', 'imports'] },
});
