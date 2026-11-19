/** The agenda roll-up: the owner's list screen and its ask page, the side panel, the settings tab, and `fy agenda` / `fy agenda open`. */
import { manifestFragment, panel, route, screen, settingsTab, verb } from '@ferretry/kernel/manifest';
import type { VerbOptionDecl } from '@ferretry/kernel/manifest';
import { AGENDA_CLEARED_AUDIT } from '../../contract/index.ts';

/**
 * The board an item verb acts on, declared on the PARENT too: the shell reads the word after a valued option as that
 * option's value and never as a sub-verb, so `agenda --session done dismiss A1` is `dismiss A1` on the board named "done"
 * (a callsign may equal a verb), and `agenda --session f1 ls` is `ls` on f1.
 */
const TARGET: readonly VerbOptionDecl[] = [
  {
    flag: '-s, --session <id>',
    help: 'target another session; an agent may mutate only its own session; a lead may also edit, surface, done or dismiss in a sub-ferret it started (defaults to the current session)',
  },
  { flag: '--ferret <id>', help: 'the same as --session (`agenda mode` reads it as the ferret to switch)' },
];

const PAGING: readonly VerbOptionDecl[] = [
  { flag: '--limit <n>', help: 'how many asks a page holds' },
  { flag: '--after <cursor>', help: 'continue after the cursor a page named' },
];

export default manifestFragment({
  routes: [
    route('GET /v1/agenda/open', {
      minimum: 'operator',
      caller: 'person',
      noStore: true,
      audit: { skip: 'a read of the roll-up' },
      guard: { none: 'asks are authored text; no pane, page or vault text' },
    }),
    // `fy agenda clear` and its page button live in 50-clear-agents; the route stays here because a route's place in the
    // list is part of the package's contract hash, and it sits between the roll-up read and the mode routes.
    route('POST /v1/agenda/clear-agents', {
      minimum: 'operator',
      caller: 'person',
      noStore: true,
      audit: { record: AGENDA_CLEARED_AUDIT },
      guard: { none: 'answers two counts' },
    }),
  ],
  cli: [
    verb('agenda', {
      summary: 'what is waiting on you, grouped',
      args: [{ name: 'verb', help: 'what to do: one of the commands below', optional: true, variadic: true }],
      options: [
        ...TARGET,
        { flag: '--json', help: 'print the protocol payload instead of the human rendering' },
        ...PAGING,
      ],
    }),
    verb('agenda open', {
      summary: 'every ferret’s open and parked asks, paged',
      args: [],
      options: [
        { flag: '--limit <n>', help: 'how many to show' },
        { flag: '--after <cursor>', help: 'continue after the cursor a page named' },
        { flag: '--json', help: 'print the answer as JSON' },
      ],
    }),
  ],
  ui: {
    screens: [
      screen('agenda', { path: 'agenda', nav: { label: 'Agenda', icon: 'inbox', order: 10 } }),
      screen('agenda-ask', { path: 'agenda/:ferret/:ask' }),
    ],
    panels: [panel('ferret.side', { id: 'ferret-agenda', order: 10 })],
    settings: [settingsTab('agenda', { icon: 'inbox', group: 'agent-settings', label: 'Agenda', order: 20 })],
    // The ask page OFFERS the `agenda.conversation` slot (contract/slots.ts, lead decision Q9): Conversation contributes
    // the ferret's conversation and composer under an open ask; Agenda imports nothing of Conversation's.
  },
});
