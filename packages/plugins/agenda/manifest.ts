import { type ConfigDef, defineConfig, defineState, neverLoosens } from '@ferretry/kernel/contract';
import { appAction, definePlugin, panel, route, screen, settingsTab, verb } from '@ferretry/kernel/manifest';
import {
  AGENDA_CLEARED_AUDIT,
  AGENDA_MODE_CHANGED_AUDIT,
  AgendaBuzzed,
  AgendaConfigSchema,
  AgendaModeChanged,
  AgendaPort,
  BuzzRecordSchema,
  MACHINE_AGENDA_ACTED_AUDIT,
  SeenFileSchema,
} from './contract/index.ts';
import { AskAnswered, AsksPort } from './contract/core.ts';
import { AccessPort } from './contract/others.ts';

const SEEN = defineState({ name: 'seen', path: 'seen.json', store: 'json', format: 1, schema: SeenFileSchema });
/** The buzz ledger: one line per moment the phone was buzzed, so a restart never buzzes twice. */
const BUZZES = defineState({
  name: 'buzzes',
  path: 'buzzes.jsonl',
  store: 'jsonl',
  format: 1,
  schema: BuzzRecordSchema,
});

const AGENDA_CONFIG = defineConfig({
  file: 'agenda.yaml',
  schema: AgendaConfigSchema,
  axis: 'configure',
  loosens: neverLoosens,
}) as ConfigDef;

/**
 * Agenda (§2.3): your list of asks and notices, grouped, with buzzes to your phone. The asks themselves are Asks'
 * (core); this is the view, the tabs, the modes and the buzz policy, and the daemon's own agenda.
 *
 * Ownership calls (skeletons-work):
 *  - The per-ferret item routes (`/v1/ferrets/:ferret/agenda…`: raise, patch, reply, versions, conversation, seen) are
 *    ASKS', not declared here: answering is a security act (§2.2). So are the `fy agenda add|answer|…` item verbs, which
 *    become `fy ask`. Agenda keeps `fy notify` (it raises a notice through the Asks port) and the owner-only views.
 *  - The push routes (`/v1/push/*`) are ACCESS': `push.json` and `push-keys.json` are Access state (§9.2). Agenda sends a
 *    buzz through Access's port (`uses`).
 *  - `GET|PATCH /v1/ferrets/:ferret/agenda-mode` is Agenda's (ports/agenda.md lists session/agenda-mode with it).
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

  needs: { asks: AsksPort },
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
      route('GET /v1/ferrets/:ferret/agenda-mode', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        audit: { skip: 'a read of one switch' },
        guard: { none: 'a boolean and a sentence' },
      }),
      route('PATCH /v1/ferrets/:ferret/agenda-mode', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        audit: { record: AGENDA_MODE_CHANGED_AUDIT },
        guard: { none: 'a boolean and a sentence' },
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
    panels: [panel('ferret.side', { id: 'ferret-agenda', order: 10 })],
    settings: [settingsTab('agenda', { label: 'Agenda', order: 20 })],
  },

  data: {
    state: [SEEN, BUZZES],
    config: [AGENDA_CONFIG],
    readModels: ['open', 'daemon-agenda', 'mode'],
    publishes: [AgendaModeChanged, AgendaBuzzed],
    subscribes: [AskAnswered],
  },

  instructions: [{ id: 'notify', text: 'instructions/notify.md', when: { role: 'any' } }],
  doctor: ['agenda-buzz'],
});
