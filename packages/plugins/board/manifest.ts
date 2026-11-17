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
import { AgendaContext, AskAnswered, AsksPort, askReference, AskSources } from '@ferretry/core-asks/contract';
import { ArchiveKeeps, FerretStarted, FerretsPort, SitrepLines, StartDecide } from '@ferretry/core-ferrets/contract';
import { ConversationPort, ReferenceCatalog, SearchSources, TurnEnded } from '@ferretry/plugin-conversation/contract';
import {
  BOARD_SKIPPED_AUDIT,
  BOARD_SWITCHED_AUDIT,
  BoardChanged,
  BoardConfigSchema,
  BoardFileSchema,
  BoardPort,
  TASK_ACTED_AUDIT,
  TASK_CREATED_AUDIT,
  TASK_STARTED_AUDIT,
  CardAskRefSchema,
  CardProgressToolInputSchema,
  TaskProgressToolInputSchema,
  CardMoved,
  CardMoving,
  CardSchema,
  CountersFileSchema,
  cap,
  FocusFileSchema,
  formerPath,
  GithubFileSchema,
  LANES_CHANGED_AUDIT,
  SweepFileSchema,
} from './contract/index.ts';

// state/board/ (§9.2). A task is one file; a collection path holds one `*`.
const TASKS = defineState({ name: 'cards', path: 'cards/*.json', store: 'json', format: 1, schema: CardSchema });
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
/** Which task each ferret works on, its delegation anchor and its standing skip (Ferrets keeps none of it). */
const FOCUS = defineState({ name: 'focus', path: 'focus.json', store: 'json', format: 1, schema: FocusFileSchema });
const GITHUB = defineState({ name: 'github', path: 'github.json', store: 'json', format: 1, schema: GithubFileSchema });

const BOARD_CONFIG = defineConfig({
  file: 'board.yaml',
  schema: BoardConfigSchema,
  axis: 'configure',
  loosens: neverLoosens,
}) as ConfigDef;

/** A route about one task, and the same route under its former path: one descriptor, so the guard, grant and audit are one. */
const taskRoute = <const Key extends string>(key: Key, descriptor: Parameters<typeof route>[1]) =>
  [route(key, descriptor), route(formerPath(key), descriptor)] as const;

const fleetUse = cap('fleet', 'use');
const fleetConfigure = cap('fleet', 'configure');
const read = { skip: 'a read of tasks and lanes' } as const;
const taskText = { none: 'tasks are authored text; no pane, page or vault text' } as const;

/**
 * Board (§2.3): tasks and lanes for the work you ask for, with each task's progress and its PRs.
 *
 * #1552 (docs/rebuild/inflight.md §2): a task is READ-ONLY STATUS. It never asks and has no answer route, verb or
 * button. Its asks are `task` obligations the Agenda shows (one answer row); answering one moves its tasks.
 *
 * Ownership calls (skeletons-work):
 *  - Board owns the lane-set and switch routes of today's `board-projects` mount (`/v1/board/projects/…`): they live in
 *    `state/board/boards/<project>.json`. Projects owns only the `/v1/projects` registry.
 *  - Task plans (`card_plan`, the owner's approval routes) are Accounts' (DECISIONS-1 #16: `/v1/accounts/plans`), not Board's.
 *  - Deleted as compatibility: `/v1/tasks`, `/v1/sessions/:id/tasks` (legacy-tasks), `POST /v1/board/import`, `fy board import`.
 *  - There is no GitHub route today: the watch is a job over `state/board/github.json` and `gh`.
 *  - The `/v1/sessions/:id/…` paths are `/v1/ferrets/:ferretId/…`; `tasks` are `tasks`;
 */
