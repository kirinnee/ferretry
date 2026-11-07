import { appAction, definePlugin, panel, route, screen, settingsTab, verb } from '@ferretry/kernel/manifest';
import {
  AGENDA_CLEARED_AUDIT,
  AGENDA_MODE_CHANGED_AUDIT,
  AgendaBuzzed,
  AGENDA_CONFIG,
  AgendaModeChanged,
  AgendaPort,
  MACHINE_AGENDA_ACTED_AUDIT,
  BUZZES,
  MODES,
  SEEN,
  cap,
} from './contract/index.ts';
import { AskAnswered, AsksChanged, AsksPort } from '@ferretry/core-asks/contract';
import { FerretChanged, FerretsPort } from '@ferretry/core-ferrets/contract';
import { AccessPort } from './contract/others.ts';

/**
 * Agenda (§2.3): your list of asks and notices, grouped, with buzzes to your phone. The asks themselves are Asks'
 * (core); this is the view, the tabs, the modes and the buzz policy, and the daemon's own agenda.
 *
 * Ownership calls (skeletons-work):
 *  - The per-ferret item routes (`/v1/ferrets/:ferretId/agenda…`: raise, patch, reply, versions, conversation, seen) are
 *    ASKS', not declared here: answering is a security act (§2.2). So are the `fy agenda add|answer|…` item verbs, which
 *    become `fy ask`. Agenda keeps `fy notify` (it raises a notice through the Asks port) and the owner-only views.
 *  - The push SUBSCRIPTION routes (`/v1/push/subscriptions`, `/vapid`) are ACCESS': `push.json` and `push-keys.json` are
 *    Access state (§9.2). `POST /v1/push/seen` is Agenda's (DECISIONS-1 #4: it is about an ask the owner opened). Agenda
 *    sends a buzz through Access's port (`uses`).
 *  - `GET|PATCH /v1/ferrets/:ferretId/agenda-mode` is Agenda's (ports/agenda.md lists session/agenda-mode with it).
 */
export default definePlugin({
  id: 'agenda',
  title: 'Agenda',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['view', 'command', 'instruction'],
  words: [
    { word: 'agenda', means: 'your list of asks and notices', insteadOf: ['inbox', 'attention'] },
    { word: 'buzz', means: 'a push to your phone', insteadOf: ['ping'] },
  ],

  needs: { asks: AsksPort, ferrets: FerretsPort },
  uses: { access: AccessPort },
  provides: { agenda: AgendaPort },

  actions: {
    routes: [
      route('GET /v1/agenda/open', {
        minimum: 'operator',
        caller: 'person',
        noStore: true,
        audit: { skip: 'a read of the roll-up' },
        guard: { none: 'asks are authored text; no pane, page or vault text' },
      }),
      route('POST /v1/agenda/clear-agents', {
        minimum: 'operator',
        caller: 'person',
        noStore: true,
        audit: { record: AGENDA_CLEARED_AUDIT },
        guard: { none: 'answers two counts' },
      }),
      route('GET /v1/ferrets/:ferretId/agenda-mode', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        audit: { skip: 'a read of one switch' },
        guard: { none: 'a boolean and a sentence' },
      }),
      route('PATCH /v1/ferrets/:ferretId/agenda-mode', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        audit: { record: AGENDA_MODE_CHANGED_AUDIT },
        guard: { none: 'a boolean and a sentence' },
      }),
      route('POST /v1/push/seen', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('fleet', 'use'),
        noStore: true,
        audit: { skip: 'the owner opened an ask; the call carries no content and changes nothing but a seen mark' },
        guard: { none: 'an ask id and a board id' },
      }),
      route('GET /v1/machine/agenda', {
        minimum: 'operator',
        caller: 'person',
        noStore: true,
        audit: { skip: 'a read of the daemon agenda' },
        guard: { none: 'daemon notices are authored text; no pane, page or vault text' },
      }),
      route('GET /v1/machine/agenda/:id', {
        minimum: 'operator',
        caller: 'person',
        noStore: true,
        audit: { skip: 'a read of one daemon notice' },
        guard: { none: 'daemon notices are authored text; no pane, page or vault text' },
      }),
      route('POST /v1/machine/agenda', {
        minimum: 'operator',
        caller: 'person',
        noStore: true,
        audit: { record: MACHINE_AGENDA_ACTED_AUDIT },
        guard: { none: 'answers the acted notice' },
      }),
    ],
    cli: [
      verb('agenda', { summary: 'what is waiting on you, grouped' }),
      verb('agenda open', { summary: 'every ferret’s open and parked asks, paged' }),
      verb('agenda mode', { summary: 'switch agenda mode for a ferret or for new ferrets' }),
      verb('agenda clear', { summary: 'dismiss the agent ferrets’ backlog (--dry-run counts it)' }),
      verb('notify', { summary: 'tell the owner one thing: a quiet notice; --buzz also buzzes the phone' }),
    ],
    app: [
      appAction('agenda.clear-agents', {
        on: 'page',
        label: 'Clear agent ferrets',
        calls: 'POST /v1/agenda/clear-agents',
      }),
    ],
  },

  ui: {
    screens: [
      screen('agenda', { path: '/agenda', nav: { label: 'Agenda', icon: 'inbox', order: 10 } }),
      screen('agenda-ask', { path: '/agenda/:ferret/:ask' }),
    ],
    panels: [
      panel('ferret.side', { id: 'ferret-agenda', order: 10 }),
      panel('ferret.toolbar', { id: 'ferret-agenda-mode', order: 60 }),
    ],
    settings: [settingsTab('agenda', { label: 'Agenda', order: 20 })],
    // The ask page OFFERS the `agenda.conversation` slot (contract/slots.ts, lead decision Q9): Conversation contributes
    // the ferret's conversation and composer under an open ask; Agenda imports nothing of Conversation's.
  },

  data: {
    state: [SEEN, BUZZES, MODES],
    config: [AGENDA_CONFIG],
    readModels: ['open', 'daemon-agenda', 'mode'],
    publishes: [AgendaModeChanged, AgendaBuzzed],
    subscribes: [AskAnswered, AsksChanged],
  },

  // A ferret that goes idle with asks waiting is stopped on the owner: one buzz for the stop.
  hooks: { takes: [{ hook: FerretChanged }] },

  instructions: [{ id: 'notify', text: 'instructions/notify.md', when: { role: 'any' } }],
  doctor: ['agenda-buzz'],
});
