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
        args: [],
        options: [
          {
            flag: '--project <name|all>',
            help: "a project's name or id, or `all`; default: the board of the calling session",
          },
          { flag: '--ferret <name>', help: 'only cards this ferret (callsign or session id) owns or is assigned' },
          { flag: '--mine', help: 'only cards the calling session owns or is assigned' },
          { flag: '--kind <kind>', help: 'only bug | feature | infra | chore' },
          { flag: '--pr <state>', help: 'only cards whose PR is none | draft | open | ci_red | merged | released' },
          { flag: '--activity <activity>', help: 'only active | idle | stale | orphaned | blocked' },
          { flag: '--state <state>', help: 'open | closed | dropped | all (default open)' },
          { flag: '--closed', help: 'show the closed cards, which are hidden by default' },
          {
            flag: '--private',
            help: "show the private cards (the ferrets' own bookkeeping) instead of the public ones",
          },
          { flag: '--all', help: 'show public and private cards' },
          { flag: '--query <text>', help: 'only cards whose id, title, summary or ask contain this text' },
          { flag: '--session <id>', help: 'act as this session instead of the ambient FY_SESSION_ID' },
          { flag: '--json', help: 'print the daemon response as JSON' },
          { flag: '--md', help: 'render the board as markdown' },
        ],
      }),
      verb('board status', {
        summary: 'whether this project uses the board',
        args: [],
        options: [
          { flag: '--project <name>', help: "the project's name or id; default: the board of the calling session" },
          { flag: '--json', help: 'print the daemon response as JSON' },
        ],
      }),
      verb('board on', {
        summary: 'switch this project’s board on; only the owner',
        args: [],
        options: [
          { flag: '--project <name>', help: "the project's name or id; default: the board of the calling session" },
          { flag: '--json', help: 'print the daemon response as JSON' },
        ],
      }),
      verb('board off', {
        summary: 'switch this project’s board off; only the owner',
        args: [],
        options: [
          { flag: '--project <name>', help: "the project's name or id; default: the board of the calling session" },
          { flag: '--json', help: 'print the daemon response as JSON' },
        ],
      }),
      verb('board lanes propose', {
        summary: 'propose a lane set from a template',
        args: [],
        options: [
          { flag: '--project <name>', help: "the project's name or id; default: the board of the calling session" },
          { flag: '--json', help: 'print the daemon response as JSON' },
          { flag: '--template <template>', help: 'pr-release-verify | pr-release | pr | ops | writing | quick' },
          {
            flag: '--rename <old=new>',
            help: 'give a template lane another name, by lane id (repeatable) (default: [])',
          },
        ],
      }),
      verb('board lanes show', {
        summary: 'a project’s lanes',
        args: [],
        options: [
          { flag: '--project <name>', help: "the project's name or id; default: the board of the calling session" },
          { flag: '--json', help: 'print the daemon response as JSON' },
        ],
      }),
      verb('board lanes edit', {
        summary: 'edit a project’s lanes; the owner confirms',
        args: [],
        options: [
          { flag: '--project <name>', help: "the project's name or id; default: the board of the calling session" },
          { flag: '--json', help: 'print the daemon response as JSON' },
          { flag: '--rename <old=new>', help: 'give a lane another name, by lane id (repeatable) (default: [])' },
          { flag: '--remove <lane>', help: 'remove a lane by id (repeatable) (default: [])' },
          { flag: '--into <lane>', help: 'the lane that receives the cards of every removed lane' },
        ],
      }),
      verb('board workflow show', {
        summary: 'which lanes each workflow walks',
        args: [],
        options: [
          { flag: '--project <name>', help: "the project's name or id; default: the board of the calling session" },
          { flag: '--json', help: 'print the daemon response as JSON' },
        ],
      }),
      verb('board workflow edit', {
        summary: 'edit which lanes each workflow walks',
        args: [],
        options: [
          { flag: '--project <name>', help: "the project's name or id; default: the board of the calling session" },
          { flag: '--json', help: 'print the daemon response as JSON' },
          { flag: '--lane <id>', help: 'the lane to change, by id (see `workflow show`)' },
          {
            flag: '--gate <label=outcome>',
            help: 'an option of the gate, up to 3: "<Label>=<next|close|reopen|lane:<id>>" (repeatable); Label is at most 24 characters (default: [])',
          },
          {
            flag: '--auto <triggers>',
            help: 'make the lane automatic: the triggers that move a card in, comma separated, or "none" when the ferret moves it',
          },
        ],
      }),
      verb('card new', {
        summary: 'make a card',
        args: [
          { name: 'title', help: 'the title, if you would rather not repeat --title', optional: true, variadic: true },
        ],
        options: [
          { flag: '--session <id>', help: 'act as this session instead of the ambient FY_SESSION_ID' },
          { flag: '--json', help: 'print the daemon response as JSON' },
          { flag: '-k, --kind <kind>', help: 'one of bug | feature | infra | chore' },
          {
            flag: '-t, --title <title>',
            help: 'Keep the task title to 5 words or fewer; move scope and implementation detail into the description.',
          },
          { flag: '--summary <line>', help: 'one line for the card face' },
          { flag: '--ask <text>', help: "the human's words, verbatim" },
          { flag: '--ask-source <link>', help: 'where those words came from' },
          {
            flag: '--premise <point>',
            help: 'why this work exists; a plain line, no leading "- " (repeat for more points) (default: [])',
          },
          {
            flag: '--context <point>',
            help: 'what a newcomer needs to know; a plain line, no leading "- " (repeat for more points) (default: [])',
          },
          { flag: '--term <term=meaning>', help: 'a glossary entry (repeatable) (default: [])' },
          { flag: '--brief <text>', help: 'the full description or plan' },
          { flag: '--brief-file <path>', help: 'read the brief from a file instead' },
          {
            flag: '--how-to-test <md>',
            help: 'how the owner checks it before Done (markdown, a numbered list): where to go, what to do, what they should see',
          },
          { flag: '--how-to-test-file <path>', help: 'read How to test from a file instead' },
          { flag: '--workflow <workflow>', help: 'one of quick | design-first | research-first | investigate' },
          { flag: '--depends-on <id>', help: 'a task this one waits on (repeatable) (default: [])' },
          {
            flag: '--parent <id>',
            help: "the task this one is part of; a sub-card is private, so never for the owner's asks",
          },
          {
            flag: '--approval <id>',
            help: 'where the board is off: your answered "Track this on the board?" item (!A12) the owner said Yes to',
          },
          {
            flag: '--thread <id>',
            help: 'the open thread on your agenda (!A12) this card carries out; the owner is already asked there, so the card is your own errand',
          },
          { flag: '--assignee <who>', help: 'the ferret doing it: a callsign or a session id' },
          { flag: '--project <name>', help: 'the board to create it on; default: the board of the calling session' },
          { flag: '--lane <lane>', help: "the lane to start in; default: the workflow's first" },
          {
            flag: '--file <path>',
            help: "a file or folder the work will touch (repeatable); overlapping an open card's claim queues this card's merge behind it (default: [])",
          },
          { flag: '--pr <url>', help: 'a pull request link (repeatable) (default: [])' },
          { flag: '--branch <branch>', help: 'the branch it is built on' },
          { flag: '--doc <path>', help: 'a document link (repeatable) (default: [])' },
          { flag: '--related <id>', help: 'a card this belongs to: add it there as a note and create nothing' },
          { flag: '--new', help: 'create even if a card on the same thing exists' },
          {
            flag: '--private',
            help: "a ferret's own bookkeeping: off the default board (default for a card an agent asked for)",
          },
          {
            flag: '--public',
            help: 'a card the owner sees on the default board (default for a card a person asked for)',
          },
          {
            flag: '--broad <why>',
            help: 'create a card that gathers several outcomes, saying why it must be one card',
          },
        ],
      }),
      verb('card show', {
        summary: 'one card; --yaml for the whole of it',
        args: [{ name: 'id', help: 'the task id: &F21 (or F21)' }],
        options: [
          { flag: '--session <id>', help: 'act as this session instead of the ambient FY_SESSION_ID' },
          { flag: '--json', help: 'print the daemon response as JSON' },
          { flag: '--yaml', help: 'print the editable document `task patch` takes back, with its revision' },
        ],
      }),
      verb('card move', {
        summary: 'move a card to a lane, with a reason',
        args: [
          { name: 'id', help: 'the task id: &F21 (or F21)' },
          { name: 'lane', help: "the lane's id or name (see `fy board lanes show`)" },
        ],
        options: [
          { flag: '--session <id>', help: 'act as this session instead of the ambient FY_SESSION_ID' },
          { flag: '--json', help: 'print the daemon response as JSON' },
          { flag: '--reason <why>', help: 'why it moved; required for a move back' },
        ],
      }),
      verb('card progress', {
        summary: 'write a card’s progress: now, done so far, next',
        args: [{ name: 'id', help: 'the card, like &F21' }],
        options: [
          { flag: '--now <text>', help: 'what is happening right now' },
          { flag: '--done <text>', help: 'what is done so far; repeat for more' },
          { flag: '--next <text>', help: 'what comes next; repeat for more' },
          { flag: '--json', help: 'print the answer as JSON' },
        ],
      }),
      verb('card trigger', {
        summary: 'report an outside event that moves a card',
        args: [
          { name: 'id', help: 'the task id: &F21 (or F21)' },
          { name: 'event', help: 'the event: pr.review_approved | deploy.done' },
        ],
        options: [
          { flag: '--session <id>', help: 'act as this session instead of the ambient FY_SESSION_ID' },
          { flag: '--json', help: 'print the daemon response as JSON' },
          { flag: '--reason <why>', help: 'what happened, kept in the card history' },
        ],
      }),
      verb('card focus', {
        summary: 'make this ferret’s card the one it works on',
        args: [{ name: 'id', help: 'the task id: &F21 (or F21)' }],
        options: [
          { flag: '--session <id>', help: 'act as this session instead of the ambient FY_SESSION_ID' },
          { flag: '--json', help: 'print the daemon response as JSON' },
        ],
      }),
      verb('card skip', {
        summary: 'say this ferret needs no card, with a reason',
        args: [{ name: 'why', help: 'why: chit-chat, or the owner said not to track it', variadic: true }],
        options: [
          { flag: '--session <id>', help: 'act as this session instead of the ambient FY_SESSION_ID' },
          { flag: '--json', help: 'print the daemon response as JSON' },
        ],
      }),
      verb('card block', {
        summary: 'block a card on something outside',
        args: [
          { name: 'id', help: 'the task id: &F21 (or F21)' },
          { name: 'why', help: 'what it is waiting on', variadic: true },
        ],
        options: [
          { flag: '--session <id>', help: 'act as this session instead of the ambient FY_SESSION_ID' },
          { flag: '--json', help: 'print the daemon response as JSON' },
        ],
      }),
      verb('card unblock', {
        summary: 'clear a block',
        args: [{ name: 'id', help: 'the task id: &F21 (or F21)' }],
        options: [
          { flag: '--session <id>', help: 'act as this session instead of the ambient FY_SESSION_ID' },
          { flag: '--json', help: 'print the daemon response as JSON' },
          { flag: '--reason <why>', help: 'what changed' },
        ],
      }),
      verb('card depend', {
        summary: 'a card waits on another until it ships or is released',
        args: [
          { name: 'id', help: 'the task id: &F21 (or F21)' },
          { name: 'dependency', help: 'the task it waits on' },
        ],
        options: [
          { flag: '--session <id>', help: 'act as this session instead of the ambient FY_SESSION_ID' },
          { flag: '--json', help: 'print the daemon response as JSON' },
          { flag: '--until <when>', help: 'shipped | released (default shipped)' },
          { flag: '--override <why>', help: 'owner only: let it advance although the dependency is not done' },
        ],
      }),
      verb('card undepend', {
        summary: 'remove a dependency',
        args: [
          { name: 'id', help: 'the task id: &F21 (or F21)' },
          { name: 'dependency', help: 'the task it no longer waits on' },
        ],
        options: [
          { flag: '--session <id>', help: 'act as this session instead of the ambient FY_SESSION_ID' },
          { flag: '--json', help: 'print the daemon response as JSON' },
          { flag: '--reason <why>', help: 'why the dependency goes away' },
        ],
      }),
      verb('card drop', {
        summary: 'drop a card, with a reason',
        args: [{ name: 'id', help: 'the task id: &F21 (or F21)' }],
        options: [
          { flag: '--session <id>', help: 'act as this session instead of the ambient FY_SESSION_ID' },
          { flag: '--json', help: 'print the daemon response as JSON' },
          { flag: '--reason <why>', help: 'why it is dropped; the history keeps this' },
        ],
      }),
      verb('card reopen', {
        summary: 'send a card back to a lane with the owner’s words',
        args: [{ name: 'id', help: 'the task id: &F21 (or F21)' }],
        options: [
          { flag: '--session <id>', help: 'act as this session instead of the ambient FY_SESSION_ID' },
          { flag: '--json', help: 'print the daemon response as JSON' },
          { flag: '--to <lane>', help: 'the lane to reopen it into' },
          { flag: '--ask <words>', help: "the owner's new words, verbatim" },
          { flag: '--source <link>', help: 'where those words came from' },
          { flag: '--reason <why>', help: 'why it is being reopened' },
        ],
      }),
      verb('card clarify', {
        summary: 'add a clarification to a card',
        args: [
          { name: 'id', help: 'the task id: &F21 (or F21)' },
          { name: 'text', help: 'the clarification, verbatim', variadic: true },
        ],
        options: [
          { flag: '--session <id>', help: 'act as this session instead of the ambient FY_SESSION_ID' },
          { flag: '--json', help: 'print the daemon response as JSON' },
          { flag: '--source <link>', help: 'where it came from' },
        ],
      }),
      verb('card link', {
        summary: 'link a PR, branch, commit or doc',
        args: [{ name: 'id', help: 'the task id: &F21 (or F21)' }],
        options: [
          { flag: '--session <id>', help: 'act as this session instead of the ambient FY_SESSION_ID' },
          { flag: '--json', help: 'print the daemon response as JSON' },
          { flag: '--pr <url>', help: 'a pull request' },
          { flag: '--branch <branch>', help: 'the branch' },
          { flag: '--commit <sha>', help: 'a commit' },
          { flag: '--doc <path>', help: 'a document' },
        ],
      }),
      verb('card assign', {
        summary: 'give a card to a ferret',
        args: [
          { name: 'id', help: 'the task id: &F21 (or F21)' },
          { name: 'who', help: 'the ferret: a callsign or a session id', optional: true },
        ],
        options: [
          { flag: '--session <id>', help: 'act as this session instead of the ambient FY_SESSION_ID' },
          { flag: '--json', help: 'print the daemon response as JSON' },
          { flag: '--none', help: 'unassign instead' },
        ],
      }),
      verb('card claim', {
        summary: 'take a card for this ferret',
        args: [{ name: 'id', help: 'the task id: &F21 (or F21)' }],
        options: [
          { flag: '--session <id>', help: 'act as this session instead of the ambient FY_SESSION_ID' },
          { flag: '--json', help: 'print the daemon response as JSON' },
        ],
      }),
      verb('card adopt', {
        summary: 'take over a card whose ferret is gone',
        args: [{ name: 'id', help: 'the task id: &F21 (or F21)' }],
        options: [
          { flag: '--session <id>', help: 'act as this session instead of the ambient FY_SESSION_ID' },
          { flag: '--json', help: 'print the daemon response as JSON' },
          { flag: '--reason <why>', help: 'why you take it; kept in its history' },
        ],
      }),
      verb('card note', {
        summary: 'add a note to a card’s transcript',
        args: [
          { name: 'id', help: 'the task id: &F21 (or F21)' },
          { name: 'text', help: 'what to record', variadic: true },
        ],
        options: [
          { flag: '--session <id>', help: 'act as this session instead of the ambient FY_SESSION_ID' },
          { flag: '--json', help: 'print the daemon response as JSON' },
        ],
      }),
      verb('card order', {
        summary: 'place a card in its lane',
        args: [
          { name: 'id', help: 'the task id: &F21 (or F21)' },
          { name: 'rank', help: 'a whole number', optional: true },
        ],
        options: [
          { flag: '--session <id>', help: 'act as this session instead of the ambient FY_SESSION_ID' },
          { flag: '--json', help: 'print the daemon response as JSON' },
          { flag: '--none', help: 'clear the rank instead' },
        ],
      }),
      verb('card reparent', {
        summary: 'move a card under another card',
        args: [{ name: 'id', help: 'the task id: &F21 (or F21)' }],
        options: [
          { flag: '--session <id>', help: 'act as this session instead of the ambient FY_SESSION_ID' },
          { flag: '--json', help: 'print the daemon response as JSON' },
          { flag: '--parent <id>', help: 'the card it goes under: &F21 (or F21)' },
          { flag: '--none', help: 'make it a top-level card instead' },
          { flag: '--reason <why>', help: 'why it moves; kept in its history' },
        ],
      }),
      verb('card file', {
        summary: 'claim a file for a card',
        args: [
          { name: 'id', help: 'the task id: &F21 (or F21)' },
          { name: 'path', help: 'the file or folder being claimed, relative to the repository' },
        ],
        options: [
          { flag: '--session <id>', help: 'act as this session instead of the ambient FY_SESSION_ID' },
          { flag: '--json', help: 'print the daemon response as JSON' },
          { flag: '--remove', help: 'release the claim instead of taking it' },
          { flag: '--reason <why>', help: 'optional context' },
        ],
      }),
      verb('card merge-gate', {
        summary: 'what a PR waits on before it may merge',
        args: [{ name: 'pr-url', help: 'the pull request, https://github.com/<owner>/<repo>/pull/<n>' }],
      }),
      verb('card edit', {
        summary: 'edit a card’s text fields',
        args: [{ name: 'id', help: 'the task id: &F21 (or F21)' }],
        options: [
          { flag: '--session <id>', help: 'act as this session instead of the ambient FY_SESSION_ID' },
          { flag: '--json', help: 'print the daemon response as JSON' },
          {
            flag: '--title <title>',
            help: 'Keep the task title to 5 words or fewer; move scope and implementation detail into the description.',
          },
          { flag: '--summary <line>', help: 'one line for the card face' },
          {
            flag: '--premise <point>',
            help: 'replace why this work exists; a plain line, no leading "- " (repeat for more points) (default: [])',
          },
          {
            flag: '--context <point>',
            help: 'replace what a newcomer needs to know; a plain line, no leading "- " (repeat for more points) (default: [])',
          },
          { flag: '--term <term=meaning>', help: 'replace the glossary with these entries (repeatable) (default: [])' },
          { flag: '--brief <text>', help: 'the full description or plan' },
          { flag: '--brief-file <path>', help: 'read the brief from a file instead' },
          {
            flag: '--how-to-test <md>',
            help: 'how the owner checks it before Done (markdown, a numbered list): where to go, what to do, what they should see',
          },
          { flag: '--how-to-test-file <path>', help: 'read How to test from a file instead' },
          {
            flag: '--status-now <md>',
            help: "the card's status, Now: what is happening this moment (markdown); replaces that part, the others stay",
          },
          {
            flag: '--status-done <md>',
            help: "the card's status, Done so far: what is implemented, one bullet each with its PR link (markdown); replaces that part",
          },
          {
            flag: '--status-next <md>',
            help: "the card's status, Next: what comes after, in order (markdown); replaces that part",
          },
          {
            flag: '--status-file <path>',
            help: "the card's current state, rewritten whole, from YAML or JSON { now, doneSoFar, next } (`-` reads stdin): **Now** / **Done so far** (PR links) / **Next** (markdown)",
          },
          {
            flag: '--visibility <public|private>',
            help: "who sees it on the default board; only the owner hides the owner's ask",
          },
        ],
      }),
      verb('card patch', {
        summary: 'edit a card from a file',
        args: [{ name: 'id', help: 'the task id: &F21 (or F21)' }],
        options: [
          { flag: '--session <id>', help: 'act as this session instead of the ambient FY_SESSION_ID' },
          { flag: '--json', help: 'print the daemon response as JSON' },
          { flag: '-f, --file <path>', help: 'the YAML or JSON document; - (the default) reads standard input' },
        ],
      }),
      verb('card refile', {
        summary: 'move a card to another project’s board',
        args: [{ name: 'id', help: 'the task id: &F21 (or F21)' }],
        options: [
          { flag: '--session <id>', help: 'act as this session instead of the ambient FY_SESSION_ID' },
          { flag: '--json', help: 'print the daemon response as JSON' },
          { flag: '--project <name>', help: 'the board it moves to' },
          { flag: '--lane <lane>', help: 'the lane there; default: the same-category lane' },
          { flag: '--reason <why>', help: 'why it moves' },
        ],
      }),
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
    settings: [settingsTab('board', { group: 'agent-settings', label: 'Board', order: 40 })],
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
