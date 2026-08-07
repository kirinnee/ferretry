import { TaskKindSchema, TaskPhaseSchema, TaskStatusSchema, TaskWorkflowSchema } from '@ferretry/protocol';
import type { Command } from 'commander';
import type { ITaskOutput, ITaskGateway, ITextFileReader } from '../../lib/tasks/ports';
import {
  TaskActionController,
  TaskCreateController,
  TaskListController,
  TaskShowController,
} from '../../lib/tasks/task-controllers';
import {
  buildAssignAction,
  buildClarifyAction,
  buildDependencyAction,
  buildFileAction,
  buildLinkAction,
  buildOrderAction,
  buildPhaseAction,
  buildReopenAction,
  buildStatusAction,
  buildTextAction,
  TASK_LIST_VIEWS,
  type TaskCreateOptions,
  type TaskLinkOptions,
  type TaskListOptions,
} from '../../lib/tasks/task-request';
import { resolveTaskScope, type TaskScope } from '../../lib/tasks/task-scope';
import { TASK_TITLE_GUIDANCE } from '../../lib/tasks/task-title';

/** Everything the task command group is wired from; the composition root owns the concrete instances. */
export interface TaskCommandDependencies {
  readonly gateway: ITaskGateway;
  readonly io: ITaskOutput;
  readonly files: ITextFileReader;
  /** `FY_SESSION_ID`, as the daemon exported it into the agent's environment. */
  readonly environmentSessionId: string | undefined;
}

interface ScopeOptions {
  readonly session?: string;
  readonly all?: boolean;
  readonly json?: boolean;
  readonly md?: boolean;
}

const collect = (value: string, previous: readonly string[]): readonly string[] => [...previous, value];

const choices = (values: readonly string[]): string => values.join(' | ');

/** `--session` and `--json` belong to every task command; `--md` only to the two that render prose. */
const scoped = (command: Command): Command =>
  command
    .option('--session <id>', 'target this session instead of the ambient FY_SESSION_ID')
    .option('--json', 'print the daemon response as JSON');

