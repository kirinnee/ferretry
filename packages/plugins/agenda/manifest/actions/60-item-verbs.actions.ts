/**
 * The item verbs: `fy agenda add|edit|answer|…`, v4's word for word and Agenda's. Each speaks the per-ferret item routes
 * (`/v1/ferrets/:ferretId/agenda…`: raise, patch, reply, versions, conversation, seen), which are ASKS', not declared here:
 * answering is a security act (§2.2). They consume those routes through `needs`, as the ferret the verb runs inside.
 */
import { manifestFragment, verb } from '@ferretry/kernel/manifest';
import type { VerbArgDecl, VerbOptionDecl } from '@ferretry/kernel/manifest';

/** The agenda item an item verb acts on. */
const ITEM_ID: VerbArgDecl = { name: 'id', help: 'the agenda item, like A3' };

/** What every item verb takes: which board to act on (default: the ferret this runs inside), and --json. */
const SESSION: readonly VerbOptionDecl[] = [
  {
    flag: '-s, --session <id>',
    help: 'the ferret whose board to act on (--ferret says the same; defaults to the ferret this runs inside)',
  },
  { flag: '--json', help: 'print the board as JSON instead of the human rendering' },
];

const DONE_OPTIONS: readonly VerbOptionDecl[] = [
  { flag: '-n, --note <text>', help: 'a note recorded with the resolution' },
  {
    flag: '--reason <text>',
    help: 'why you close a question the owner has not answered (the owner sees it as withdrawn)',
  },
  { flag: '--approve | --reject', help: 'answer a permission ask' },
  { flag: '--choice <label>', help: 'answer a multiple-choice ask with one option label' },
  { flag: '--yes | --no', help: 'answer a yes-or-no item' },
  { flag: '--good | --clarify <text>', help: 'answer an answer-review ask' },
  { flag: '--answer <text>', help: 'answer an open question' },
  { flag: '--other <text>', help: 'answer with your own words instead of the options' },
];

const ADD_OPTIONS: readonly VerbOptionDecl[] = [
  { flag: '-t, --title <text>', help: 'REQUIRED: what this is about, plain words, aim for 40 characters, no IDs' },
  { flag: '--ask <line>', help: 'the ask, when it is not given as words' },
  { flag: '-k, --kind <kind>', help: 'what the human does: reply, choice, permission, review, todo, form …' },
  { flag: '--todo', help: 'a to-do: the human does something; nothing to choose' },
  { flag: '--premise <point>', help: 'REQUIRED: the situation, what is going on (repeat for more points)' },
  { flag: '-c, --context <point>', help: 'REQUIRED: the facts around the situation that bear on the ask (repeat)' },
  { flag: '--decided <point>', help: 'an earlier answer that bears on this (repeat)' },
  { flag: '--still-open <point>', help: 'what is still open to decide (repeat)' },
  { flag: '-o, --option <label>', help: 'a choice label, or "Label: why"; repeat for each option' },
  {
    flag: '--field <spec>',
    help: 'one field of a form (--kind form): "id|one/many/yesno/text|Question|option…"; repeat',
  },
  { flag: '-q, --question <text>', help: 'one thing the human must answer; repeat' },
  { flag: '-w, --why <reason>', help: 'why this needs the human now (defaults to the ask)' },
  { flag: '-r, --resolve <how>', help: 'the concrete action that clears it' },
  { flag: '--term <TERM=meaning>', help: 'spell out one piece of jargon; repeat' },
  { flag: '--recommend <decision>', help: 'your suggested decision; --recommend-why gives the reason' },
  { flag: '--impact <point>', help: 'what happens if nobody answers (repeat); --urgency says by when' },
  { flag: '-l, --link <label=target=meaning>', help: 'a PR, file or reference worth opening; repeat' },
  { flag: '--step <markdown>', help: 'one step the human follows, in order; repeat' },
  { flag: '--body-file <path>', help: '"The full picture", a Markdown file or - for stdin' },
  { flag: '--where-file <path>', help: 'the main tab, "Where we are now", a Markdown file or - for stdin' },
  { flag: '--tab-file <name=file>', help: 'a tab of your own, its words from a Markdown file; repeat' },
  { flag: '--blocking', help: 'you are stopped until the owner answers; --will-block names what it blocks' },
  { flag: '--by <time>', help: 'when it is needed: ISO, "in 3h" or a clock time like 17:00' },
  { flag: '--task <task>', help: 'the board task this item belongs to (F18 or &F18)' },
  { flag: '--offer-close', help: 'give the owner a "Done · closes <task>" button' },
  { flag: '--related <id>', help: 'a task (F12) links the item there; an agenda item (A3) is edited, not duplicated' },
  { flag: '--new <why>', help: 'open a new agenda although open ones are listed: say why none fits' },
  { flag: '--confirms <file>', help: 'a config file with a change held for the owner: their Allow applies it' },
  { flag: '--stage <stage>', help: 'what it needs from the owner now: explainer, question, plan, tracker or test' },
  { flag: '--json-file <path>', help: 'read these fields as JSON from a file, or - for stdin' },
];

