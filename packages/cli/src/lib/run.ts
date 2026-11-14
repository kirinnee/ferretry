/**
 * The router: one `fy` invocation, from argv to an exit code. The shell holds no feature: it resolves a verb line
 * against the manifests' declarations, opens the guarded client, and hands the plugin's own `cli` half the call.
 */
import { skeletonSentence } from '@ferretry/kernel/contract';
import type { VerbHandler } from '@ferretry/kernel/manifest';
import { parseArgs } from './argv.ts';
import { type ClientDeps, type Surfaces, surfacesOf } from './client.ts';
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
import { EXIT, reportFailure, ShellError } from './errors.ts';
import { lazyClient } from './lazy-client.ts';
import { pluginEnvironment } from './plugin-env.ts';
import { buildPluginGraph } from './plugin-graph.ts';
import type { ShellContext, ShellVerb } from './shell-context.ts';
import { renderGroupHelp, renderRootHelp, renderVerbHelp, usageLine, verbsUnder } from './help.ts';
import { buildVerbTable, expandAlias, resolveVerb, type VerbEntry, type VerbTable } from './verbs.ts';
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

type Unknown = Extract<ReturnType<typeof resolveVerb>, { kind: 'unknown' }>;
type Subverb = Extract<ReturnType<typeof resolveVerb>, { kind: 'subverb' }>;
/** Words that name no verb: nothing at all, or a known verb with a sub-verb that is none of its own. */
type NoVerb = Unknown | Subverb;

/** What a help request resolved to: text to print, or the words that name nothing. */
type HelpRequest =
  | { readonly kind: 'text'; readonly text: (binary: string) => string }
  | { readonly kind: 'root' }
  | { readonly kind: 'unknown'; readonly resolution: NoVerb };

/**
 * `fy help [verb ...]` and `fy <group> --help`: help for words that are a verb or the first words of several (a group).
 * Anything else falls through to the ordinary dispatch, which owns the unknown-verb sentence.
 */
function helpRequest(table: VerbTable, tokens: readonly string[]): HelpRequest | undefined {
  const viaHelp = tokens[0] === 'help' && !table.entries.some(entry => entry.words[0] === 'help');
  const words = viaHelp ? tokens.slice(1) : tokens;
  if (!viaHelp && !asksForHelp(tokens)) return undefined;
  const leading: string[] = [];
  for (const word of words) {
    if (word.startsWith('-')) break;
    leading.push(word);
  }
  if (leading.length === 0) return viaHelp ? { kind: 'root' } : undefined;
  const resolution = resolveVerb(table, leading);
  // A bare group that declares a default resolves to that sub-verb, but its help is the group's: the list of its verbs.
  if (
    resolution.kind === 'verb' &&
    resolution.entry.words.length > leading.length &&
    verbsUnder(table, leading).length > 0
  )
    return { kind: 'text', text: binary => renderGroupHelp(binary, leading, table) };
  if (resolution.kind === 'verb') {
    // A verb's own `--help` is answered after alias expansion, below; `fy help <verb>` answers it here.
    if (!viaHelp) return undefined;
    const { entry } = resolution;
    return { kind: 'text', text: binary => renderVerbHelp(binary, entry, table) };
  }
  if (verbsUnder(table, leading).length > 0)
    return { kind: 'text', text: binary => renderGroupHelp(binary, leading, table) };
  if (!viaHelp) return undefined;
  // A run that leads into a group but names nothing in it (`help agenda bogus`) is as unknown as a first word nothing owns.
  const nearby = table.entries.filter(entry => entry.words[0] === leading[0]);
  const unknown: Unknown = resolution.kind === 'unknown' ? resolution : { kind: 'unknown', typed: leading, nearby };
  return { kind: 'unknown', resolution: unknown };
}

