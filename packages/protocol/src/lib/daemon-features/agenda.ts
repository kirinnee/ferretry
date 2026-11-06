/** The agenda's wire names and the fields an agenda item or request grew (`agenda.*`). One fragment of `DAEMON_FEATURES`; `index.ts` spreads them all. */
export const AGENDA_FEATURES = {
  /**
   * The agenda's wire names (docs/agenda.md § Compatibility): `/v1/sessions/:id/agenda`,
   * `/v1/sessions/:id/agenda/replies`, `/v1/warden/agenda` and `SessionState.agenda`, the only spellings a daemon
   * answers. No client reads this name; it stays advertised.
   */
  agendaWire: 'agenda.wire.1',
  /**
   * An agenda add (`AddAgendaRequestSchema`) may name the board card it belongs to (`task`). A daemon
   * without this name refuses the whole add, because the request is strict: send `task` only when the
   * daemon advertises it, and otherwise raise the item without one.
   */
  agendaTask: 'agenda.task.1',
  /**
   * The agenda's parked items (docs/agenda.md § Parked items): `snooze` and `unsnooze` requests, and `now` on
   * `edit` and `surface`. A daemon without this name refuses them as an unknown action. No client gates on it: the app
   * offers the clock on every machine.
   */
  agendaSnooze: 'agenda.snooze.1',
  /**
   * The owner's bulk "clear all from agent ferrets" (`POST /v1/agenda/clear-agents`, docs/agenda.md § Clearing
   * the agent ferrets' backlog). A daemon without this name answers 404: the app offers the button only where the
   * machine reports it, and otherwise says the machine needs an update.
   */
  agendaClearAgents: 'agenda.clear-agents.1',
  /**
   * The roll-up of every conversation's open and parked agenda items (`GET /v1/agenda/open`, docs/agenda.md § The
   * roll-up). A daemon without this name answers 404. No client gates on it: the Inbox reads the roll-up from
   * every machine.
   */
  agendaOpen: 'agenda.open.1',
  /**
   * An agenda `resolve` that answers a card's gate may carry `attachments` — files the owner sent with "Not good" in
   * the Inbox — which the daemon delivers to the card's ferret with the reopen. A daemon without this name refuses
   * the field: the Inbox offers the composer's attach only where the machine reports it.
   */
  agendaGateAttachments: 'agenda.gate.attachments.1',
  /**
   * An agenda add may carry `offerClose`, and an item may come back with it: the app then offers "Done · closes
   * &F12" beside the answers. A daemon without this name refuses the add, so the CLI sends it only where the machine reports it;
   * the app does not gate on it.
   */
  agendaOfferClose: 'agenda.offer-close.1',
  /**
   * An agenda link (`AgendaLink`) may carry a `meaning`: the plain words the item view's terms-and-references table
   * shows for it (docs/agenda.md § Rules the writing keeps). A daemon without this name refuses the whole request
   * over the field, so the CLI sends a meaning only where the machine reports it.
   */
  agendaLinkMeaning: 'agenda.link-meaning.1',
  /**
   * A machine notice may list board cards (`AgendaItem.cards`), each with Open, Start a ferret on it and Close card:
   * `POST /v1/board/tasks/:taskId/start` starts a new ferret on the card with the card's brief. A daemon without this
   * name has neither the field nor the route, so the app draws its Got it alone.
   */
  agendaCards: 'agenda.cards.1',
  /**
   * THE AGENDA AS A CHANNEL (docs/agenda.md § States): an owner's answer or reply RESTS a ferret's item instead of
   * closing it, and the ferret's answer brings it back to its old place in the Needs-you queue. The add and edit
   * requests take `stage`, `whereWeAre` and `detail`; the `rest` action takes an item on as `working`; and text caps
   * rise to a per-item transport bound. A daemon without this name refuses every one of those, so a client sends them
   * only to one that reports it.
   */
  agendaChannel: 'agenda.channel.1',
  /**
   * EDITABLE ASKS (docs/agenda.md § Editable asks): an edit may REPLACE the ask (`ask`, `kind`, `answers`, questions
   * with other options, a form's fields) and clear `questionAnswer`, and an answer — or a Done or Skip given from the
   * ask — names the `askVersion` it was given to and is refused `409 ask_changed` past it (a human's unversioned
   * answer to a replaced ask too). The app always sends the `askVersion` of the ask on screen and does not gate on this name; the
   * CLI sends `--kind` and `--clear-question-answer` on an edit only to a daemon that reports it, and a daemon
   * without it refuses all three as malformed.
   */
  agendaAsks: 'agenda.asks.1',
  /**
   * THE CONVERSATION ON THE ITEM (docs/agenda.md § The conversation): every word the owner and the ferret say on an item
   * is kept on it (`conversation`), `fy agenda log` copies the owner's chat words onto it, `merge` and `split` join and
   * divide items, and every change to an item is kept as a full version that can be listed and fetched, with a per-device
   * "last seen" mark. A daemon without this name refuses the `log`, `merge` and `split` actions as malformed and has no
   * version routes, so the CLI sends them only to one that reports it; the app does not gate on it.
   */
  agendaConversation: 'agenda.conversation.1',
  /**
   * THE ITEM'S TABS (docs/agenda.md § The tabs): an item's live document is a row of tabs — the main tab
   * (`whereWeAre`), the full picture (`body`) and the ferret's own (`tabs`), written with `tabEdits` in one edit. A
   * daemon without this name refuses `tabs` and `tabEdits` as malformed, so a client sends them only to one that
   * reports it; an app before it drops the `tabs` key.
   */
  agendaTabs: 'agenda.tabs.1',
  /**
   * PATCHING AN ITEM AS ONE DOCUMENT (docs/agenda.md § Patch, `fy agenda patch`): an edit names the `revision` it read
   * and is refused `stale` when the item has moved on (read before write); it may rewrite `why` and `howToResolve`; and
   * its `clear` takes the optional writing too (`decided`, `links`, `body`, `whereWeAre`, `detail`…), so a patch's `null`
   * removes it. A daemon without this name refuses all three as malformed, so a client sends them only to one that
   * reports it.
   */
  agendaPatch: 'agenda.patch.1',
  /**
   * CARD ASKS (docs/agenda.md § Card asks): a card never asks the owner itself. Its ask (OK to build, or Done / Not
   * good with the card's How to test) rides the agenda that carries the card as `AgendaItem.cardAsks`, the first open
   * one mirrored as `gateAttached`; an answer names its ask by `cardAsk`, and the agenda RESTS after it. Cards carry
   * no "waiting on you" any more: `waitingOnOwner`, the `toTest` and `waitingOnYou` counts and their filters come
   * back empty. A daemon without this name raises standalone gate items (`AgendaItem.gate`) instead.
   */
  agendaCardAsks: 'agenda.card-asks.1',
} as const;