export default definePlugin({
  id: 'board',
  title: 'Board',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['view', 'command', 'instruction'],
  words: [
    { word: 'task', means: 'one piece of work you asked for', insteadOf: ['card', 'ticket'] },
    { word: 'lane', means: 'a column a task moves through', insteadOf: ['phase', 'column'] },
    {
      word: 'progress',
      means: 'one task’s now, done and next, written by its ferret',
      insteadOf: ['status', 'sitrep (for a task)'],
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
        guard: taskText,
      }),
      route('GET /v1/board/ids', {
        minimum: 'operator',
        caller: 'any',
        capability: fleetUse,
        noStore: true,
        compress: true,
        audit: read,
        guard: taskText,
      }),
      route('GET /v1/board/merge-gate', {
        minimum: 'operator',
        caller: 'any',
        capability: fleetUse,
        noStore: true,
        audit: read,
        guard: taskText,
      }),
      ...taskRoute('GET /v1/board/tasks', {
        minimum: 'operator',
        caller: 'any',
        capability: fleetUse,
        noStore: true,
        audit: read,
        guard: taskText,
      }),
      ...taskRoute('POST /v1/board/tasks', {
        minimum: 'operator',
        caller: 'any',
        capability: fleetUse,
        noStore: true,
        audit: { record: TASK_CREATED_AUDIT },
        guard: taskText,
      }),
      ...taskRoute('GET /v1/board/tasks/:taskId', {
        minimum: 'operator',
        caller: 'any',
        capability: fleetUse,
        noStore: true,
        audit: read,
        guard: taskText,
      }),
      ...taskRoute('POST /v1/board/tasks/:taskId', {
        minimum: 'operator',
        caller: 'any',
        capability: fleetUse,
        noStore: true,
        audit: { record: TASK_ACTED_AUDIT },
        guard: taskText,
      }),
      ...taskRoute('POST /v1/board/tasks/:taskId/start', {
        minimum: 'operator',
        caller: 'person',
        // c58-sec3 r1: starting a task starts a ferret (the task text is its prompt), so it asks what `POST /v1/ferrets` asks.
        capability: fleetConfigure,
        noStore: true,
        audit: { record: TASK_STARTED_AUDIT },
        guard: taskText,
      }),
      route('POST /v1/board/skip', {
        minimum: 'operator',
        caller: 'any',
        capability: fleetUse,
        noStore: true,
        audit: { record: BOARD_SKIPPED_AUDIT },
        guard: taskText,
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
      // Writes one task's progress; the same act as `POST /v1/board/tasks/:taskId` with action `edit`.
      tool('task_progress', {
        minimum: 'authenticated',
        caller: 'any',
        capability: fleetUse,
        audit: { record: TASK_ACTED_AUDIT },
        guard: taskText,
        summary: 'Rewrite one task’s progress (now, doneSoFar, next).',
        input: TaskProgressToolInputSchema,
      }),
      // The old name of task_progress, on the same handler: an old instruction still works.
      tool('card_progress', {
        minimum: 'authenticated',
        caller: 'any',
        capability: fleetUse,
        audit: { record: TASK_ACTED_AUDIT },
        guard: taskText,
        summary: 'old name of task_progress',
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
          { flag: '--ferret <name>', help: 'only tasks this ferret (callsign or session id) owns or is assigned' },
          { flag: '--mine', help: 'only tasks the calling session owns or is assigned' },
          { flag: '--kind <kind>', help: 'only bug | feature | infra | chore' },
          { flag: '--pr <state>', help: 'only tasks whose PR is none | draft | open | ci_red | merged | released' },
          { flag: '--activity <activity>', help: 'only active | idle | stale | orphaned | blocked' },
          { flag: '--state <state>', help: 'open | closed | dropped | all (default open)' },
          { flag: '--closed', help: 'show the closed tasks, which are hidden by default' },
          {
            flag: '--private',
            help: "show the private tasks (the ferrets' own bookkeeping) instead of the public ones",
          },
          { flag: '--all', help: 'show public and private tasks' },
          { flag: '--query <text>', help: 'only tasks whose id, title, summary or ask contain this text' },
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
          { flag: '--into <lane>', help: 'the lane that receives the tasks of every removed lane' },
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
            help: 'make the lane automatic: the triggers that move a task in, comma separated, or "none" when the ferret moves it',
          },
        ],
      }),
      verb('task new', {
        summary: 'make a task',
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
          { flag: '--summary <line>', help: 'one line for the task face' },
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
            help: "the task this one is part of; a sub-task is private, so never for the owner's asks",
          },
          {
            flag: '--approval <id>',
            help: `where the board is off: your answered "Track this on the board?" item (${askReference('A12')}) the owner said Yes to`,
          },
          {
            flag: '--thread <id>',
            help: `the open thread on your agenda (${askReference('A12')}) this task carries out; the owner is already asked there, so the task is your own errand`,
          },
          { flag: '--assignee <who>', help: 'the ferret doing it: a callsign or a session id' },
          { flag: '--project <name>', help: 'the board to create it on; default: the board of the calling session' },
          { flag: '--lane <lane>', help: "the lane to start in; default: the workflow's first" },
          {
            flag: '--file <path>',
            help: "a file or folder the work will touch (repeatable); overlapping an open task's claim queues this task's merge behind it (default: [])",
          },
          { flag: '--pr <url>', help: 'a pull request link (repeatable) (default: [])' },
          { flag: '--branch <branch>', help: 'the branch it is built on' },
          { flag: '--doc <path>', help: 'a document link (repeatable) (default: [])' },
          { flag: '--related <id>', help: 'a task this belongs to: add it there as a note and create nothing' },
          { flag: '--new', help: 'create even if a task on the same thing exists' },
          {
            flag: '--private',
            help: "a ferret's own bookkeeping: off the default board (default for a task an agent asked for)",
          },
          {
            flag: '--public',
            help: 'a task the owner sees on the default board (default for a task a person asked for)',
          },
          {
            flag: '--broad <why>',
            help: 'create a task that gathers several outcomes, saying why it must be one task',
          },
        ],
      }),
      verb('task show', {
        summary: 'one task; --yaml for the whole of it',
        args: [{ name: 'id', help: 'the task id: &F21 (or F21)' }],
        options: [
          { flag: '--session <id>', help: 'act as this session instead of the ambient FY_SESSION_ID' },
          { flag: '--json', help: 'print the daemon response as JSON' },
          { flag: '--yaml', help: 'print the editable document `task patch` takes back, with its revision' },
        ],
      }),
      verb('task move', {
        summary: 'move a task to a lane, with a reason',
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
      verb('task progress', {
        summary: 'write a task’s progress: now, done so far, next',
        args: [{ name: 'id', help: 'the task, like &F21' }],
        options: [
          {
            flag: '--file <path>',
            help: 'read the progress from a YAML or JSON file (- reads standard input)',
            hidden: true,
          },
          { flag: '--now <text>', help: 'what is happening right now' },
          { flag: '--done <text>', help: 'what is done so far; repeat for more' },
          { flag: '--next <text>', help: 'what comes next; repeat for more' },
          { flag: '--json', help: 'print the answer as JSON' },
        ],
      }),
      verb('task trigger', {
        summary: 'report an outside event that moves a task',
        args: [
          { name: 'id', help: 'the task id: &F21 (or F21)' },
          { name: 'event', help: 'the event: pr.review_approved | deploy.done' },
        ],
        options: [
          { flag: '--session <id>', help: 'act as this session instead of the ambient FY_SESSION_ID' },
          { flag: '--json', help: 'print the daemon response as JSON' },
          { flag: '--reason <why>', help: 'what happened, kept in the task history' },
        ],
      }),
      verb('task focus', {
        summary: 'make this ferret’s task the one it works on',
        args: [{ name: 'id', help: 'the task id: &F21 (or F21)' }],
        options: [
          { flag: '--session <id>', help: 'act as this session instead of the ambient FY_SESSION_ID' },
          { flag: '--json', help: 'print the daemon response as JSON' },
        ],
      }),
      verb('task skip', {
        summary: 'say this ferret needs no task, with a reason',
        args: [{ name: 'why', help: 'why: chit-chat, or the owner said not to track it', variadic: true }],
        options: [
          { flag: '--session <id>', help: 'act as this session instead of the ambient FY_SESSION_ID' },
          { flag: '--json', help: 'print the daemon response as JSON' },
        ],
      }),
      verb('task block', {
        summary: 'block a task on something outside',
        args: [
          { name: 'id', help: 'the task id: &F21 (or F21)' },
          { name: 'why', help: 'what it is waiting on', variadic: true },
        ],
        options: [
          { flag: '--session <id>', help: 'act as this session instead of the ambient FY_SESSION_ID' },
          { flag: '--json', help: 'print the daemon response as JSON' },
        ],
      }),
      verb('task unblock', {
        summary: 'clear a block',
        args: [{ name: 'id', help: 'the task id: &F21 (or F21)' }],
        options: [
          { flag: '--session <id>', help: 'act as this session instead of the ambient FY_SESSION_ID' },
          { flag: '--json', help: 'print the daemon response as JSON' },
          { flag: '--reason <why>', help: 'what changed' },
        ],
      }),
      verb('task depend', {
        summary: 'a task waits on another until it ships or is released',
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
      verb('task undepend', {
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
      verb('task drop', {
        summary: 'drop a task, with a reason',
        args: [{ name: 'id', help: 'the task id: &F21 (or F21)' }],
        options: [
          { flag: '--session <id>', help: 'act as this session instead of the ambient FY_SESSION_ID' },
          { flag: '--json', help: 'print the daemon response as JSON' },
          { flag: '--reason <why>', help: 'why it is dropped; the history keeps this' },
        ],
      }),
      verb('task reopen', {
        summary: 'send a task back to a lane with the owner’s words',
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
      verb('task clarify', {
        summary: 'add a clarification to a task',
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
      verb('task link', {
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
      verb('task assign', {
        summary: 'give a task to a ferret',
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
      verb('task claim', {
        summary: 'take a task for this ferret',
        args: [{ name: 'id', help: 'the task id: &F21 (or F21)' }],
        options: [
          { flag: '--session <id>', help: 'act as this session instead of the ambient FY_SESSION_ID' },
          { flag: '--json', help: 'print the daemon response as JSON' },
        ],
      }),
      verb('task adopt', {
        summary: 'take over a task whose ferret is gone',
        args: [{ name: 'id', help: 'the task id: &F21 (or F21)' }],
        options: [
          { flag: '--session <id>', help: 'act as this session instead of the ambient FY_SESSION_ID' },
          { flag: '--json', help: 'print the daemon response as JSON' },
          { flag: '--reason <why>', help: 'why you take it; kept in its history' },
        ],
      }),
      verb('task note', {
        summary: 'add a note to a task’s transcript',
        args: [
          { name: 'id', help: 'the task id: &F21 (or F21)' },
          { name: 'text', help: 'what to record', variadic: true },
        ],
        options: [
          { flag: '--session <id>', help: 'act as this session instead of the ambient FY_SESSION_ID' },
          { flag: '--json', help: 'print the daemon response as JSON' },
        ],
      }),
      verb('task order', {
        summary: 'place a task in its lane',
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
      verb('task reparent', {
        summary: 'move a task under another task',
        args: [{ name: 'id', help: 'the task id: &F21 (or F21)' }],
        options: [
          { flag: '--session <id>', help: 'act as this session instead of the ambient FY_SESSION_ID' },
          { flag: '--json', help: 'print the daemon response as JSON' },
          { flag: '--parent <id>', help: 'the task it goes under: &F21 (or F21)' },
          { flag: '--none', help: 'make it a top-level task instead' },
          { flag: '--reason <why>', help: 'why it moves; kept in its history' },
        ],
      }),
      verb('task file', {
        summary: 'claim a file for a task',
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
      verb('task merge-gate', {
        summary: 'what a PR waits on before it may merge',
        args: [{ name: 'pr-url', help: 'the pull request, https://github.com/<owner>/<repo>/pull/<n>' }],
      }),
      verb('task edit', {
        summary: 'edit a task’s text fields',
        args: [{ name: 'id', help: 'the task id: &F21 (or F21)' }],
        options: [
          { flag: '--session <id>', help: 'act as this session instead of the ambient FY_SESSION_ID' },
          { flag: '--json', help: 'print the daemon response as JSON' },
          {
            flag: '--title <title>',
            help: 'Keep the task title to 5 words or fewer; move scope and implementation detail into the description.',
          },
          { flag: '--summary <line>', help: 'one line for the task face' },
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
            help: "the task's status, Now: what is happening this moment (markdown); replaces that part, the others stay",
          },
          {
            flag: '--status-done <md>',
            help: "the task's status, Done so far: what is implemented, one bullet each with its PR link (markdown); replaces that part",
          },
          {
            flag: '--status-next <md>',
            help: "the task's status, Next: what comes after, in order (markdown); replaces that part",
          },
          {
            flag: '--status-file <path>',
            help: "the task's current state, rewritten whole, from YAML or JSON { now, doneSoFar, next } (`-` reads stdin): **Now** / **Done so far** (PR links) / **Next** (markdown)",
          },
          {
            flag: '--visibility <public|private>',
            help: "who sees it on the default board; only the owner hides the owner's ask",
          },
        ],
      }),
      verb('task patch', {
        summary: 'edit a task from a file',
        args: [{ name: 'id', help: 'the task id: &F21 (or F21)' }],
        options: [
          { flag: '--session <id>', help: 'act as this session instead of the ambient FY_SESSION_ID' },
          { flag: '--json', help: 'print the daemon response as JSON' },
          { flag: '-f, --file <path>', help: 'the YAML or JSON document; - (the default) reads standard input' },
        ],
      }),
      verb('task refile', {
        summary: 'move a task to another project’s board',
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
      appAction('task.move', { on: 'task', label: 'Move', calls: 'POST /v1/board/tasks/:taskId' }),
      appAction('task.start', { on: 'task', label: 'Start a ferret', calls: 'POST /v1/board/tasks/:taskId/start' }),
    ],
  },

  ui: {
    screens: [
      screen('board', { path: 'board/:project?', nav: { label: 'Board', icon: 'columns', order: 30 } }),
      screen('task', { path: 'task/:id' }),
      // Links to the old address sit in transcripts and agenda text: the screen stays, and sends the reader to `task/:id`.
      screen('card', { path: 'card/:id' }),
    ],
    panels: [
      panel('ferret.side', { id: 'cards-of-ferret', order: 20 }),
      panel('card.detail', { id: 'card-progress', order: 10 }),
    ],
    settings: [settingsTab('board', { group: 'agent-settings', label: 'Board', order: 40 })],
    renderers: [
      renderer('ask', { source: 'card' }),
      renderer('reference', { prefix: '&' }),
      // A `task` or `board` block in chat (Conversation's fence): the mini board and its lanes, from this board.
      renderer('reference', { prefix: '&board' }),
    ],
  },

  data: {
    state: [TASKS, COUNTERS, BOARDS, SWEEP, FOCUS, GITHUB],
    config: [BOARD_CONFIG],
    readModels: ['cards', 'progress', 'lanes'],
    publishes: [CardMoved, BoardChanged],
    subscribes: [AskAnswered],
  },

  hooks: {
    takes: [
      // The `task` ask source: a task's gate entry is an obligation `{ source: 'card', ref, entry }` Asks holds.
      { hook: AskSources, key: 'card', schema: CardAskRefSchema },
      { hook: StartDecide, priority: 60 },
      { hook: SitrepLines, priority: 50 },
      // The turn-end checks (D2 #12) and a started ferret's task (Ferrets' additive `ferret.started`).
      { hook: TurnEnded },
      { hook: FerretStarted },
      // Board's tasks are work Conversation's search finds (`search.sources`).
      { hook: SearchSources },
      // The `&` menu of a ferret's composer: its tasks (reference.catalog, lead ruling 2026-11-07). Asked only when Conversation is on.
      { hook: ReferenceCatalog, key: '&' },
      // The session archive's keep rule (Ferrets' `session.archive-keeps`): every task, so a ferret on one in flight stays live.
      { hook: ArchiveKeeps },
      // Asks' agenda reads a ferret's focus task, the to-test lane and a task's gate ask from here (`agenda.context`).
      { hook: AgendaContext, key: 'board' },
    ],
    offers: [{ hook: CardMoving, timeoutMs: 200 }],
  },

  instructions: [{ id: 'board', text: 'instructions/board.md', when: { role: 'lead' } }],
  doctor: ['board-store'],
  permissions: { roots: [], network: ['api.github.com'], spawn: ['gh', 'git', 'ssh'], secrets: [] },
});
