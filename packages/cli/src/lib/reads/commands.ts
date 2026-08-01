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
export type ReadsCommandController = Pick<
  ReadsController,
  'attach' | 'snapshot' | 'logs' | 'events' | 'stream' | 'wait'
>;

/** The two process events that release a long-lived stream. */
export interface StreamSignalSource {
  once(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  off(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

/** Own the signal listeners for exactly as long as one stream command is alive. */
export async function runCancellableStream(
  controller: ReadsCommandController,
  id: string | undefined,
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
 * `attach` asks the daemon for a freshly validated pane proof; it never derives a tmux name from the
 * public session view. `stream` takes an optional id because the socket itself is daemon-scoped.
 */
export function registerReadsCommands(program: Command, controller: ReadsCommandController): void {
  program
    .command('attach')
    .description('attach this terminal to the daemon-verified session pane (Ctrl-b d detaches)')
    .argument('<id>', 'session id')
    .action(async (id: string) => {
      await controller.attach(id);
    });

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
    .option('--turn <number>', 'read one explicitly bounded transcript turn', Number)
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
    .description("follow one session or this daemon's whole fleet until interrupted")
    .argument('[id]', 'optional session id; omitted follows the daemon-local fleet')
    .option('--after <sequence>', 'start after this sequence', Number)
    .option('--json', 'print one protocol event per line')
    .action(async (id: string | undefined, options: StreamOptions) => {
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
