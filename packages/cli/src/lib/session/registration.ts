import { type Command, Option } from 'commander';
import type { AnswerQuestionController } from './answer-controller.ts';
import type { InterruptSessionController, ResumeSessionController } from './lifecycle-controllers.ts';
import type { SuggestNamesController } from './name-controller.ts';
import type { SessionPresenter } from './presenter.ts';
import type { ListSessionsController } from './ps-controller.ts';
import type { SendMessageController } from './send-controller.ts';
import type { StartSessionController } from './start-controller.ts';
import type { SessionStatusController } from './status-controller.ts';

/** Every session controller, plus the presenter that reports a failure. */
export interface SessionCommandDeps {
  readonly presenter: SessionPresenter;
  readonly start: StartSessionController;
  readonly list: ListSessionsController;
  readonly status: SessionStatusController;
  readonly send: SendMessageController;
  readonly answer: AnswerQuestionController;
  readonly names: SuggestNamesController;
  readonly interrupt: InterruptSessionController;
  readonly resume: ResumeSessionController;
}

/** Repeatable option accumulator. */
const collect = (value: string, values: string[]): string[] => [...values, value];

/** Joins the variadic words of a prompt or message back into the text the caller typed. */
const joined = (parts: readonly string[]): string | undefined => {
  const text = parts.join(' ').trim();
  return text === '' ? undefined : text;
};

type CommanderOptions = Record<string, unknown>;

const text = (options: CommanderOptions, key: string): string | undefined =>
  typeof options[key] === 'string' ? (options[key] as string) : undefined;
const flag = (options: CommanderOptions, key: string): boolean | undefined =>
  options[key] === true ? true : undefined;
const count = (options: CommanderOptions, key: string): number | undefined =>
  typeof options[key] === 'number' ? (options[key] as number) : undefined;
const list = (options: CommanderOptions, key: string): string[] =>
  Array.isArray(options[key]) ? (options[key] as string[]) : [];

/**
 * Registers the session command group on a commander program.
 *
 * Wiring only: every decision lives in a controller, and each action is wrapped so a caller mistake
 * becomes a one-line message and an exit code rather than a stack trace.
 */
