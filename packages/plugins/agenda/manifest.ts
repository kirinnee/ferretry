import { definePlugin } from '@ferretry/kernel/manifest';
import { AGENDA_CONFIG, AgendaPort, BUZZES, MODES, NUDGES, REST_NUDGES, SEEN } from './contract/index.ts';
import { AsksPort } from '@ferretry/core-asks/contract';
import { FerretsPort } from '@ferretry/core-ferrets/contract';
import { AccessPort } from './contract/others.ts';
import { ConversationPort } from '@ferretry/plugin-conversation/contract';
import actions, { data, hooks, ui } from './manifest/generated/actions.ts';

/**
 * Agenda (§2.3): your list of asks and notices, grouped, with buzzes to your phone. The asks themselves are Asks'
 * (core); this is the view, the tabs, the modes and the buzz policy, and the daemon's own agenda.
 *
 * This file is the hand-written shell: identity, what the plugin needs, provides and uses, and its state. Everything it
 * declares to the outside (routes, verbs, app actions, screens, panels, the settings tab, the hooks it takes, the events
 * it publishes and subscribes to) is one feature's fragment under `manifest/actions/NN-<feature>.actions.ts`, merged in
 * file-name order by `manifest/generated/actions.ts`: a feature is a new fragment and this file is not edited. The
 * number prefix is the order, which the package's contract hash covers.
 *
 * Ownership calls (skeletons-work):
 *  - The per-ferret item routes (`/v1/ferrets/:ferretId/agenda…`: raise, patch, reply, versions, conversation, seen) are
 *    ASKS', not declared here: answering is a security act (§2.2). The `fy agenda add|edit|answer|…` item verbs are v4's,
 *    word for word, and Agenda's: each speaks those Asks routes (it consumes them through `needs`) as the ferret it runs
 *    inside, and `fy ask` is the shell's own list-and-answer for the owner when Agenda is off. Agenda also keeps
 *    `fy notify` (it raises a notice through the Asks port) and the owner-only views.
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
  // Conversation (optional; lead ruling 2026-11-07): Off, nothing asks Agenda for the composer's `!` menu.
  uses: { access: AccessPort, conversation: ConversationPort },
  provides: { agenda: AgendaPort },

  actions,
  ui,

  data: {
    state: [SEEN, BUZZES, MODES, NUDGES, REST_NUDGES],
    config: [AGENDA_CONFIG],
    readModels: ['open', 'daemon-agenda', 'mode'],
    ...data,
  },

  hooks,

  instructions: [{ id: 'notify', text: 'instructions/notify.md', when: { role: 'lead' } }],
  doctor: ['agenda-buzz'],
});
