import type { IProgress, ProgressStepOptions } from './ports.ts';

/** Run `work` as one named step: completed when it returns, failed when it throws. */
export async function withStep<T>(
  progress: IProgress,
  label: string,
  work: () => Promise<T>,
  options?: ProgressStepOptions,
): Promise<T> {
  progress.start(label, options);
  try {
    const result = await work();
    progress.succeed();
    return result;
  } catch (error: unknown) {
    progress.fail();
    throw error;
  }
}
