/**
 * The router: one `fy` invocation, from argv to an exit code. The shell holds no feature: it resolves a verb line
 * against the manifests' declarations, opens the guarded client, and hands the plugin's own `cli` half the call.
 */
import { skeletonSentence } from '@ferretry/kernel/contract';
import type { VerbHandler } from '@ferretry/kernel/manifest';
import { parseArgs } from './argv.ts';
import { type ClientDeps, pluginClient, surfacesOf } from './client.ts';
import { AS_OWNER_NOTE, inPane } from './credential.ts';
import { askVerb } from './commands/ask.ts';
import { daemonRestart, daemonStart, daemonStatus, daemonStop } from './commands/daemon.ts';
import { doctorVerb } from './commands/doctor.ts';
import { pluginInstall, pluginList, pluginOff, pluginOn, pluginShow } from './commands/plugin.ts';
import { wordsVerb } from './commands/words.ts';
import { EXIT, errorText, ShellError } from './errors.ts';
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
  ask: askVerb,
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
  const invocation = parseArgs(resolved.rest);
  if (invocation.options.help === true) {
    io.out(`${identity.binary} ${entry.words.join(' ')}${entry.summary === undefined ? '' : `: ${entry.summary}`}\n`);
    return EXIT.ok;
  }

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
    const context: ShellContext = { world, invocation, table, surfaces, graph: buildPluginGraph(world.registry), deps };
    return await handler(context);
  }
  return await runPluginVerb(world, entry, invocation, deps);
}

async function runPluginVerb(
  world: CliWorld,
  entry: VerbEntry,
  invocation: ReturnType<typeof parseArgs>,
  deps: () => Promise<ClientDeps>,
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
    client: lazyClient(deps, plugin.id),
    io,
  });
  const handler = (built.verbs as Readonly<Record<string, VerbHandler | undefined>>)[entry.line];
  if (handler === undefined)
    throw new ShellError(
      `${plugin.manifest.title} declares "${entry.line}" but its ${identity.binary} half implements none`,
    );
  return await handler(invocation);
}

/** A `PluginClient` that builds the guarded client on its first call. */
function lazyClient(deps: () => Promise<ClientDeps>, id: string): ReturnType<typeof pluginClient> {
  return {
    call: async (route, init) => await pluginClient(await deps(), id).call(route, init),
    subscribe: (event, listener) => {
      void event;
      void listener;
      throw new ShellError('events are not available to fy verbs in this build', EXIT.unavailable);
    },
  };
}
