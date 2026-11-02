import {
  DependencyUntilSchema,
  ExternalLaneTriggerSchema,
  TaskKindSchema,
  TaskWorkflowSchema,
} from '@ferretry/protocol';
import type { Command } from 'commander';
import type {
  BoardController,
  TaskCreateFlags,
  TaskEditFlags,
  TaskLinkFlags,
  TaskListShimFlags,
} from '../../lib/board/board-controllers';
import { laneGuide } from '../../lib/board/lane-guide';
import { TASK_TITLE_GUIDANCE } from '../../lib/tasks/task-title';

/** Everything the task command group is wired from; the composition root owns the concrete instances. */
export interface TaskCommandDependencies {
  readonly board: BoardController;
}

interface SessionOptions {
  readonly session?: string;
  readonly json?: boolean;
}

const collect = (value: string, previous: readonly string[]): readonly string[] => [...previous, value];

const choices = (values: readonly string[]): string => values.join(' | ');

/** `--session` and `--json` belong to every task command. */
const acting = (command: Command): Command =>
  command
    .option('--session <id>', 'act as this session instead of the ambient FY_SESSION_ID')
    .option('--json', 'print the daemon response as JSON');

const ID_HELP = 'the task id: &F21 (or F21)';

const HOW_TO_TEST_HELP =
  'how the owner checks it before Done (markdown, a numbered list): where to go, what to do, what they should see';

