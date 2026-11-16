/**
 * `fy mcp serve` for a ferret, without the command registry: the guarded agent-tool client over the ferret's own
 * connection, the tool door's facts, and the serve module. Nothing else of the CLI is loaded.
 *
 * It acts ONLY as the ferret whose pane credential (`FY_SESSION_TOKEN`, or its documented alias) it holds. It never reads
 * `FY_TOKEN` and never the admin token file, refuses `--as-owner`, and a missing, empty or unprefixed pane credential
 * ends it at once, saying so, before it reads a byte of input or sends a request: there is no fallback to the owner,
 * because a tools server that held the owner's authority would be an agent holding it (`docs/secrets.md`).
 *
 * A slice because every agent runtime starts `fy mcp serve` and keeps it for the life of its pane, so a machine running
 * thirty ferrets runs thirty of these. Loading the registry made each one 170 MiB; see `src/lib/entry/route.ts` for
 * which invocations come here and why only those, and `tests/sit/mcp-serve-memory.sit.test.ts` for the budget.
 */
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import root from '../../../package.json' with { type: 'json' };
import pkg from '../package.json' with { type: 'json' };
import { daemonAddressing, openFerretConnection, restartWaiting } from '../src/adapters/daemon/ferret-connection.ts';
import { ConsoleIo } from '../src/adapters/terminal/console-io.ts';
import { serveHalf, toolDoor } from '../src/generated/slim.ts';
import type { ClientDeps } from '../src/lib/client.ts';
import { paneCredential } from '../src/lib/credential.ts';
import { mcpServeInvocation } from '../src/lib/entry/route.ts';
import { toolSurfaces } from '../src/lib/entry/tool-door.ts';
import { EXIT, reportFailure, ShellError } from '../src/lib/errors.ts';
import { resolveHome } from '../src/lib/home.ts';
import { lazyClient } from '../src/lib/lazy-client.ts';

/** The plugin whose half this is: the id the guard checks first, with the tool's own owner. */
const SERVE_PLUGIN = 'mcp';

/** Runs `fy mcp serve`; `argv` is `process.argv`. Returns the exit code. */
export async function execute(argv: readonly string[]): Promise<number> {
  const io = new ConsoleIo();
  const binary = Object.keys(pkg.bin)[0] ?? pkg.name;
  try {
    const environment = process.env;
    const invocation = mcpServeInvocation(argv.slice(2));
    if (invocation === undefined) throw new Error('this entry runs `mcp serve` only');
    if (invocation.asOwner)
      throw new ShellError(
        `${binary}: \`mcp serve\` acts only as the ferret whose pane credential it holds; --as-owner is refused. Nothing was sent.`,
        EXIT.usage,
      );
    // Only the pane's own `fys_` credential. `FY_TOKEN` is not read here, so it cannot be sent, whatever it holds.
    const bearer = paneCredential(environment);
    if (bearer === undefined)
      throw new ShellError(
        `${binary}: \`mcp serve\` needs the pane credential of the ferret it serves (FY_SESSION_TOKEN, starting with fys_), and it is missing, empty or not one. It does not fall back to the owner. Nothing was sent.`,
        EXIT.failure,
      );
    const declared = environment.HOME;
    const home = resolveHome(
      declared !== undefined && isAbsolute(declared) ? declared : homedir(),
      environment.FY_HOME,
      root.name,
    );
    const addressing = daemonAddressing(environment, home);
    const restart = restartWaiting(io, binary);
    const surfaces = toolSurfaces(toolDoor);
    const paned = true;
    let opened: Promise<ClientDeps> | undefined;
    // The connection opens on the first call, like the full program's: a server nobody calls never reads a credential.
    const deps = (): Promise<ClientDeps> => {
      opened ??= (async () => {
        const connection = await openFerretConnection({
          environment,
          addressing,
          restart,
          fetcher: (url, init) => fetch(url, init),
          bearer,
        });
        return { transport: connection.transport, inventory: connection.inventory, surfaces, inPane: paned, binary };
      })();
      return opened;
    };
    const serveTools = await serveHalf.load();
    return await serveTools({
      client: lazyClient(deps, SERVE_PLUGIN, surfaces, paned),
      io,
      stdin: () => Bun.stdin.stream(),
      version: serveHalf.version,
      instructions: await serveHalf.instructions(),
    });
  } catch (error) {
    return reportFailure(error, io, binary);
  }
}
