import type { LifecyclePort } from '../contract/ports.ts';

/** One per plugin; the host runs every plugin's `onStop` handlers in reverse start order (§7.6 step 9). */
export class PluginLifecycle implements LifecyclePort {
  private readonly handlers: (() => void | Promise<void>)[] = [];
  private readonly controller = new AbortController();
  private stoppingNow = false;

  onStop(fn: () => void | Promise<void>): void {
    this.handlers.push(fn);
  }

  stopping(): boolean {
    return this.stoppingNow;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Runs its handlers in reverse registration order; a throwing handler does not stop the others. */
  async stop(onError: (error: unknown) => void): Promise<void> {
    if (this.stoppingNow) return;
    this.stoppingNow = true;
    this.controller.abort();
    for (const handler of [...this.handlers].reverse()) {
      try {
        await handler();
      } catch (error) {
        onError(error);
      }
    }
  }
}
