import ora, { type Ora } from 'ora';

/** Live-status port for the CLI controllers. */
export interface ISpinner {
  start(text: string): void;
  succeed(text: string): void;
  fail(text: string): void;
}

export class OraSpinner implements ISpinner {
  constructor(private readonly spinner: Ora = ora()) {}

  start(text: string): void {
    this.spinner.start(text);
  }

  succeed(text: string): void {
    this.spinner.succeed(text);
  }

  fail(text: string): void {
    this.spinner.fail(text);
  }
}
