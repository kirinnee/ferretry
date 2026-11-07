/** Fakes the CLI half's tests share: output, prompt, clock and progress that write down what they were told. */
import type { Health } from '@ferretry/kernel/contract';
import type { IClockPort, IDaemonOutput, IDaemonPrompt } from '../../../src/lib/update/machine.ts';
import type { IProgress, ProgressStepOptions } from '../../../src/lib/update/progress.ts';

export const health = (overrides: Partial<Health> = {}): Health => ({ protocol: 1, version: '1.2.3', ...overrides });

export class CapturedOutput implements IDaemonOutput {
  readonly lines: string[] = [];
  exitCode: number | undefined;

  success(message: string): void {
    this.lines.push(`ok: ${message}`);
  }

  warn(message: string): void {
    this.lines.push(`warn: ${message}`);
  }

  error(message: string): void {
    this.lines.push(`err: ${message}`);
  }

  setExitCode(code: number): void {
    this.exitCode = code;
  }

  get text(): string {
    return this.lines.join('\n');
  }
}

export class FakePrompt implements IDaemonPrompt {
  readonly asked: string[] = [];

  constructor(private readonly answer = 'reset') {}

  ask(message: string): Promise<string> {
    this.asked.push(message);
    return Promise.resolve(this.answer);
  }
}

/** A clock that advances by a fixed step every time it is read, so waits terminate. */
export class SteppingClock implements IClockPort {
  readonly slept: number[] = [];
  private current = 0;

  constructor(private readonly stepMs = 100) {}

  now(): number {
    const value = this.current;
    this.current += this.stepMs;
    return value;
  }

  sleep(milliseconds: number): Promise<void> {
    this.slept.push(milliseconds);
    return Promise.resolve();
  }
}

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