const EDIT_OPTIONS: readonly VerbOptionDecl[] = [
  { flag: '-t, --title <text>', help: 'the new title' },
  { flag: '--summary <line>', help: 'the new one-line ask' },
  {
    flag: '--premise | -c, --context | --decided | --still-open <point>',
    help: 'replace that part; repeat for more points',
  },
  {
    flag: '-k, --kind <kind>',
    help: 'REPLACE the ask with a new one of this kind (--option and --question name its options and questions)',
  },
  {
    flag: '--body-file | --where-file <path>',
    help: 'rewrite "The full picture" or the main tab from a Markdown file, or - for stdin',
  },
  {
    flag: '--tab-file <name=file>',
    help: 'make or rewrite a tab of your own; --rename-tab, --move-tab and --remove-tab change the set',
  },
  { flag: '--question-answer <markdown>', help: 'the same as agenda answer: your answer to the owner' },
  { flag: '--blocking | --not-blocking', help: 'you are stopped, or no longer stopped' },
  { flag: '--by <time> | --clear-by', help: 'when it is needed, or drop it' },
  { flag: '--now', help: 'it is urgent: wake the item even though the owner snoozed it (at most once an hour)' },
];

export default manifestFragment({
  cli: [
    verb('agenda add [ask...]', {
      summary: 'open an agenda for what the owner must decide or do: only when no open one fits',
      args: [{ name: 'ask', help: 'the ask, in words (or give it with --ask)', optional: true, variadic: true }],
      options: [...SESSION, ...ADD_OPTIONS],
    }),
    verb('agenda edit <id>', {
      summary: 'rewrite an open item you raised: its writing, its stage, or (--kind) a new ask',
      args: [ITEM_ID],
      options: [...SESSION, ...EDIT_OPTIONS],
    }),
    verb('agenda answer <id> <text...>', {
      summary: 'answer the owner on an item you raised: shown above its ask',
      args: [ITEM_ID, { name: 'text', help: 'your answer to the owner, in words', variadic: true }],
      options: SESSION,
    }),
    verb('agenda rest <id>', {
      summary:
        'take an item on without asking anything yet: it rests as working, quiet, until you answer or mark it done',
      args: [ITEM_ID],
      options: [...SESSION, { flag: '-w, --why <line>', help: 'REQUIRED: what you are doing about it, in a line' }],
    }),
    verb('agenda log <id>', {
      summary:
        'keep what the owner said in chat on the item, word for word; you give your words, the daemon copies theirs',
      args: [ITEM_ID],
      options: [
        ...SESSION,
        { flag: '--reply <text>', help: 'your answer to what they said; the item goes back to their list' },
        { flag: '--rest <text>', help: 'what you are doing about it; the item rests as working' },
        { flag: '--message <id>', help: 'log this chat message of theirs instead of the latest' },
      ],
    }),
    verb('agenda merge <into> <from>', {
      summary:
        'merge a duplicate into an item: both conversations, every task and link are kept; the duplicate closes as merged',
      args: [
        { name: 'into', help: 'the agenda item to keep, like A3' },
        { name: 'from', help: 'the duplicate, which closes as merged' },
      ],
      options: SESSION,
    }),
    verb('agenda split <id> <ask...>', {
      summary: 'split a new item off one that grew two asks, linked both ways',
      args: [ITEM_ID, { name: 'ask', help: 'the ask of the new item, in words', variadic: true }],
      options: [
        ...SESSION,
        { flag: '-t, --title <text>', help: 'REQUIRED: what the new item is about' },
        { flag: '--move-tasks <tasks>', help: 'tasks of the item that go to the new one, like F12,F13' },
        { flag: '--premise <point>', help: 'the situation (repeat)' },
        { flag: '-c, --context <point>', help: 'the facts around it (repeat)' },
        { flag: '-k, --kind <kind>', help: 'what the owner does' },
        { flag: '--body-file <path>', help: 'a Markdown file for the new item, or - for stdin' },
        { flag: '--json-file <path>', help: 'read these fields as JSON from a file, or - for stdin' },
      ],
    }),
    verb('agenda step <id> <n>', {
      summary: 'tick a step of an open item, counted from 1 as ls prints them',
      args: [ITEM_ID, { name: 'n', help: 'the step, counted from 1 as ls prints them' }],
      options: [...SESSION, { flag: '--undo', help: 'untick the step instead' }],
    }),
    verb('agenda show <id>', {
      summary: 'print one item in full: read-only',
      args: [ITEM_ID],
      options: [
        ...SESSION,
        { flag: '--tab <name>', help: 'print only this tab, exactly as written: main, body, or a tab of your own' },
        { flag: '--yaml', help: 'print the editable document agenda patch takes back' },
      ],
    }),
    verb('agenda patch <id>', {
      summary:
        'change an open item you raised as ONE YAML or JSON document, in one atomic edit (read it with agenda show <id> --yaml)',
      args: [ITEM_ID],
      options: [
        ...SESSION,
        { flag: '-f, --file <path>', help: 'the YAML or JSON document; - (the default) reads standard input' },
        { flag: '--now', help: 'it is urgent: an item the owner snoozed wakes too (at most once an hour)' },
      ],
    }),
    verb('agenda ls', { summary: 'list open items, oldest first', args: [], options: SESSION }),
    verb('agenda history', { summary: 'show the resolution audit, newest first', args: [], options: SESSION }),
    verb('agenda needs-info <id>', {
      summary: 'ask the ferret that raised an item for more information; the item stays open',
      args: [ITEM_ID],
      options: [...SESSION, { flag: '-n, --note <text>', help: 'what is missing, told to the ferret' }],
    }),
    verb('agenda discuss <id>', {
      summary: 'ask the ferret that raised an item to talk it through before you answer; the item stays open',
      args: [ITEM_ID],
      options: [...SESSION, { flag: '-n, --note <text>', help: 'what is unclear or wrong, told to the ferret' }],
    }),
    verb('agenda surface <id>', {
      summary:
        'hand an item back to the owner, or bring back one their reply parked: it is their turn again (never pings)',
      args: [ITEM_ID],
      options: [
        ...SESSION,
        { flag: '-w, --why <line>', help: 'one line on why the owner must look now' },
        {
          flag: '--now',
          help: 'it is urgent: wake the item even though the owner snoozed it (at most once an hour)',
        },
      ],
    }),
    verb('agenda snooze <id>', {
      summary: 'put an item away until later (owner): it leaves the list and comes back as new',
      args: [ITEM_ID],
      options: [
        ...SESSION,
        { flag: '--for <time>', help: 'how long: like 4h, 90m or 1d' },
        { flag: '--until <time>', help: 'until when: ISO, "in 3h" or a clock time like 17:00' },
      ],
    }),
    verb('agenda unsnooze <id>', {
      summary: 'bring a snoozed or replied-to item back to the list now (owner)',
      args: [ITEM_ID],
      options: SESSION,
    }),
    verb('agenda send-now', {
      args: [],
      summary: 'deliver the answers held for the ferret now, instead of after the quiet window',
      options: SESSION,
    }),
    verb('agenda done <id>', {
      summary: 'resolve an item, optionally answering its ask',
      args: [ITEM_ID],
      options: [...SESSION, ...DONE_OPTIONS],
    }),
    verb('agenda dismiss <id>', {
      summary: 'dismiss an item without answering it: recorded with who dismissed it',
      args: [ITEM_ID],
      options: [...SESSION, { flag: '-n, --note <text>', help: 'a note recorded with the dismissal' }],
    }),
  ],
});