export function registerTaskCommands(program: Command, dependencies: TaskCommandDependencies): Command {
  const { gateway, io, files, environmentSessionId } = dependencies;
  const create = new TaskCreateController(gateway, io, files);
  const list = new TaskListController(gateway, io);
  const show = new TaskShowController(gateway, io);
  const act = new TaskActionController(gateway, io);

  const scope = (options: ScopeOptions): TaskScope =>
    resolveTaskScope({ session: options.session, all: options.all, environmentSessionId });

  const group = program.command('task').description('create and move the tasks of a session');

  scoped(group.command('create'))
    .description('record a task, preserving the human ask verbatim')
    .argument('[title...]', 'the title, if you would rather not repeat --title')
    .requiredOption('-k, --kind <kind>', `one of ${choices(TaskKindSchema.options)}`)
    .option('-t, --title <title>', TASK_TITLE_GUIDANCE)
    .option('--ask <text>', "the human's words, verbatim")
    .option('--ask-source <link>', 'where those words came from')
    .option('--workflow <workflow>', `one of ${choices(TaskWorkflowSchema.options)}`)
    .option('--depends-on <id>', 'a task this one waits on (repeatable)', collect, [])
    .option('--file <path>', 'an advisory file claim (repeatable)', collect, [])
    .option('--description <text>', 'the brief')
    .option('--description-file <path>', 'read the brief from a file instead')
    .option('--status <status>', `one of ${choices(TaskStatusSchema.options)}`)
    .option('--reason <why>', 'required when creating blocked or dropped')
    .option('--repo <path>', 'the repository this task lives in')
    .option('--assignee <who>', 'the teammate who owns it')
    .option('--order <n>', 'manual rank')
    .option('--pr <url>', 'a pull request link (repeatable)', collect, [])
    .option('--branch <branch>', 'the branch it is built on')
    .option('--commit <sha>', 'a commit link (repeatable)', collect, [])
    .option('--doc <path>', 'a document link (repeatable)', collect, [])
    .action(async (titleWords: string[], options: TaskCreateOptions & ScopeOptions) => {
      await create.run({ scope: scope(options), options, titleWords, json: options.json === true });
    });

  scoped(group.command('list'))
    .description('the board for one session, or the fleet with --all')
    .option('--view <view>', `one of ${choices(TASK_LIST_VIEWS)}`)
    .option('--repo <path>', 'only tasks in this repository')
    .option('--assignee <who>', 'only tasks owned by this teammate')
    .option('--kind <kind>', `only ${choices(TaskKindSchema.options)}`)
    .option('--status <status>', 'only this status (repeatable)', collect, [])
    .option('--query <text>', 'only tasks whose number, title, description, ask or clarifications contain this text')
    .option('--md', 'render the board as markdown')
    .option('--all', 'read every session on this host')
    .action(async (options: TaskListOptions & ScopeOptions) => {
      await list.run({ scope: scope(options), options, markdown: options.md === true, json: options.json === true });
    });

  scoped(group.command('show'))
    .description('one task in full, with its history')
    .argument('<id>', 'the task id, for example F21')
    .option('--after <seq>', 'only history after this sequence number')
    .option('--md', 'render the task as markdown')
    .action(async (id: string, options: { after?: string } & ScopeOptions) => {
      await show.run({
        scope: scope(options),
        id,
        after: options.after,
        markdown: options.md === true,
        json: options.json === true,
      });
    });

  scoped(group.command('status'))
    .description('move a task, recording why')
    .argument('<id>', 'the task id')
    .argument('<status>', `one of ${choices(TaskStatusSchema.options)}`)
    .requiredOption('--reason <why>', 'why it moved; the history keeps this')
    .option('--note <text>', 'extra context for the move')
    .action(async (id: string, status: string, options: { reason?: string; note?: string } & ScopeOptions) => {
      await act.run({
        scope: scope(options),
        id,
        request: buildStatusAction(status, options),
        json: options.json === true,
      });
    });

  scoped(group.command('phase'))
    .description('move a task to an audit phase, recording why')
    .argument('<id>', 'the task id')
    .argument('<phase>', `one of ${choices(TaskPhaseSchema.options)}`)
    .requiredOption('--reason <why>', 'why it moved')
    .action(async (id: string, phase: string, options: { reason?: string } & ScopeOptions) => {
      await act.run({
        scope: scope(options),
        id,
        request: buildPhaseAction(phase, options),
        json: options.json === true,
      });
    });

  scoped(group.command('reopen'))
    .description('reopen a finished task together with the new ask that reopened it')
    .argument('<id>', 'the task id')
    .requiredOption('--reason <why>', 'why it is being reopened')
    .requiredOption('--ask <text>', 'the new human ask, verbatim')
    .requiredOption('--source <link>', 'where that ask came from')
    .action(async (id: string, options: { reason?: string; ask?: string; source?: string } & ScopeOptions) => {
      await act.run({ scope: scope(options), id, request: buildReopenAction(options), json: options.json === true });
    });

  scoped(group.command('clarify'))
    .description('append a verbatim clarification to the original ask')
    .argument('<id>', 'the task id')
    .argument('<text...>', 'the clarification, verbatim')
    .requiredOption('--source <link>', 'where it came from')
    .action(async (id: string, text: string[], options: { source?: string } & ScopeOptions) => {
      await act.run({
        scope: scope(options),
        id,
        request: buildClarifyAction(text, options),
        json: options.json === true,
      });
    });

  scoped(group.command('depend'))
    .description('declare or drop a dependency on another task')
    .argument('<id>', 'the task id')
    .argument('<dependency>', 'the task it waits on')
    .option('--remove', 'drop the dependency instead of adding it')
    .action(async (id: string, dependency: string, options: { remove?: boolean } & ScopeOptions) => {
      await act.run({
        scope: scope(options),
        id,
        request: buildDependencyAction(dependency, options),
        json: options.json === true,
      });
    });

  scoped(group.command('file'))
    .description('claim or release a file; claims are advisory, never a lock')
    .argument('<id>', 'the task id')
    .argument('<path>', 'the file being claimed')
    .option('--remove', 'release the claim instead of taking it')
    .option('--reason <why>', 'optional context for the claim')
    .action(async (id: string, path: string, options: { remove?: boolean; reason?: string } & ScopeOptions) => {
      await act.run({
        scope: scope(options),
        id,
        request: buildFileAction(path, options),
        json: options.json === true,
      });
    });

  for (const kind of ['note', 'feedback'] as const) {
    scoped(group.command(kind))
      .description(kind === 'note' ? 'append a note to the history' : 'append reviewer feedback to the history')
      .argument('<id>', 'the task id')
      .argument('<text...>', 'what to record')
      .action(async (id: string, text: string[], options: ScopeOptions) => {
        await act.run({ scope: scope(options), id, request: buildTextAction(kind, text), json: options.json === true });
      });
  }

  scoped(group.command('link'))
    .description('attach exactly one link to a task')
    .argument('<id>', 'the task id')
    .option('--pr <url>', 'a pull request')
    .option('--branch <branch>', 'the branch')
    .option('--commit <sha>', 'a commit')
    .option('--doc <path>', 'a document')
    .action(async (id: string, options: TaskLinkOptions & ScopeOptions) => {
      await act.run({ scope: scope(options), id, request: buildLinkAction(options), json: options.json === true });
    });

  scoped(group.command('assign'))
    .description('hand a task to a teammate, or take it back')
    .argument('<id>', 'the task id')
    .argument('[who]', 'the teammate to assign it to')
    .option('--none', 'unassign instead')
    .action(async (id: string, who: string | undefined, options: { none?: boolean } & ScopeOptions) => {
      await act.run({
        scope: scope(options),
        id,
        request: buildAssignAction(who, options),
        json: options.json === true,
      });
    });

  scoped(group.command('order'))
    .description('rank a task on the board, or clear its rank')
    .argument('<id>', 'the task id')
    .argument('[rank]', 'a whole number')
    .option('--none', 'clear the rank instead')
    .action(async (id: string, rank: string | undefined, options: { none?: boolean } & ScopeOptions) => {
      await act.run({
        scope: scope(options),
        id,
        request: buildOrderAction(rank, options),
        json: options.json === true,
      });
    });

  return group;
}
