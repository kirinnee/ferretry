import type { IProgress, ProgressStepOptions } from '../../../src/lib/progress/index';

/** Progress that writes down what it was told, in order: the fake behind every "names its steps" test. */
export class RecordingProgress implements IProgress {
  readonly events: string[] = [];

  start(label: string, options?: ProgressStepOptions): void {
    this.events.push(
      options?.expectedSeconds === undefined
        ? `start ${label}`
        : `start ${label} [${String(options.expectedSeconds)}s]`,
    );
  }

  detail(text: string): void {
    this.events.push(`detail ${text}`);
  }

  succeed(text?: string): void {
    this.events.push(text === undefined ? 'succeed' : `succeed ${text}`);
  }

  fail(text?: string): void {
    this.events.push(text === undefined ? 'fail' : `fail ${text}`);
  }

  pause(): void {
    this.events.push('pause');
  }

  stop(): void {
    this.events.push('stop');
  }

  /** The labels of the steps begun, without their details. */
  get steps(): string[] {
    return this.events.filter(event => event.startsWith('start ')).map(event => event.slice('start '.length));
  }
}
