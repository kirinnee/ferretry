import chalk from 'chalk';

/** Presentation port for the CLI controllers — success/warn to stdout, error to stderr. */
export interface ICliIo {
  success(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  setExitCode(code: number): void;
  interactive(): boolean;
}

export class ConsoleIo implements ICliIo {
  success(message: string): void {
    console.log(chalk.green(message));
  }

  warn(message: string): void {
    console.log(chalk.yellow(message));
  }

  error(message: string): void {
    console.error(chalk.red(message));
  }

  setExitCode(code: number): void {
    process.exitCode = code;
  }

  interactive(): boolean {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY);
  }
}