export function registerTaskCommands(program: Command, dependencies: TaskCommandDependencies): Command {
  const { board } = dependencies;

  const group = program.command('task').description("create and move the cards of a project's board");

  acting(group.command('create'))
    .description('record a task on the project board, preserving the human ask verbatim')
    .argument('[title...]', 'the title, if you would rather not repeat --title')
    .requiredOption('-k, --kind <kind>', `one of ${choices(TaskKindSchema.options)}`)
    .option('-t, --title <title>', TASK_TITLE_GUIDANCE)
    .option('--summary <line>', 'one line for the card face')
    .option('--ask <text>', "the human's words, verbatim")
    .option('--ask-source <link>', 'where those words came from')
    .option(
      '--premise <point>',
      'why this work exists; a plain line, no leading "- " (repeat for more points)',
      collect,
      [],
    )
    .option(
      '--context <point>',
      'what a newcomer needs to know; a plain line, no leading "- " (repeat for more points)',
      collect,
      [],
    )
    .option('--term <term=meaning>', 'a glossary entry (repeatable)', collect, [])
    .option('--brief <text>', 'the full description or plan')
    .option('--brief-file <path>', 'read the brief from a file instead')
    .option('--how-to-test <md>', HOW_TO_TEST_HELP)
    .option('--how-to-test-file <path>', 'read How to test from a file instead')
    .option('--workflow <workflow>', `one of ${choices(TaskWorkflowSchema.options)}`)
    .option('--depends-on <id>', 'a task this one waits on (repeatable)', collect, [])
    .option('--parent <id>', 'the task this one is part of')
    .option(
      '--approval <id>',
      'where the board is off: your answered "Track this on the board?" item (!A12) the owner said Yes to',
    )
    .option('--assignee <who>', 'the ferret doing it: a callsign or a session id')
    .option('--project <name>', 'the board to create it on; default: the board of the calling session')
    .option('--lane <lane>', "the lane to start in; default: the workflow's first")
    .option('--file <path>', 'an advisory file claim (repeatable)', collect, [])
    .option('--pr <url>', 'a pull request link (repeatable)', collect, [])
    .option('--branch <branch>', 'the branch it is built on')
    .option('--doc <path>', 'a document link (repeatable)', collect, [])
    .option('--related <id>', 'a card this belongs to: add it there as a note and create nothing')
    .option('--new', 'create even if a card on the same thing exists')
    .action(async (titleWords: string[], options: TaskCreateFlags) => {
      await board.create(titleWords, options);
    });

  acting(group.command('show'))
    .description(
      'one task in full: ask, premise, context, terms, brief, How to test, children, dependencies, links, asks, history',
    )
    .argument('<id>', ID_HELP)
    .action(async (id: string, options: SessionOptions) => {
      await board.show(id, options);
    });

  acting(group.command('list'))
    .description('retired: this is `fy board --mine` (`--all` for everybody)')
    .option('--all', 'read every session on this host')
    .option('--kind <kind>', `only ${choices(TaskKindSchema.options)}`)
    .option('--query <text>', 'only tasks whose text contains this')
    .option('--md', 'render as markdown')
    .action(async (options: TaskListShimFlags) => {
      await board.listShim(options);
    });

  acting(group.command('move'))
    .description("move a card to another lane of its project's board")
    .argument('<id>', ID_HELP)
    .argument('<lane>', "the lane's id or name (see `fy board lanes show`)")
    .option('--reason <why>', 'why it moved; required for a move back')
    .addHelpText('after', `\n${laneGuide(program.name())}`)
    .action(async (id: string, lane: string, options: SessionOptions & { reason?: string }) => {
      await board.move(id, lane, options);
    });

  acting(group.command('trigger'))
    .description('report an external event for a card (e.g. deploy.done); the daemon moves it if a lane waits on it')
    .argument('<id>', ID_HELP)
    .argument('<event>', `the event: ${choices(ExternalLaneTriggerSchema.options)}`)
    .addHelpText(
      'after',
      '\nOnly events Ferretry cannot see itself: a PR is merged or a release published when GitHub says so, never on your word.\nA sub-ferret may report one: it is how a deploy it ran reaches the card.',
    )
    .option('--reason <why>', 'what happened, kept in the card history')
    .action(async (id: string, event: string, options: SessionOptions & { reason?: string }) => {
      await board.trigger(id, event, options);
    });

  acting(group.command('focus'))
    .description("make this the card the calling session's work is attributed to")
    .argument('<id>', ID_HELP)
    .action(async (id: string, options: SessionOptions) => {
      await board.focus(id, options);
    });

  acting(group.command('skip'))
    .description('record why this work needs no card, so the turn-end board check stays quiet')
    .argument('<why...>', 'why: chit-chat, or the owner said not to track it')
    .action(async (why: string[], options: SessionOptions) => {
      await board.skip(why, options);
    });

  acting(group.command('block'))
    .description('mark a card blocked on something outside the board, saying what')
    .argument('<id>', ID_HELP)
    .argument('<why...>', 'what it is waiting on')
    .action(async (id: string, why: string[], options: SessionOptions) => {
      await board.block(id, why, options);
    });

  acting(group.command('unblock'))
    .description('clear an external block')
    .argument('<id>', ID_HELP)
    .option('--reason <why>', 'what changed')
    .action(async (id: string, options: SessionOptions & { reason?: string }) => {
      await board.unblock(id, options);
    });

  acting(group.command('depend'))
    .description('make a card wait on another')
    .argument('<id>', ID_HELP)
    .argument('<dependency>', 'the task it waits on')
    .option('--until <when>', `${choices(DependencyUntilSchema.options)} (default shipped)`)
    .option('--override <why>', 'owner only: let it advance although the dependency is not done')
    .action(async (id: string, dependency: string, options: SessionOptions & { until?: string; override?: string }) => {
      await board.depend(id, dependency, options);
    });

  acting(group.command('undepend'))
    .description('drop a dependency')
    .argument('<id>', ID_HELP)
    .argument('<dependency>', 'the task it no longer waits on')
    .option('--reason <why>', 'why the dependency goes away')
    .action(async (id: string, dependency: string, options: SessionOptions & { reason?: string }) => {
      await board.undepend(id, dependency, options);
    });

  acting(group.command('drop'))
    .description('abandon or supersede a card, saying why')
    .argument('<id>', ID_HELP)
    .requiredOption('--reason <why>', 'why it is dropped; the history keeps this')
    .action(async (id: string, options: SessionOptions & { reason?: string }) => {
      await board.drop(id, options);
    });

  acting(group.command('reopen'))
    .description("reopen a finished card in a lane, together with the owner's new ask")
    .argument('<id>', ID_HELP)
    .requiredOption('--to <lane>', 'the lane to reopen it into')
    .requiredOption('--ask <words>', "the owner's new words, verbatim")
    .option('--source <link>', 'where those words came from')
    .option('--reason <why>', 'why it is being reopened')
    .action(
      async (id: string, options: SessionOptions & { to?: string; ask?: string; source?: string; reason?: string }) => {
        await board.reopen(id, options);
      },
    );

  acting(group.command('clarify'))
    .description('append a verbatim clarification to the original ask')
    .argument('<id>', ID_HELP)
    .argument('<text...>', 'the clarification, verbatim')
    .requiredOption('--source <link>', 'where it came from')
    .action(async (id: string, text: string[], options: SessionOptions & { source?: string }) => {
      await board.clarify(id, text, options);
    });

  acting(group.command('link'))
    .description('attach exactly one link to a task')
    .argument('<id>', ID_HELP)
    .option('--pr <url>', 'a pull request')
    .option('--branch <branch>', 'the branch')
    .option('--commit <sha>', 'a commit')
    .option('--doc <path>', 'a document')
    .action(async (id: string, options: TaskLinkFlags) => {
      await board.link(id, options);
    });

  acting(group.command('assign'))
    .description('hand a task to a ferret, or take it back')
    .argument('<id>', ID_HELP)
    .argument('[who]', 'the ferret: a callsign or a session id')
    .option('--none', 'unassign instead')
    .action(async (id: string, who: string | undefined, options: SessionOptions & { none?: boolean }) => {
      await board.assign(id, who, options);
    });

  acting(group.command('note'))
    .description('append a note to the history')
    .argument('<id>', ID_HELP)
    .argument('<text...>', 'what to record')
    .action(async (id: string, text: string[], options: SessionOptions) => {
      await board.note(id, text, options);
    });

  acting(group.command('order'))
    .description('rank a card within its lane, or clear its rank')
    .argument('<id>', ID_HELP)
    .argument('[rank]', 'a whole number')
    .option('--none', 'clear the rank instead')
    .action(async (id: string, rank: string | undefined, options: SessionOptions & { none?: boolean }) => {
      await board.order(id, rank, options);
    });

  acting(group.command('reparent'))
    .description('move a card under another card, or to the top level of its board')
    .argument('<id>', ID_HELP)
    .option('--parent <id>', 'the card it goes under: &F21 (or F21)')
    .option('--none', 'make it a top-level card instead')
    .option('--reason <why>', 'why it moves; kept in its history')
    .action(async (id: string, options: SessionOptions & { parent?: string; none?: boolean; reason?: string }) => {
      await board.reparent(id, options);
    });

  acting(group.command('file'))
    .description('claim or release a file; claims are advisory, never a lock')
    .argument('<id>', ID_HELP)
    .argument('<path>', 'the file being claimed')
    .option('--remove', 'release the claim instead of taking it')
    .option('--reason <why>', 'optional context')
    .action(async (id: string, path: string, options: SessionOptions & { remove?: boolean; reason?: string }) => {
      await board.file(id, path, options);
    });

  acting(group.command('edit'))
    .description("change a card's title, summary, premise, context, glossary, brief or How to test")
    .argument('<id>', ID_HELP)
    .option('--title <title>', TASK_TITLE_GUIDANCE)
    .option('--summary <line>', 'one line for the card face')
    .option(
      '--premise <point>',
      'replace why this work exists; a plain line, no leading "- " (repeat for more points)',
      collect,
      [],
    )
    .option(
      '--context <point>',
      'replace what a newcomer needs to know; a plain line, no leading "- " (repeat for more points)',
      collect,
      [],
    )
    .option('--term <term=meaning>', 'replace the glossary with these entries (repeatable)', collect, [])
    .option('--brief <text>', 'the full description or plan')
    .option('--brief-file <path>', 'read the brief from a file instead')
    .option('--how-to-test <md>', HOW_TO_TEST_HELP)
    .option('--how-to-test-file <path>', 'read How to test from a file instead')
    .action(async (id: string, options: TaskEditFlags) => {
      await board.edit(id, options);
    });

  acting(group.command('refile'))
    .description("move a card to another project's board")
    .argument('<id>', ID_HELP)
    .requiredOption('--project <name>', 'the board it moves to')
    .option('--lane <lane>', 'the lane there; default: the same-category lane')
    .option('--reason <why>', 'why it moves')
    .action(async (id: string, options: SessionOptions & { project?: string; lane?: string; reason?: string }) => {
      await board.refile(id, options);
    });

  // The v1 spellings. They print what replaced them and exit non-zero, so a script that still calls one fails loudly.
  group
    .command('status')
    .description('retired: use `fy task move`')
    .argument('<id>', 'the task id')
    .argument('<status>', 'the old status')
    .option('--reason <why>', 'why it moved')
    .option('--note <text>', 'ignored')
    .option('--session <id>', 'ignored')
    .option('--json', 'ignored')
    .action((id: string, status: string, options: { reason?: string }) => {
      board.retiredStatus(id, status, options.reason);
    });

  group
    .command('phase')
    .description('retired: use `fy task move`')
    .argument('<id>', 'the task id')
    .argument('<phase>', 'the old phase')
    .option('--reason <why>', 'why it moved')
    .option('--session <id>', 'ignored')
    .option('--json', 'ignored')
    .action((id: string, phase: string, options: { reason?: string }) => {
      board.retiredPhase(id, phase, options.reason);
    });

  acting(group.command('feedback'))
    .description('retired: recorded as a note')
    .argument('<id>', ID_HELP)
    .argument('<text...>', 'what to record')
    .action(async (id: string, text: string[], options: SessionOptions) => {
      await board.feedback(id, text, options);
    });

  return group;
}
