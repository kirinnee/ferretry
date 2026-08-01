import type { Command } from 'commander';
import type {
  EventsOptions,
  LogsOptions,
  ReadsController,
  SnapshotOptions,
  StreamOptions,
  WaitOptions,
} from './controller.ts';

/** The controller surface command registration calls, narrow enough for a recording test double. */
export type ReadsCommandController = Pick<ReadsController, 'snapshot' | 'logs' | 'events' | 'stream' | 'wait'>;

/** The two process events that release a long-lived stream. */
export interface StreamSignalSource {
  once(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

/** Own the signal listeners for exactly as long as one stream command is alive. */
export async function runCancellableStream(
  controller: ReadsCommandController,
  id: string,
  options: StreamOptions,
  signals: StreamSignalSource = process,
): Promise<void> {
  const controllerAbort = new AbortController();
  const stop = (): void => controllerAbort.abort();
  signals.once('SIGINT', stop);
  signals.once('SIGTERM', stop);
  try {
    await controller.stream(id, options, controllerAbort.signal);
  } finally {
    signals.off('SIGINT', stop);
    signals.off('SIGTERM', stop);
  }
}

/**
 * The operator read surface: how a human watches a session that is already running.
 *
 * `view` is registered as an ALIAS of `events` rather than as a second command, because in the legacy
 * CLI the two had identical bodies — same client call, same rendering, same flags. Two commands that
 * cannot diverge are one command with two names, and saying so here means a future change to either
 * cannot silently apply to only one of them.
 *
 * `attach` is NOT registered. A `SessionView` carries no terminal address, so the CLI has nothing to
 * hand `tmux attach-session` — see `ports.ts` for the full statement of that gap.
 */
export function registerReadsCommands(program: Command, controller: ReadsCommandController): void {
  program
    .command('snapshot')
    .description("capture the session's live screen (a dead pane is refused, never served as blank)")
    .argument('<id>', 'session id')
    .option('--json', 'print the protocol payload instead of the raw screen')
    .action(async (id: string, options: SnapshotOptions) => {
      await controller.snapshot(id, options);
    });

  program
    .command('logs')
    .description("read the tail of the session's own harness transcript")
    .argument('<id>', 'session id')
    .option('--turn <number>', 'refused: this daemon keeps no per-turn log', Number)
    .action(async (id: string, options: LogsOptions) => {
      await controller.logs(id, options);
    });

  program
    .command('events')
    .alias('view')
    .description('read the durable events the daemon recorded for a session')
    .argument('<id>', 'session id')
    .option('--after <sequence>', 'start after this sequence', Number)
    .option('--limit <count>', 'stop after this many events', Number)
    .option('--json', 'print one protocol event per line')
    .action(async (id: string, options: EventsOptions) => {
      await controller.events(id, options);
    });

  program
    .command('stream')
    .description("follow a session's events until interrupted (says so when nothing arrives)")
    .argument('<id>', 'session id — there is no fleet-wide form; see the controller for why')
    .option('--after <sequence>', 'start after this sequence', Number)
    .option('--interval <seconds>', 'how often to ask the daemon again', Number)
    .option('--json', 'print one protocol event per line')
    .action(async (id: string, options: StreamOptions) => {
      await runCancellableStream(controller, id, options);
    });

  program
    .command('wait')
    .description(
      'block until a session settles; exits 0 completed, 1 ended, 3 needs a human, 69 daemon lost, 124 timeout',
    )
    .argument('<id>', 'session id')
    .option('--json', 'print the session state as one line of JSON')
    .option('--timeout <seconds>', 'give up after this many seconds (exit 124)', Number)
    .option('--interval <seconds>', 'how often to ask the daemon again', Number)
    .option('--until-marker <file>', 'wait for this file rather than trusting a completion claim')
    .action(async (id: string, options: WaitOptions) => {
      await controller.wait(id, options);
    });
}
