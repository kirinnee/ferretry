import type { IProgress } from '../../lib/progress/index.ts';
import type { ICliIo } from './console-io.ts';

/**
 * An `ICliIo` that lifts the live progress line before anything is printed, so a warning or a result
 * lands on a clean line instead of being glued to a spinner frame. The next tick draws the line again.
 */
export class ProgressAwareIo implements ICliIo {
  constructor(
    private readonly inner: ICliIo,
    private readonly progress: IProgress,
  ) {}

  success(message: string): void {
    this.progress.pause();
    this.inner.success(message);
  }

  report(message: string): void {
    this.progress.pause();
    this.inner.report(message);
  }

  warn(message: string): void {
    this.progress.pause();
    this.inner.warn(message);
  }

  error(message: string): void {
    this.progress.pause();
    this.inner.error(message);
  }

  diagnostic(message: string): void {
    this.progress.pause();
    this.inner.diagnostic(message);
  }

  setExitCode(code: number): void {
    this.inner.setExitCode(code);
  }

  interactive(): boolean {
    return this.inner.interactive();
  }
}
