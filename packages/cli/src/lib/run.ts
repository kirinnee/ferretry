/**
 * The router: one `fy` invocation, from argv to an exit code. The shell holds no feature: it resolves a verb line
 * against the manifests' declarations, opens the guarded client, and hands the plugin's own `cli` half the call.
 */
import { type Cancel, skeletonSentence } from '@ferretry/kernel/contract';
import type { VerbHandler } from '@ferretry/kernel/manifest';
import { parseArgs } from './argv.ts';
import {
  type ClientDeps,
  type FollowingClient,
  pluginClient,
  routeFactsBeforeContact,
  type Surfaces,
  surfacesOf,
} from './client.ts';
import { AS_OWNER_NOTE, inPane } from './credential.ts';
import { askVerb } from './commands/ask.ts';
import {
  daemonInstall,
  daemonLogs,
  daemonReset,
  daemonRestart,
  daemonStart,
  daemonStatus,
  daemonStop,
  daemonUninstall,
  daemonWhich,
} from './commands/daemon.ts';
import { doctorVerb } from './commands/doctor.ts';
import { pluginInstall, pluginList, pluginOff, pluginOn, pluginShow } from './commands/plugin.ts';
import {
  machineCloneVerb,
  machineExportVerb,
  machineInstallVerb,
  machineSetVerb,
  machineShowVerb,
} from './commands/machine.ts';
import { wordsVerb } from './commands/words.ts';
import { updateVerb } from './commands/update.ts';
import { EXIT, errorText, ShellError } from './errors.ts';
import { pluginEnvironment } from './plugin-env.ts';
import { buildPluginGraph } from './plugin-graph.ts';
import type { ShellContext, ShellVerb } from './shell-context.ts';
import { buildVerbTable, expandAlias, renderHelp, resolveVerb, type VerbEntry } from './verbs.ts';
import type { CliWorld } from './world.ts';

/** The shell's own verb lines and their handlers. The line is the key, exactly as `SHELL_VERB_LINES` spells it. */
const SHELL_HANDLERS: Readonly<Record<string, ShellVerb>> = {
  'plugin list': pluginList,
  'plugin show': pluginShow,
  'plugin on': pluginOn,
  'plugin off': pluginOff,
  'plugin add': pluginInstall,
  'plugin remove': pluginInstall,
  'plugin check': pluginInstall,
  words: wordsVerb,
  doctor: doctorVerb,
  'daemon status': daemonStatus,
  'daemon start': daemonStart,
  'daemon stop': daemonStop,
  'daemon restart': daemonRestart,
  'daemon install': daemonInstall,
  'daemon uninstall': daemonUninstall,
  'daemon logs': daemonLogs,
  'daemon which': daemonWhich,
  'daemon reset': daemonReset,
  ask: askVerb,
  machine: machineShowVerb,
  'machine set': machineSetVerb,
  'machine install': machineInstallVerb,
  'machine export': machineExportVerb,
  'machine clone': machineCloneVerb,
  update: updateVerb,
};

/** Flags before the verb. `--help` and `--version` anywhere in the leading flags answer at once. */
interface Leading {
  readonly asOwner: boolean;
  readonly help: boolean;
  readonly version: boolean;
  readonly rest: readonly string[];
}

function leadingFlags(argv: readonly string[]): Leading | string {
  let asOwner = false;
  let help = false;
  let version = false;
  let index = 0;
  for (; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (!token.startsWith('-')) break;
    if (token === '--as-owner') asOwner = true;
    else if (token === '--help' || token === '-h') help = true;
    else if (token === '--version' || token === '-v') version = true;
    else return token;
  }
  return { asOwner, help, version, rest: argv.slice(index) };
}

/**
 * Whether the words after a verb ask for its help: `--help` or `-h` anywhere before `--`, with or without a value
 * the option parser would have taken for it. Asked before anything connects or any handler runs.
 */
function asksForHelp(tokens: readonly string[]): boolean {
  for (const token of tokens) {
    if (token === '--') return false;
    if (token === '--help' || token === '-h') return true;
  }
  return false;
}

/** `argv` excludes the runtime and script. Returns the exit code; never throws. */
export async function runFy(argv: readonly string[], world: CliWorld): Promise<number> {
  const { io, identity } = world;
  try {
    return await dispatch(argv, world);
  } catch (error) {
    if (error instanceof ShellError) {
      io.err(`${error.message}\n`);
      return error.exitCode;
    }
    io.err(`${identity.binary}: ${errorText(error)}\n`);
    return EXIT.failure;
  }
}