export function registerSessionCommands(program: Command, deps: SessionCommandDeps): void {
  const guard = <A extends unknown[]>(run: (...args: A) => Promise<void>) => {
    return async (...args: A): Promise<void> => {
      try {
        await run(...args);
      } catch (error) {
        deps.presenter.fail(error);
      }
    };
  };

  program
    .command('start')
    .description('start a session on a fleet agent')
    .argument('[prompt...]', 'the task prompt; required for --mode auto')
    .requiredOption('-a, --agent <agent>', 'the fleet agent (account wrapper) to run')
    .addOption(
      new Option('--mode <mode>', 'auto for an autonomous teammate, interactive for a human terminal')
        .choices(['auto', 'interactive'])
        .default('auto'),
    )
    .option('--name <title>', 'task title shown in `ps` and the dashboard; free-form, kept verbatim')
    .option('--teammate <callsign>', 'use this callsign instead of auto-assigning one')
    .option('--teammate-fallback', 'with --teammate: auto-assign a free callsign instead of failing on a collision')
    .option('--label <label>', 'ownership label; filter later with `ps --label`')
    .option('--parent <id>', 'parent session; an auto session started inside a pane inherits that pane by default')
    .addOption(
      new Option('--board-access <access>', "child task-board access; needs the caller's own board capability").choices(
        ['none', 'read', 'worker', 'coordinator'],
      ),
    )
    .option('--prompt-file <file>', 'read the prompt from a file instead of the command line')
    .option('--model <model>', 'override the model (alias or full id)')
    .option('--rc', 'launch with remote control so the session is steerable from the web surface')
    .option('--no-rc', 'launch without remote control')
    .option('--harness-flag <flag>', 'extra flag passed straight to the agent binary; repeatable', collect, [])
    .option('--cwd <dir>', 'working directory for the session (defaults to this one)')
    .option('-f, --file <file>', 'attach a supported image or document to the opening message; repeatable', collect, [])
    .option('--interval <seconds>', 'supervision interval', Number)
    .option('--turn-timeout <seconds>', 'kill the session when one turn runs longer than this', Number)
    .option('--nudge-after <seconds>', 'zero life signs for this long earns a continue nudge', Number)
    .option('--stall-kill-after <seconds>', 'zero life signs for this long is a stall kill', Number)
    .option(
      '--direct-max <chars>',
      'short single-line payloads up to this length are typed verbatim (0 disables)',
      Number,
    )
    .option('--max-snapshots <count>', 'pane snapshots to retain', Number)
    .option('--detach', 'return as soon as the session is persisted; the launch continues in the background')
    .option('--request-id <id>', 'idempotency key: re-running start with the same id returns the same session')
    .option('--json', 'print the session as JSON')
    .action(
      guard(async (parts: string[], options: CommanderOptions, command: Command) => {
        await deps.start.execute({
          agent: String(options.agent),
          mode: options.mode === 'interactive' ? 'interactive' : 'auto',
          ...(joined(parts) === undefined ? {} : { prompt: joined(parts) }),
          ...(text(options, 'promptFile') === undefined ? {} : { promptFile: text(options, 'promptFile') }),
          ...(text(options, 'name') === undefined ? {} : { name: text(options, 'name') }),
          ...(text(options, 'teammate') === undefined ? {} : { teammate: text(options, 'teammate') }),
          ...(flag(options, 'teammateFallback') === undefined ? {} : { teammateFallback: true }),
          ...(text(options, 'label') === undefined ? {} : { label: text(options, 'label') }),
          ...(text(options, 'parent') === undefined ? {} : { parent: text(options, 'parent') }),
          ...(options.boardAccess === undefined
            ? {}
            : { boardAccess: options.boardAccess as 'none' | 'read' | 'worker' | 'coordinator' }),
          ...(text(options, 'model') === undefined ? {} : { model: text(options, 'model') }),
          // Only state a remote-control decision when one was actually typed; otherwise the daemon
          // applies its mode-dependent default.
          ...(command.getOptionValueSource('rc') === 'cli' ? { remoteControl: options.rc === true } : {}),
          harnessFlags: list(options, 'harnessFlag'),
          ...(text(options, 'cwd') === undefined ? {} : { cwd: text(options, 'cwd') }),
          filePaths: list(options, 'file'),
          ...(count(options, 'interval') === undefined ? {} : { interval: count(options, 'interval') }),
          ...(count(options, 'turnTimeout') === undefined ? {} : { turnTimeout: count(options, 'turnTimeout') }),
          ...(count(options, 'nudgeAfter') === undefined ? {} : { nudgeAfter: count(options, 'nudgeAfter') }),
          ...(count(options, 'stallKillAfter') === undefined
            ? {}
            : { stallKillAfter: count(options, 'stallKillAfter') }),
          ...(count(options, 'directMax') === undefined ? {} : { directMax: count(options, 'directMax') }),
          ...(count(options, 'maxSnapshots') === undefined ? {} : { maxSnapshots: count(options, 'maxSnapshots') }),
          ...(flag(options, 'detach') === undefined ? {} : { detach: true }),
          ...(text(options, 'requestId') === undefined ? {} : { requestId: text(options, 'requestId') }),
          ...(flag(options, 'json') === undefined ? {} : { json: true }),
        });
      }),
    );

  program
    .command('ps')
    .description('list sessions')
    .option('-a, --all', 'include terminal sessions (completed/failed/stalled/stopped)')
    .option('-l, --label <label>', 'only sessions started with this ownership label')
    .option('--json', 'print the selected sessions as JSON')
    .action(
      guard(async (options: CommanderOptions) => {
        await deps.list.execute({
          ...(flag(options, 'all') === undefined ? {} : { all: true }),
          ...(text(options, 'label') === undefined ? {} : { label: text(options, 'label') }),
          ...(flag(options, 'json') === undefined ? {} : { json: true }),
        });
      }),
    );

  program
    .command('status')
    .description('show one session in detail')
    .argument('<id>', 'session id or callsign')
    .option('--json', 'print the session as JSON')
    .action(
      guard(async (id: string, options: CommanderOptions) => {
        await deps.status.execute(id, { ...(flag(options, 'json') === undefined ? {} : { json: true }) });
      }),
    );

  const sendAction = guard(async (id: string, parts: string[], options: CommanderOptions) => {
    await deps.send.execute(id, {
      ...(joined(parts) === undefined ? {} : { message: joined(parts) }),
      ...(text(options, 'messageFile') === undefined ? {} : { messageFile: text(options, 'messageFile') }),
      attachmentPaths: list(options, 'file'),
      ...(flag(options, 'now') === undefined ? {} : { now: true }),
      ...(flag(options, 'ask') === undefined ? {} : { ask: true }),
      ...(text(options, 'until') === undefined ? {} : { until: text(options, 'until') }),
      ...(flag(options, 'json') === undefined ? {} : { json: true }),
    });
  });

  program
    .command('send')
    .description('send a message to a session')
    .argument('<id>', 'session id or callsign')
    .argument('[message...]', 'the message text')
    .option('-f, --file <file>', 'attach a supported image or document; repeatable', collect, [])
    .option('--message-file <file>', 'read the message from a file (use for long messages)')
    .option('--now', 'interrupt the active turn and deliver immediately instead of riding the queue')
    .option('--ask', 'label this as needing a reply and park this session until the peer answers')
    .option('--until <when>', 'with --ask: give up waiting after this long (45m, 2h, or an ISO timestamp)')
    .option('--json', 'print the session as JSON')
    .action(sendAction);

  program
    .command('reply')
    .description('the peer-reply spelling of send: answers a peer that is parked on this session')
    .argument('<id>', 'session id or callsign')
    .argument('<message...>', 'the reply text')
    .option('--json', 'print the session as JSON')
    .action(sendAction);

  program
    .command('answer')
    .description("answer a session's pending structured question")
    .argument('<id>', 'session id or callsign')
    .argument('[labels...]', 'the option labels to choose')
    .option('--other <text>', 'choose the free-form Other response for one question')
    .option('--response <answer>', 'answer each question in order; repeatable', collect, [])
    .option('--json', 'print the session as JSON')
    .action(
      guard(async (id: string, labels: string[], options: CommanderOptions) => {
        await deps.answer.execute(id, {
          labels,
          ...(text(options, 'other') === undefined ? {} : { other: text(options, 'other') }),
          responses: list(options, 'response'),
          ...(flag(options, 'json') === undefined ? {} : { json: true }),
        });
      }),
    );

  program
    .command('interrupt')
    .description('interrupt the active turn so the session can be steered')
    .argument('<id>', 'session id or callsign')
    .option('--json', 'print the session as JSON')
    .action(
      guard(async (id: string, options: CommanderOptions) => {
        await deps.interrupt.execute(id, { ...(flag(options, 'json') === undefined ? {} : { json: true }) });
      }),
    );

  program
    .command('resume')
    .description('revive a stopped or dead session with its conversation intact')
    .argument('<id>', 'session id or callsign')
    .argument('[message...]', 'optional message to deliver on revival')
    .option('--json', 'print the session as JSON')
    .action(
      guard(async (id: string, parts: string[], options: CommanderOptions) => {
        await deps.resume.execute(id, {
          ...(joined(parts) === undefined ? {} : { message: joined(parts) }),
          ...(flag(options, 'json') === undefined ? {} : { json: true }),
        });
      }),
    );

  program
    .command('name')
    .description('print available teammate callsigns so a `[Name] Task` title can be composed before start')
    .option('-n, --count <count>', 'print this many callsigns', Number)
    .option('--json', 'print the callsigns as a JSON array')
    .action(
      guard(async (options: CommanderOptions) => {
        await deps.names.execute({
          ...(count(options, 'count') === undefined ? {} : { count: count(options, 'count') }),
          ...(flag(options, 'json') === undefined ? {} : { json: true }),
        });
      }),
    );
}
