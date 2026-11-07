import type { DaemonUpdateView } from '../../contract/index.ts';

/** Poll through waiting, the restart's failed reads, and completion. An open tab also sees automatic updates. */
export function pollUpdateStatus(
  ports: {
    read(): Promise<DaemonUpdateView>;
    view(view: DaemonUpdateView): void;
    failed(cause: unknown): void;
    later(work: () => void, milliseconds: number): () => void;
  },
  milliseconds = 2_000,
): () => void {
  let current = true;
  let cancel: (() => void) | undefined;
  const read = async (): Promise<void> => {
    try {
      const view = await ports.read();
      if (current) ports.view(view);
    } catch (cause) {
      if (current) ports.failed(cause);
    } finally {
      if (current) cancel = ports.later(() => void read(), milliseconds);
    }
  };
  void read();
  return () => {
    current = false;
    cancel?.();
  };
}