async function dispatch(argv: readonly string[], world: CliWorld): Promise<number> {
  const { io, identity } = world;
  const table = buildVerbTable(world.registry);
  const surfaces = surfacesOf(world.registry);
  const leading = leadingFlags(argv);
  if (typeof leading === 'string') {
    io.err(`unknown option ${leading}; try \`${identity.binary} --help\`\n`);
    return EXIT.usage;
  }
  if (leading.version) {
    io.out(`${identity.version}\n`);
    return EXIT.ok;
  }
  if (leading.help || leading.rest.length === 0) {
    io.out(`${renderHelp(identity.binary, table, { ...surfaces.titles })}\n`);
    return EXIT.ok;
  }

  let tokens = leading.rest;
  let resolved = resolveVerb(table, tokens);
  for (let hops = 0; resolved.kind === 'verb' && resolved.entry.alias !== undefined; hops += 1) {
    if (hops >= 4) throw new ShellError(`the alias "${resolved.entry.line}" runs another alias too many times`);
    tokens = expandAlias(resolved.entry, resolved.rest) ?? tokens;
    resolved = resolveVerb(table, tokens);
  }
  if (resolved.kind === 'unknown') {
    const typed = resolved.typed.join(' ');
    const near = resolved.nearby.map(entry => `  ${identity.binary} ${entry.words.join(' ')}`);
    io.err(
      `${identity.binary}: unknown verb "${typed}"${near.length > 0 ? `; did you mean:\n${near.join('\n')}` : `; see \`${identity.binary} --help\``}\n`,
    );
    return EXIT.usage;
  }

  const { entry } = resolved;
  if (asksForHelp(resolved.rest)) {
    io.out(`${identity.binary} ${entry.words.join(' ')}${entry.summary === undefined ? '' : `: ${entry.summary}`}\n`);
    return EXIT.ok;
  }
  const invocation = parseArgs(resolved.rest);

  let opened: Promise<ClientDeps> | undefined;
  const deps = (): Promise<ClientDeps> => {
    opened ??= (async () => {
      if (leading.asOwner && inPane(world.environment)) io.err(`${identity.binary}: ${AS_OWNER_NOTE}\n`);
      const connection = await world.connect({ asOwner: leading.asOwner });
      return {
        transport: connection.transport,
        inventory: connection.inventory,
        surfaces,
        inPane: inPane(world.environment),
        binary: identity.binary,
      };
    })();
    return opened;
  };

  if (entry.owner === 'shell') {
    const handler = SHELL_HANDLERS[entry.line];
    if (handler === undefined) throw new ShellError(`${identity.binary} has no handler for "${entry.line}"`);
    const context: ShellContext = {
      world,
      invocation,
      table,
      surfaces,
      graph: buildPluginGraph(world.registry),
      deps,
      client: caller => lazyClient(deps, caller, surfaces, inPane(world.environment)),
    };
    return await handler(context);
  }
  return await runPluginVerb(world, entry, invocation, deps, surfaces);
}

async function runPluginVerb(
  world: CliWorld,
  entry: VerbEntry,
  invocation: ReturnType<typeof parseArgs>,
  deps: () => Promise<ClientDeps>,
  surfaces: Surfaces,
): Promise<number> {
  const { io, identity } = world;
  const plugin = world.registry.plugins.find(candidate => candidate.id === entry.owner);
  if (plugin === undefined) throw new ShellError(`no plugin "${entry.owner}" declares "${entry.line}"`);
  const half = await plugin.load();
  if (half.skeleton === true || half.build === undefined) {
    io.err(`${skeletonSentence(plugin.manifest.title)}\n`);
    return EXIT.unavailable;
  }
  const built = half.build({
    manifest: plugin.manifest,
    // The client opens lazily: a verb that never calls the daemon never reads a credential.
    client: lazyClient(deps, plugin.id, surfaces, inPane(world.environment)),
    io,
    // The whole context, for every half (lead ruling): a facility left out fails the verb that needs it in the real binary.
    clock: world.host.clock,
    sleep: (delay, signal) => world.host.sleep(delay, signal),
    readText: path => world.host.readText(path),
    env: pluginEnvironment(world.environment, world.host.cwd()),
    ownState: world.host.ownState(plugin.manifest),
  });
  const handler = (built.verbs as Readonly<Record<string, VerbHandler | undefined>>)[entry.line];
  if (handler === undefined)
    throw new ShellError(
      `${plugin.manifest.title} declares "${entry.line}" but its ${identity.binary} half implements none`,
    );
  return await handler(invocation);
}

/**
 * A `PluginClient` that builds the guarded client on its first call, for plugin verbs and shell verbs alike. The
 * route's own descriptor and the pane's standing are judged FIRST (S59): a person-only call from a ferret's pane is
 * refused before the daemon is probed, started or sent anything, as today's `refuseOwnerCommandInPane` refuses before
 * the gateway.
 */
function lazyClient(deps: () => Promise<ClientDeps>, id: string, surfaces: Surfaces, paned: boolean): FollowingClient {
  const follow: FollowingClient['follow'] = (event, listener, onEnd) => {
    let cancel: Cancel | undefined;
    let stopped = false;
    // The connection opens when the first listener asks, like a call; a refusal to connect ends the feed with its words.
    void deps().then(
      opened => {
        if (stopped) return;
        try {
          cancel = pluginClient(opened, id).follow(event, listener, onEnd);
        } catch (error) {
          onEnd(errorText(error));
        }
      },
      (error: unknown) => {
        if (!stopped) onEnd(errorText(error));
      },
    );
    return () => {
      stopped = true;
      cancel?.();
    };
  };
  return {
    call: async (route, init) => {
      routeFactsBeforeContact(surfaces, paned, route);
      return await pluginClient(await deps(), id).call(route, init);
    },
    subscribe: (event, listener) => follow(event, listener, () => undefined),
    follow,
  };
}