/** A known verb with sub-verbs and a word where its sub-verb belongs that is none of them (or no word at all). */
function subverbRefusal(world: CliWorld, resolved: Subverb): number {
  const { io, identity } = world;
  const parent = resolved.parent.words.join(' ');
  const subs = resolved.subverbs.map(each => `  ${identity.binary} ${each.words.join(' ')}`);
  const said =
    resolved.word === undefined
      ? `${identity.binary}: ${parent} needs a sub-verb:`
      : `${identity.binary}: "${resolved.word}" is not a sub-verb of ${parent}${
          resolved.didYouMean === undefined
            ? ''
            : ` (did you mean "${resolved.didYouMean.words.join(' ')}"? to use "${resolved.word}" as words, put it after --)`
        }; its sub-verbs are:`;
  io.err(`${said}\n${subs.join('\n')}\n`);
  return EXIT.usage;
}

function unknownVerb(world: CliWorld, resolved: Unknown): number {
  const { io, identity } = world;
  const typed = resolved.typed.join(' ');
  const near = resolved.nearby.map(entry => `  ${identity.binary} ${entry.words.join(' ')}`);
  io.err(
    `${identity.binary}: unknown verb "${typed}"${near.length > 0 ? `; did you mean:\n${near.join('\n')}` : `; see \`${identity.binary} --help\``}\n`,
  );
  return EXIT.usage;
}

/** `argv` excludes the runtime and script. Returns the exit code; never throws. */
export async function runFy(argv: readonly string[], world: CliWorld): Promise<number> {
  const { io, identity } = world;
  try {
    return await dispatch(argv, world);
  } catch (error) {
    return reportFailure(error, io, identity.binary);
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
    io.out(`${renderRootHelp(identity.binary, table, { ...surfaces.titles })}\n`);
    return EXIT.ok;
  }
  const asked = helpRequest(table, leading.rest);
  if (asked !== undefined) {
    if (asked.kind === 'unknown')
      return asked.resolution.kind === 'unknown'
        ? unknownVerb(world, asked.resolution)
        : subverbRefusal(world, asked.resolution);
    io.out(
      `${asked.kind === 'root' ? renderRootHelp(identity.binary, table, { ...surfaces.titles }) : asked.text(identity.binary)}\n`,
    );
    return EXIT.ok;
  }

  let tokens = leading.rest;
  let resolved = resolveVerb(table, tokens);
  for (let hops = 0; resolved.kind === 'verb' && resolved.entry.alias !== undefined; hops += 1) {
    if (hops >= 4) throw new ShellError(`the alias "${resolved.entry.line}" runs another alias too many times`);
    tokens = expandAlias(resolved.entry, resolved.rest) ?? tokens;
    resolved = resolveVerb(table, tokens);
  }
  if (resolved.kind === 'unknown') return unknownVerb(world, resolved);

  if (resolved.kind === 'subverb') return subverbRefusal(world, resolved);

  const { entry } = resolved;
  if (asksForHelp(resolved.rest)) {
    io.out(`${renderVerbHelp(identity.binary, entry, table)}\n`);
    return EXIT.ok;
  }
  const invocation = parseArgs(resolved.rest);
  const lacking = missingRequiredOption(entry, invocation);
  if (lacking !== undefined) {
    io.err(`error: required option '${lacking.flag}' not specified\n${usageLine(identity.binary, entry)}\n`);
    return EXIT.failure;
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

/** The first option the verb declares required that the words do not carry, by any of its spellings (`-s, --scope <scope>`). */
function missingRequiredOption(
  entry: VerbEntry,
  invocation: ReturnType<typeof parseArgs>,
): { readonly flag: string } | undefined {
  return (entry.options ?? []).find(option => {
    if (option.required !== true) return false;
    const names = option.flag
      .split(/[|,]/u)
      .map(part => (part.trim().split(/\s+/u)[0] ?? '').replace(/^-{1,2}/u, ''))
      .filter(name => name !== '');
    return !names.some(name => invocation.options[name] !== undefined);
  });
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
    readBytes: path => world.host.readBytes(path),
    exists: path => world.host.exists(path),
    stdin: () => world.host.stdin(),
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
