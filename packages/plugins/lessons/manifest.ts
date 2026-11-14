import { audit, cap } from '@ferretry/core-gate/contract';
import { FerretsPort, LaunchParts } from '@ferretry/core-ferrets/contract';
import { ConversationPort, TurnEnded } from '@ferretry/plugin-conversation/contract';
import { definePlugin, panel, route, screen, settingsTab, tool, verb } from '@ferretry/kernel/manifest';
import { LESSONS_CONFIG, LESSONS_STATE, LessonsChanged, LessonsPort } from './contract/index.ts';

const fleetUse = cap('fleet', 'use');
const fleetConfigure = cap('fleet', 'configure');
const configured = audit('fleet.configured');

/** Evidence is a verbatim quote of what the owner typed into a ferret; the board is owner-only text, no pane or vault text. */
const QUOTES = { none: 'the owner’s own words and the rules drawn from them; no pane, page or vault text' } as const;
const READ = { skip: 'a read of the lessons board' } as const;
const NOT_RECORDED = { skip: 'not recorded today (no rule in the audit table)' } as const;
/** The Global lessons document: rules the owner applied or wrote; no pane, page or vault text. */
const GLOBAL_TEXT = {
  none: 'the owner’s Global rules, applied or written by the owner; no pane, page or vault text',
} as const;

/**
 * Lessons (§2.3): rules learned when you correct a ferret, given to every ferret after. Today's `learning`
 * (docs/lessons.md): the board of suggestions, the owner's verdicts, Apply (a diff preview and an etag write), the
 * passive switch and the explicit scan. Routes are today's mounts (`mounts/learning.ts`), descriptor fields copied; the
 * paths follow the route-path rule (`learning` → `lessons`, `sessions` → `ferrets`, `agent` → `lessons/suggest`).
 *
 * Ownership calls:
 *  - The Global lessons document is this plugin's own state (`global.json`), read by every launch through
 *    `launch.parts`; today's `instructions/lessons` component file and the profile that includes it are Setup's, now
 *    Skills'/Runtimes', and are not reachable from here. Because the owner can no longer open it in an editor, they read
 *    and rewrite it through `GET` / `PUT /v1/lessons/global` (Settings › Lessons, `fy lesson global`).
 *  - A project's AGENTS.md / CLAUDE.md is written through the `work` root of a ferret whose folder holds the project's
 *    git root (today's walk up to `.git`), after the route asked `filesystem.configure` (and a step-up for a remote
 *    device), exactly as today.
 */
