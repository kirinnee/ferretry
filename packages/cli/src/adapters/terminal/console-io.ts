import chalk from 'chalk';

/** Presentation port for the CLI controllers — success/warn to stdout, error to stderr. */
export interface ICliIo {
  success(message: string): void;
  /**
   * stdout exactly as given, for a rendering that already carries its own colour.
   *
   * `success` paints its whole message green, which is right for "that worked" and wrong for a
   * REPORT: a green wrap over `fy fleet health` made a rejected account and a healthy one the same
   * colour, so colour carried nothing and every row had to be read to be triaged. A renderer that
   * decides severity per line has to be the last thing that paints it.
   */
  report(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  /** Machine-readable diagnostic on stderr, deliberately without presentation colour. */
  diagnostic(message: string): void;
  setExitCode(code: number): void;
  interactive(): boolean;
}

export class ConsoleIo implements ICliIo {
  success(message: string): void {
    console.log(chalk.green(message));
  }

  report(message: string): void {
    console.log(message);
  }

  warn(message: string): void {
    console.log(chalk.yellow(message));
  }

  error(message: string): void {
    console.error(chalk.red(message));
  }

  diagnostic(message: string): void {
    console.error(message);
  }

  setExitCode(code: number): void {
    process.exitCode = code;
  }

  interactive(): boolean {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY);
  }
}
