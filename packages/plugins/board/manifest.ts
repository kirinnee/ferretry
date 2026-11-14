import { ProjectsPort } from '@ferretry/plugin-projects/contract';
import { type ConfigDef, defineConfig, defineState, neverLoosens } from '@ferretry/kernel/contract';
import {
  appAction,
  definePlugin,
  panel,
  renderer,
  route,
  screen,
  settingsTab,
  tool,
  verb,
} from '@ferretry/kernel/manifest';
import { AgendaContext, AskAnswered, AsksPort, AskSources } from '@ferretry/core-asks/contract';
import { ArchiveKeeps, FerretStarted, FerretsPort, SitrepLines, StartDecide } from '@ferretry/core-ferrets/contract';
import { ConversationPort, ReferenceCatalog, SearchSources, TurnEnded } from '@ferretry/plugin-conversation/contract';
import {
  BOARD_SKIPPED_AUDIT,
  BOARD_SWITCHED_AUDIT,
  BoardChanged,
  BoardConfigSchema,
  BoardFileSchema,
  BoardPort,
  CARD_ACTED_AUDIT,
  CARD_CREATED_AUDIT,
  CARD_STARTED_AUDIT,
  CardAskRefSchema,
  CardProgressToolInputSchema,
  CardMoved,
  CardMoving,
  CardSchema,
  CountersFileSchema,
  cap,
  FocusFileSchema,
  GithubFileSchema,
  LANES_CHANGED_AUDIT,
  SweepFileSchema,
} from './contract/index.ts';

// state/board/ (§9.2). A card is one file; a collection path holds one `*`.
const CARDS = defineState({ name: 'cards', path: 'cards/*.json', store: 'json', format: 1, schema: CardSchema });
const COUNTERS = defineState({
  name: 'counters',
  path: 'counters.json',
  store: 'json',
  format: 1,
  schema: CountersFileSchema,
});
/** One file per project: its lane set and whether it uses the board. Damaged = the board fails closed. */
const BOARDS = defineState({
  name: 'boards',
  path: 'boards/*.json',
  store: 'json',
  format: 1,
  schema: BoardFileSchema,
});
const SWEEP = defineState({ name: 'sweep', path: 'sweep.json', store: 'json', format: 1, schema: SweepFileSchema });
/** Which card each ferret works on, its delegation anchor and its standing skip (Ferrets keeps none of it). */
const FOCUS = defineState({ name: 'focus', path: 'focus.json', store: 'json', format: 1, schema: FocusFileSchema });
const GITHUB = defineState({ name: 'github', path: 'github.json', store: 'json', format: 1, schema: GithubFileSchema });

const BOARD_CONFIG = defineConfig({
  file: 'board.yaml',
  schema: BoardConfigSchema,
  axis: 'configure',
  loosens: neverLoosens,
}) as ConfigDef;

const fleetUse = cap('fleet', 'use');
const fleetConfigure = cap('fleet', 'configure');
const read = { skip: 'a read of cards and lanes' } as const;
const cardText = { none: 'cards are authored text; no pane, page or vault text' } as const;

/**
 * Board (§2.3): cards and lanes for the work you ask for, with each card's progress and its PRs.
 *
 * #1552 (docs/rebuild/inflight.md §2): a card is READ-ONLY STATUS. It never asks and has no answer route, verb or
 * button. Its asks are `card` obligations the Agenda shows (one answer row); answering one moves its cards.
 *
 * Ownership calls (skeletons-work):
 *  - Board owns the lane-set and switch routes of today's `board-projects` mount (`/v1/board/projects/…`): they live in
 *    `state/board/boards/<project>.json`. Projects owns only the `/v1/projects` registry.
 *  - Task plans (`card_plan`, the owner's approval routes) are Accounts' (DECISIONS-1 #16: `/v1/accounts/plans`), not Board's.
 *  - Deleted as compatibility: `/v1/tasks`, `/v1/sessions/:id/tasks` (legacy-tasks), `POST /v1/board/import`, `fy board import`.
 *  - There is no GitHub route today: the watch is a job over `state/board/github.json` and `gh`.
 *  - The `/v1/sessions/:id/…` paths are `/v1/ferrets/:ferretId/…`; `tasks` are `cards`;
 */
