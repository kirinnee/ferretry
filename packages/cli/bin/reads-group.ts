/**
 * The operator reads (`attach`, `snapshot`, `logs`, `events`, `stream`, `wait`): wired once, for the
 * full program and for the reads slice `bin/fy.ts` routes them to.
 *
 * A slice because `fy wait` and `fy stream` are the commands that SIT: a lead blocks on `fy wait` for
 * every sub-ferret, and each one used to hold the whole CLI in memory to poll one route. The slice loads
 * this module and `bin/wiring.ts` and nothing else — see docs/standards/architecture/index.md.
 */
import type { Command } from 'commander';
import { FileMarkerProbe, SystemPollClock } from '../src/adapters/reads/system-poller';
import { BunTmuxAttachProcess, ExactTmuxAttacher } from '../src/adapters/reads/tmux-attacher';
import { ProtocolPackGateway } from '../src/lib/pack/gateway';
import { registerReadsCommands } from '../src/lib/reads/commands';
import { ReadsController } from '../src/lib/reads/controller';
import { BINARY_NAME, type ConnectionWorld, type DaemonWiring, executeSlice } from './wiring';

/**
 * The reads group. The marker probe takes the INVOCATION cwd rather than reading `process.cwd()`, so a
 * relative `--until-marker` resolves against the directory the human was in.
 */
export function registerReadsGroup(program: Command, world: ConnectionWorld, { client }: DaemonWiring): void {
  registerReadsCommands(
    program,
    new ReadsController(
      client,
      world.io,
      new SystemPollClock(),
      new FileMarkerProbe(world.cwd),
      new ExactTmuxAttacher(new BunTmuxAttachProcess(), world.environment, message =>
        world.io.diagnostic(`${BINARY_NAME}: ${message}`),
      ),
      BINARY_NAME,
      // A settled wait hands back the ferret's result and stops one still running (docs/pack-mode.md).
      (() => {
        const pack = new ProtocolPackGateway(client);
        return {
          result: async (id: string) => await pack.result(id),
          stop: async (id: string, reason: string) => await pack.stop(id, reason),
        };
      })(),
    ),
  );
}

/** The reads slice: the program skeleton with this group alone on it. */
export async function execute(argv: string[]): Promise<void> {
  await executeSlice(argv, registerReadsGroup);
}