export default definePlugin({
  id: 'lessons',
  title: 'Lessons',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['instruction', 'command', 'view'],
  words: [{ word: 'lesson', means: 'a rule learned from a correction', insteadOf: ['learning'] }],

  needs: { conversation: ConversationPort, ferrets: FerretsPort },
  provides: { lessons: LessonsPort },

  actions: {
    routes: [
      route('GET /v1/lessons/status', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        audit: READ,
        guard: QUOTES,
      }),
      route('GET /v1/lessons/config', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        audit: READ,
        guard: { none: 'a schedule and a switch' },
      }),
      route('PATCH /v1/lessons/config', {
        minimum: 'operator',
        caller: 'person',
        capability: fleetConfigure,
        noStore: true,
        audit: configured,
        guard: { none: 'a schedule and a switch' },
      }),
      route('GET /v1/lessons/proposals', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        audit: READ,
        guard: QUOTES,
      }),
      route('POST /v1/lessons/proposals/:id', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        audit: NOT_RECORDED,
        guard: QUOTES,
      }),
      route('GET /v1/lessons/proposals/:id/patch', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        audit: READ,
        guard: QUOTES,
      }),
      route('GET /v1/lessons/proposals/:id/apply-preview', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        audit: { skip: 'a preview writes nothing' },
        guard: { none: 'a diff of the lesson against the target file the owner is about to write' },
      }),
      // Reached as `fleet.use`; the handler then asks for the TARGET's own grant on `configure`.
      route('POST /v1/lessons/proposals/:id/apply', {
        minimum: 'operator',
        caller: 'person',
        capability: fleetUse,
        noStore: true,
        audit: configured,
        guard: QUOTES,
      }),
      // The Global lessons document (today a file the owner edits in any editor): read it, and rewrite it whole against
      // the etag just read — how the owner changes or removes an applied Global lesson.
      route('GET /v1/lessons/global', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        audit: READ,
        guard: GLOBAL_TEXT,
      }),
      route('PUT /v1/lessons/global', {
        minimum: 'operator',
        caller: 'person',
        capability: fleetConfigure,
        noStore: true,
        audit: configured,
        guard: GLOBAL_TEXT,
      }),
      route('POST /v1/lessons/run', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        audit: NOT_RECORDED,
        guard: { none: 'counts and a sentence' },
      }),
      route('GET /v1/lessons/ferrets', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        audit: READ,
        guard: { none: 'which ferrets are instructed to file lessons' },
      }),
      route('GET /v1/lessons/directory', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        audit: READ,
        guard: { none: 'the ferrets a view names: id, name and folder' },
      }),
      route('PATCH /v1/ferrets/:ferretId/lessons', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        audit: NOT_RECORDED,
        guard: { none: 'a switch and a sentence' },
      }),
      route('POST /v1/lessons/scan/estimate', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        audit: { skip: 'an estimate spends nothing' },
        guard: { none: 'counts and a price' },
      }),
      route('GET /v1/lessons/scan', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        audit: READ,
        guard: { none: 'counts and a sentence' },
      }),
      route('POST /v1/lessons/scan/cancel', {
        minimum: 'operator',
        caller: 'any',
        noStore: true,
        audit: NOT_RECORDED,
        guard: { none: 'counts and a sentence' },
      }),
      // A PERSON'S ACT: a scan starts one miner ferret per batch, none with a parent.
      route('POST /v1/lessons/scan', {
        minimum: 'operator',
        caller: 'person',
        noStore: true,
        audit: NOT_RECORDED,
        guard: { none: 'counts and a sentence' },
      }),
      // A ferret files a lesson with its own credential; the evidence is read by the daemon, never carried by the call.
      route('POST /v1/lessons/suggest', {
        minimum: 'authenticated',
        caller: 'any',
        privilegedOnly: true,
        noStore: true,
        audit: NOT_RECORDED,
        guard: { none: 'the filing sentence; no pane, page or vault text' },
      }),
    ],
    agentTools: [
      tool('lessons_suggest', {
        minimum: 'authenticated',
        caller: 'any',
        audit: NOT_RECORDED,
        guard: { none: 'the filing sentence; no pane, page or vault text' },
        summary: 'File one lesson (an imperative rule, global or project) for the owner to review.',
      }),
    ],
    cli: [
      verb('lesson', {
        summary: 'the lessons board: what was learned from your corrections (pending ones first)',
        args: [],
      }),
      verb('lesson ls', {
        summary: 'the lessons board, pending ones first (the same as bare lesson)',
        args: [],
        options: [
          { flag: '--state <state>', help: 'narrow to pending, accepted or rejected' },
          { flag: '--all', help: 'every state, not just the pending ones' },
          { flag: '--json', help: 'print the protocol payload instead of the human rendering' },
        ],
      }),
      verb('lesson show', {
        summary: 'one lesson in full, with every quote behind it',
        args: [{ name: 'id', help: 'the proposal id' }],
        options: [{ flag: '--json', help: 'print the protocol payload instead of the human rendering' }],
      }),
      verb('lesson accept', {
        summary: 'accept a lesson; it writes nothing until you apply it',
        args: [{ name: 'id', help: 'the proposal id' }],
        options: [{ flag: '--json', help: 'print the protocol payload instead of the human rendering' }],
      }),
      verb('lesson reject', {
        summary: 'reject a lesson; it is not suggested again',
        args: [{ name: 'id', help: 'the proposal id' }],
        options: [
          { flag: '-n, --note <text>', help: 'why it was rejected, recorded in the audit' },
          { flag: '--json', help: 'print the protocol payload instead of the human rendering' },
        ],
      }),
      verb('lesson edit', {
        summary: 'reword a lesson before accepting it',
        args: [
          { name: 'id', help: 'the proposal id' },
          { name: 'rule', help: 'the replacement rule text', variadic: true },
        ],
        options: [{ flag: '--json', help: 'print the protocol payload instead of the human rendering' }],
      }),
      verb('lesson categorize', {
        summary: 'change where a lesson goes: global or project',
        args: [
          { name: 'id', help: 'the proposal id' },
          { name: 'category', help: 'global (every ferret) or repo (this project)' },
        ],
        options: [{ flag: '--json', help: 'print the protocol payload instead of the human rendering' }],
      }),
      verb('lesson reopen', {
        summary: 'put a lesson back in To review',
        args: [{ name: 'id', help: 'the proposal id' }],
        options: [{ flag: '--json', help: 'print the protocol payload instead of the human rendering' }],
      }),
      verb('lesson apply', {
        summary: 'show the diff of an accepted lesson, and with --yes write it',
        args: [{ name: 'id', help: 'the proposal id' }],
        options: [
          { flag: '--yes', help: 'write it; without this, only the diff is shown and nothing is written' },
          { flag: '--json', help: 'print the protocol payload instead of the human rendering' },
        ],
      }),
      verb('lesson scan', {
        summary: 'an estimated read of older ferrets for lessons; never starts by itself',
        args: [],
        options: [
          { flag: '--estimate', help: 'what a scan would cost, without reading anything (the default)' },
          { flag: '--start', help: 'actually run the scan' },
          {
            flag: '--sessions <ids>',
            help: 'comma-separated session ids; without it, every ferret not instructed to learn',
          },
          { flag: '--agent <agent>', help: 'the login (fleet agent) the miner runs on' },
          { flag: '--model <model>', help: 'the model the miner uses' },
          { flag: '--json', help: 'print the protocol payload instead of the human rendering' },
        ],
      }),
      verb('lesson patch', {
        summary: 'print the file an accepted lesson edits, for you to apply',
        args: [{ name: 'id', help: 'the proposal id' }],
        options: [{ flag: '--json', help: 'print the protocol payload instead of the human rendering' }],
      }),
      verb('lesson run', {
        summary: 'mine now instead of waiting for the schedule',
        args: [],
        options: [
          { flag: '--spawn', help: 'also launch the miner sessions this run needs' },
          { flag: '--json', help: 'print the protocol payload instead of the human rendering' },
        ],
      }),
      verb('lesson status', {
        summary: 'whether mining is on, what is pending, how the last run went',
        args: [],
        options: [{ flag: '--json', help: 'print the protocol payload instead of the human rendering' }],
      }),
      verb('lesson config', {
        summary: 'the mining schedule and the agent that performs it',
        args: [],
        options: [{ flag: '--json', help: 'print the protocol payload instead of the human rendering' }],
      }),
      verb('lesson suggest', {
        summary: 'file one lesson for the owner to review',
        args: [{ name: 'rule', help: 'one short imperative rule, at most 500 characters' }],
        options: [
          {
            flag: '--scope <scope>',
            help: 'global (every ferret should follow it) or repo (a fact about this project)',
          },
          { flag: '--json', help: "print the protocol payload instead of the daemon's sentence" },
        ],
      }),
      verb('lesson global', {
        summary: 'the Global lessons every ferret reads, numbered',
        args: [],
        options: [{ flag: '--json', help: 'print the answer as JSON' }],
      }),
      verb('lesson global edit', {
        summary: 'reword one Global lesson by its number',
        args: [
          { name: 'number', help: 'the lesson’s number in the Global list' },
          { name: 'rule', help: 'the new wording', variadic: true },
        ],
        options: [{ flag: '--json', help: 'print the answer as JSON' }],
      }),
      verb('lesson global remove', {
        summary: 'remove one Global lesson by its number',
        args: [{ name: 'number', help: 'the lesson’s number in the Global list' }],
        options: [{ flag: '--json', help: 'print the answer as JSON' }],
      }),
    ],
  },

  ui: {
    screens: [screen('lessons', { path: 'lessons', nav: { label: 'Lessons', icon: 'graduation-cap', order: 70 } })],
    panels: [panel('ferret.toolbar', { id: 'ferret-lessons', order: 70 })],
    settings: [settingsTab('lessons', { label: 'Lessons', order: 70 })],
  },

  data: {
    state: LESSONS_STATE,
    config: [LESSONS_CONFIG],
    readModels: ['board', 'status', 'scan'],
    publishes: [LessonsChanged],
  },

  hooks: {
    takes: [{ hook: LaunchParts }, { hook: TurnEnded }],
  },

  doctor: ['lessons-board'],

  // A scan reads transcripts only through Conversation. Applying a Repo lesson writes the project's instruction file
  // through the filing ferret's `work` root.
  permissions: { roots: ['work'] },
});