export default definePlugin({
  id: 'board',
  title: 'Board',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['view', 'command', 'instruction'],
  words: [
    { word: 'card', means: 'one piece of work you asked for', insteadOf: ['task', 'ticket'] },
    { word: 'lane', means: 'a column a card moves through', insteadOf: ['phase', 'column'] },
    {
      word: 'progress',
      means: 'one card’s now, done and next, written by its ferret',
      insteadOf: ['status', 'sitrep (for a card)'],
    },
  ],

  needs: { asks: AsksPort, ferrets: FerretsPort },
  // Conversation (optional, D2 #12): reopen and done delivery, nudges, alerts and the transcript tail. Off: held with a warning.
  uses: { projects: ProjectsPort, conversation: ConversationPort },
  provides: { board: BoardPort },

  actions: {
    routes: [
      route('GET /v1/board', {
        minimum: 'operator',
        caller: 'any',
        capability: fleetUse,
        noStore: true,
        compress: true,
        audit: read,
        guard: cardText,
      }),
      route('GET /v1/board/ids', {
        minimum: 'operator',
        caller: 'any',
        capability: fleetUse,
        noStore: true,
        compress: true,
        audit: read,
        guard: cardText,
      }),
      route('GET /v1/board/merge-gate', {
        minimum: 'operator',
        caller: 'any',
        capability: fleetUse,
        noStore: true,
        audit: read,
        guard: cardText,
      }),
      route('GET /v1/board/cards', {
        minimum: 'operator',
        caller: 'any',
        capability: fleetUse,
        noStore: true,
        audit: read,
        guard: cardText,
      }),
      route('POST /v1/board/cards', {
        minimum: 'operator',
        caller: 'any',
        capability: fleetUse,
        noStore: true,
        audit: { record: CARD_CREATED_AUDIT },
        guard: cardText,
      }),
      route('GET /v1/board/cards/:cardId', {
        minimum: 'operator',
        caller: 'any',
        capability: fleetUse,
        noStore: true,
        audit: read,
        guard: cardText,
      }),
      route('POST /v1/board/cards/:cardId', {
        minimum: 'operator',
        caller: 'any',
        capability: fleetUse,
        noStore: true,
        audit: { record: CARD_ACTED_AUDIT },
        guard: cardText,
      }),
      route('POST /v1/board/cards/:cardId/start', {
        minimum: 'operator',
        caller: 'person',
        capability: fleetUse,
        noStore: true,
        audit: { record: CARD_STARTED_AUDIT },
        guard: cardText,
      }),
      route('POST /v1/board/skip', {
        minimum: 'operator',
        caller: 'any',
        capability: fleetUse,
        noStore: true,
        audit: { record: BOARD_SKIPPED_AUDIT },
        guard: cardText,
      }),

      route('GET /v1/board/projects', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        audit: read,
        guard: { none: 'project names, paths and lanes only' },
      }),
      route('GET /v1/board/projects/:projectId/lanes', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        audit: read,
        guard: { none: 'lanes only' },
      }),
      route('POST /v1/board/projects/:projectId/lanes', {
        minimum: 'operator',
        caller: 'any',
        capability: fleetConfigure,
        noStore: true,
        audit: { record: LANES_CHANGED_AUDIT },
        guard: { none: 'lanes only' },
      }),
      route('GET /v1/board/projects/:projectId/switch', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        audit: read,
        guard: { none: 'a boolean' },
      }),
      route('PUT /v1/board/projects/:projectId/switch', {
        minimum: 'operator',
        caller: 'person',
        capability: fleetConfigure,
        noStore: true,
        audit: { record: BOARD_SWITCHED_AUDIT },
        guard: { none: 'a boolean' },
      }),
    ],
    agentTools: [
      // NEW name (§3.3): writes one card's progress; the same act as `POST /v1/board/cards/:cardId` with action `edit`.
      tool('card_progress', {
        minimum: 'authenticated',
        caller: 'any',
        capability: fleetUse,
        audit: { record: CARD_ACTED_AUDIT },
        guard: cardText,
        summary: 'Rewrite one card’s progress (now, doneSoFar, next).',
        input: CardProgressToolInputSchema,
      }),
    ],
    cli: [
      verb('board', {
        summary: 'the project board',
        options: [
          { flag: '--project <name>', help: 'the project to read' },
          { flag: '--ferret <id>', help: 'cards of this ferret' },
          { flag: '--kind <kind>', help: 'only cards of this kind' },
          { flag: '--pr <ref>', help: 'the card of this pull request' },
          { flag: '--activity <state>', help: 'only cards in this activity' },
          { flag: '--state <state>', help: 'only cards in this state' },
          { flag: '--query <text>', help: 'only cards matching this text' },
        ],
      }),
      verb('board status', { summary: 'whether this project uses the board' }),
      verb('board on', { summary: 'switch this project’s board on; only the owner' }),
      verb('board off', { summary: 'switch this project’s board off; only the owner' }),
      verb('board lanes propose', { summary: 'propose a lane set from a template' }),
      verb('board lanes show', { summary: 'a project’s lanes' }),
      verb('board lanes edit', { summary: 'edit a project’s lanes; the owner confirms' }),
      verb('board workflow show', { summary: 'which lanes each workflow walks' }),
      verb('board workflow edit', { summary: 'edit which lanes each workflow walks' }),
      verb('card new', { summary: 'make a card' }),
      verb('card show', { summary: 'one card; --yaml for the whole of it' }),
      verb('card move', { summary: 'move a card to a lane, with a reason' }),
      verb('card progress', { summary: 'write a card’s progress: now, done so far, next' }),
      verb('card trigger', { summary: 'report an outside event that moves a card' }),
      verb('card focus', { summary: 'make this ferret’s card the one it works on' }),
      verb('card skip', { summary: 'say this ferret needs no card, with a reason' }),
      verb('card block', { summary: 'block a card on something outside' }),
      verb('card unblock', { summary: 'clear a block' }),
      verb('card depend', { summary: 'a card waits on another until it ships or is released' }),
      verb('card undepend', { summary: 'remove a dependency' }),
      verb('card drop', { summary: 'drop a card, with a reason' }),
      verb('card reopen', { summary: 'send a card back to a lane with the owner’s words' }),
      verb('card clarify', { summary: 'add a clarification to a card' }),
      verb('card link', { summary: 'link a PR, branch, commit or doc' }),
      verb('card assign', { summary: 'give a card to a ferret' }),
      verb('card claim', { summary: 'take a card for this ferret' }),
      verb('card adopt', { summary: 'take over a card whose ferret is gone' }),
      verb('card note', { summary: 'add a note to a card’s transcript' }),
      verb('card order', { summary: 'place a card in its lane' }),
      verb('card reparent', { summary: 'move a card under another card' }),
      verb('card file', { summary: 'claim a file for a card' }),
      verb('card merge-gate', { summary: 'what a PR waits on before it may merge' }),
      verb('card edit', { summary: 'edit a card’s text fields' }),
      verb('card patch', { summary: 'edit a card from a file' }),
      verb('card refile', { summary: 'move a card to another project’s board' }),
    ],
    app: [
      appAction('card.move', { on: 'card', label: 'Move', calls: 'POST /v1/board/cards/:cardId' }),
      appAction('card.start', { on: 'card', label: 'Start a ferret', calls: 'POST /v1/board/cards/:cardId/start' }),
    ],
  },

  ui: {
    screens: [
      screen('board', { path: 'board/:project?', nav: { label: 'Board', icon: 'columns', order: 30 } }),
      screen('card', { path: 'card/:id' }),
    ],
    panels: [
      panel('ferret.side', { id: 'cards-of-ferret', order: 20 }),
      panel('card.detail', { id: 'card-progress', order: 10 }),
    ],
    settings: [settingsTab('board', { label: 'Board', order: 40 })],
    renderers: [renderer('ask', { source: 'card' }), renderer('reference', { prefix: '&' })],
  },

  data: {
    state: [CARDS, COUNTERS, BOARDS, SWEEP, FOCUS, GITHUB],
    config: [BOARD_CONFIG],
    readModels: ['cards', 'progress', 'lanes'],
    publishes: [CardMoved, BoardChanged],
    subscribes: [AskAnswered],
  },

  hooks: {
    takes: [
      // The `card` ask source: a card's gate entry is an obligation `{ source: 'card', ref, entry }` Asks holds.
      { hook: AskSources, key: 'card', schema: CardAskRefSchema },
      { hook: StartDecide, priority: 60 },
      { hook: SitrepLines, priority: 50 },
      // The turn-end checks (D2 #12) and a started ferret's card (Ferrets' additive `ferret.started`).
      { hook: TurnEnded },
      { hook: FerretStarted },
      // Board's cards are work Conversation's search finds (`search.sources`).
      { hook: SearchSources },
      // The `&` menu of a ferret's composer: its cards (reference.catalog, lead ruling 2026-11-07). Asked only when Conversation is on.
      { hook: ReferenceCatalog, key: '&' },
      // The session archive's keep rule (Ferrets' `session.archive-keeps`): every card, so a ferret on one in flight stays live.
      { hook: ArchiveKeeps },
      // Asks' agenda reads a ferret's focus card, the to-test lane and a card's gate ask from here (`agenda.context`).
      { hook: AgendaContext, key: 'board' },
    ],
    offers: [{ hook: CardMoving, timeoutMs: 200 }],
  },

  instructions: [{ id: 'board', text: 'instructions/board.md', when: { role: 'any' } }],
  doctor: ['board-store'],
  permissions: { roots: [], network: ['api.github.com'], spawn: ['gh', 'git', 'ssh'], secrets: [] },
});
