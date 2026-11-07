import { type IProgress, PlainProgress } from '../../lib/progress/index.ts';
import { TtyProgress, type TtyProgressHost } from './tty-progress.ts';

export interface ProgressEnvironment {
  readonly stderrIsTty: boolean;
  readonly environment: Readonly<Record<string, string | undefined>>;
}

/** Whether stderr is a terminal that can redraw a line: a TTY, not CI, not `TERM=dumb`. */
export function canRedraw(world: ProgressEnvironment): boolean {
  if (!world.stderrIsTty) return false;
  const { CI, TERM } = world.environment;
  if (CI !== undefined && CI !== '' && CI !== '0' && CI.toLowerCase() !== 'false') return false;
  return TERM !== 'dumb';
}

/**
 * The progress the process gets: a spinner on a terminal, plain lines everywhere else. Both write to
 * STDERR — a progress line is a diagnostic — so `--json` on stdout stays whole whichever one this is.
 */
export function chooseProgress(
  world: ProgressEnvironment,
  plain: (line: string) => void,
  host: () => TtyProgressHost,
): IProgress {
  return canRedraw(world) ? new TtyProgress(host()) : new PlainProgress(plain);
}

/** The process's real stderr, clock, timers and Ctrl-C, for `TtyProgress`. */
export function processProgressHost(): TtyProgressHost {
  return {
    write: text => {
      process.stderr.write(text);
    },
    columns: () => process.stderr.columns || 80,
    now: () => Date.now(),
    repeat: (callback, milliseconds) => {
      const timer = setInterval(callback, milliseconds);
      timer.unref();
      return () => {
        clearInterval(timer);
      };
    },
    onInterrupt: callback => {
      const onSignal = (): void => {
        callback();
      };
      const onExit = (): void => {
        process.stderr.write('\u001b[?25h');
      };
      process.once('SIGINT', onSignal);
      process.once('exit', onExit);
      return () => {
        process.off('SIGINT', onSignal);
        process.off('exit', onExit);
      };
    },
    reraiseInterrupt: () => {
      process.kill(process.pid, 'SIGINT');
    },
  };
}
