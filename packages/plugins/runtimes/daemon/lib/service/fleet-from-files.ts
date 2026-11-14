/**
 * Publishing the fleet from the configuration files as they stand (docs/config-files.md), the way v4 did after every
 * configuration load: once after start, and after each change to a file Runtimes reads.
 *
 * One publish runs at a time and a change that arrives meanwhile earns exactly one more run after it, so a burst of
 * edits publishes the last of them and never queues a run per edit. A refusal (a file that does not parse, a login that
 * stands in) is SAID once per run and never thrown: the kernel keeps the last good file in effect and the next change
 * publishes again. An unchanged fleet publishes nothing (`republish` answers `unchanged`).
 */
export interface FleetFromFilesDeps {
  /** One publish from the files; answers what it did. Absent on a daemon whose catalogue cannot be opened. */
  republish(): Promise<'applied' | 'unchanged' | 'skipped' | undefined>;
  warn(message: string): void;
}

export interface FleetFromFiles {
  /** Publish now and resolve when the publish (and any change that arrived during it) has finished. Never rejects. */
  now(): Promise<void>;
  /** A file moved: publish soon. Fire and forget; never throws. */
  soon(): void;
}

export function fleetFromFiles(deps: FleetFromFilesDeps): FleetFromFiles {
  let running: Promise<void> | undefined;
  let again = false;

  const loop = async (): Promise<void> => {
    do {
      again = false;
      try {
        await deps.republish();
      } catch (error) {
        deps.warn(
          `the fleet could not be published from its configuration files: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    } while (again);
  };

  const now = async (): Promise<void> => {
    if (running !== undefined) {
      again = true;
      await running;
      return;
    }
    running = loop().finally(() => {
      running = undefined;
    });
    await running;
  };

  return {
    now,
    soon: () => {
      void now();
    },
  };
}
