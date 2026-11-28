import type { KitEndInput, KitFerretChange, RuntimesHarnessKit } from '@ferretry/plugin-runtimes/contract';
import { CodexAppServerSupervisor } from './codex-runtime.ts';
import { RuntimeEndSupervision } from './runtime-end-supervision.ts';

/**
 * What a stopped Codex ferret's runtime leaves behind: its app-server pair is stopped when nothing else uses the runtime, and
 * a launch that failed is told in words. A ferret of any other harness changes nothing here.
 */
async function onFerretChanged(input: KitEndInput, change: KitFerretChange): Promise<void> {
  try {
    await follow(input, change);
  } catch (error) {
    // The host's seams are read here (a fleet folder that cannot be opened throws on first use): housekeeping never fails the
    // ending, and it is said, not swallowed, since the ferret's end never shows it.
    input.warn?.(
      `a Codex ferret stopped, but its runtime's follow-up could not run: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function follow(input: KitEndInput, change: KitFerretChange): Promise<void> {
  const { host } = input;
  await new RuntimeEndSupervision({
    ferrets: input.ferrets,
    seams:
      host === undefined
        ? undefined
        : {
            supervisor: new CodexAppServerSupervisor({
              inventory: host.inventory,
              host: { fleet: host.fleet, processes: host.processes },
              homesDirectory: host.homesDirectory,
              sleep: host.sleep,
            }),
            wrapperOf: runtime => host.wrapperOf(runtime),
          },
    ...(input.warn === undefined ? {} : { warn: input.warn }),
    launchFailed: input.launchFailed,
  }).onChanged(change);
}

/** Codex's follow-up of a stopped ferret. */
export const codexEndKit: RuntimesHarnessKit = { onFerretChanged };
