import {
  type FleetComponentInput,
  FleetComponentInputSchema,
  type FleetComponentKind,
  FleetComponentKindSchema,
  type FleetComponentView,
  type FleetEnvInput,
} from '@ferretry/protocol';
import type { Command } from 'commander';
import { runChange } from '../fleet/account-change.ts';
import {
  collect,
  parseHarness,
  readLocalFile,
  readOptions,
  writeFlags,
  writeOptions,
} from '../fleet/account-commands.ts';
import { type AccountCommandDeps, AccountCommandError } from '../fleet/account-ports.ts';
import { renderComponent, renderComponentCatalog } from './render.ts';

const KINDS = FleetComponentKindSchema.options;

/** `<kind>/<name>` as a person typed it. */
export function parseReference(reference: string): { kind: FleetComponentKind; name: string } {
  const slash = reference.indexOf('/');
  const kind = FleetComponentKindSchema.safeParse(slash < 0 ? reference : reference.slice(0, slash));
  const name = slash < 0 ? '' : reference.slice(slash + 1);
  if (!kind.success || name === '') {
    throw new AccountCommandError(`Name a component as <kind>/<name>, where the kind is one of ${KINDS.join(', ')}.`);
  }
  return { kind: kind.data, name };
}

/** Every flag a component add or edit can carry. Each kind uses its own few. */
export interface ComponentFlags extends Record<string, unknown> {
  readonly file?: string;
  readonly harness?: string;
  readonly command?: string;
  readonly arg?: readonly string[];
  readonly url?: string;
  readonly env?: readonly string[];
  readonly item?: readonly string[];
  readonly flag?: readonly string[];
  readonly model?: readonly string[];
  readonly default?: string;
  readonly removeFromProfiles?: boolean;
}

/** `NAME=value` pairs, each one becoming a value the change sends. */
function parseEnv(pairs: readonly string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const pair of pairs) {
    const equals = pair.indexOf('=');
    if (equals <= 0) throw new AccountCommandError(`--env takes NAME=value, got "${pair}".`);
    env[pair.slice(0, equals)] = pair.slice(equals + 1);
  }
  return env;
}

/**
 * An edit keeps every variable it does not name, and a hidden value stays hidden: it is sent back as
 * "keep the one it has", never as text this terminal was never shown.
 */
function mergedEnv(current: FleetComponentView | undefined, pairs: readonly string[]): FleetEnvInput | undefined {
  const detail = current?.detail;
  const kept: FleetEnvInput = {};
  if (detail !== undefined && (detail.kind === 'mcp' || detail.kind === 'settings')) {
    for (const entry of detail.env) kept[entry.name] = 'value' in entry ? entry.value : { keep: true };
  }
  const merged = { ...kept, ...parseEnv(pairs) };
  return Object.keys(merged).length === 0 ? undefined : merged;
}

const nonEmpty = (values: readonly string[] | undefined): string[] | undefined =>
  values === undefined || values.length === 0 ? undefined : [...values];

/**
 * The component's fields from the flags, falling back to what it already has on an edit.
 *
 * Parsed through the shared schema, so a missing field is refused here in words rather than as a
 * daemon error.
 */
export function componentInput(
  kind: FleetComponentKind,
  options: ComponentFlags,
  current: FleetComponentView | undefined,
): FleetComponentInput {
  const detail = current?.detail;
  const harness = options.harness === undefined ? current?.harness : parseHarness(options.harness);
  const withHarness = harness === undefined ? {} : { harness };
  const env = mergedEnv(current, options.env ?? []);
  let candidate: Record<string, unknown>;
  switch (kind) {
    case 'instructions':
    case 'hooks':
      candidate = { kind, ...withHarness };
      break;
    case 'mcp': {
      const was = detail?.kind === 'mcp' ? detail : undefined;
      const command = options.command ?? was?.command;
      const args = nonEmpty(options.arg) ?? (was?.args === undefined ? undefined : [...was.args]);
      const url = options.url ?? was?.url;
      candidate = {
        kind,
        ...(command === undefined ? {} : { command }),
        ...(args === undefined ? {} : { args }),
        ...(url === undefined ? {} : { url }),
        ...(env === undefined ? {} : { env }),
        ...withHarness,
      };
      break;
    }
    case 'skills': {
      const items = nonEmpty(options.item) ?? (detail?.kind === 'skills' ? [...detail.items] : []);
      candidate = { kind, items, ...withHarness };
      break;
    }
    case 'settings': {
      const was = detail?.kind === 'settings' ? detail : undefined;
      const flags = nonEmpty(options.flag) ?? (was?.flags === undefined ? undefined : [...was.flags]);
      candidate = {
        kind,
        ...withHarness,
        ...(flags === undefined ? {} : { flags }),
        ...(env === undefined ? {} : { env }),
      };
      break;
    }
    case 'modelSets': {
      const was = detail?.kind === 'modelSets' ? detail : undefined;
      const models = nonEmpty(options.model) ?? (was === undefined ? [] : [...was.models]);
      candidate = { kind, models, default: options.default ?? was?.default ?? models[0] };
      break;
    }
  }
  const parsed = FleetComponentInputSchema.safeParse(candidate);
  if (!parsed.success) throw new AccountCommandError(MISSING[kind] ?? `That ${kind} component is not complete.`);
  return parsed.data;
}

/** What each kind needs, said once. The others always parse. */
const MISSING: Partial<Record<FleetComponentKind, string>> = {
  skills: 'A skills component needs at least one --item <skill>.',
  settings: 'A settings component belongs to one tool: add --harness claude or --harness codex.',
  hooks: 'A hooks component belongs to one tool: add --harness claude or --harness codex.',
  modelSets: 'A model set needs at least one --model <id>, and --default must be one of them.',
};

/** Mounts `components` and `component …` (docs/design/account-model.md §6.2). */
export function registerComponentCommands(program: Command, deps: AccountCommandDeps): void {
  const bin = deps.binaryName;

  readOptions(
    program
      .command('components')
      .description('the components on this machine: instructions, MCP, skills, settings, hooks and model sets')
      .argument('[kind]', `only one kind: ${KINDS.join(', ')}`),
  ).action(async (kind: string | undefined, options: { json?: boolean }) => {
    const only = kind === undefined ? undefined : FleetComponentKindSchema.safeParse(kind);
    if (only !== undefined && !only.success) {
      throw new AccountCommandError(`"${kind}" is not a kind of component: use one of ${KINDS.join(', ')}.`);
    }
    const catalog = await deps.gateway.components();
    const groups = only === undefined ? catalog.kinds : catalog.kinds.filter(group => group.kind === only.data);
    deps.out.report(
      options.json ? JSON.stringify({ ...catalog, kinds: groups }, null, 2) : renderComponentCatalog(groups, bin),
    );
  });

  const component = program.command('component').description('show, add, edit or remove one component');

  const find = async (reference: string): Promise<FleetComponentView | undefined> => {
    const { kind, name } = parseReference(reference);
    const group = (await deps.gateway.components()).kinds.find(entry => entry.kind === kind);
    return group?.components.find(entry => entry.name === name);
  };

  readOptions(
    component
      .command('show')
      .description('one component and where it is used')
      .argument('<kind/name>', 'the component'),
  ).action(async (reference: string, options: { json?: boolean }) => {
    const found = await find(reference);
    if (found === undefined) {
      throw new AccountCommandError(`There is no component ${reference}. See them all with \`${bin} components\`.`);
    }
    deps.out.report(options.json ? JSON.stringify(found, null, 2) : renderComponent(found));
  });

  const fields = (command: Command): Command =>
    command
      .option('--file <path>', "the component's text, from a local file (instructions, settings, hooks)")
      .option('--harness <tool>', 'claude or codex: the one tool it belongs to')
      .option('--command <command>', 'MCP: the command to run')
      .option('--arg <arg>', 'MCP: one argument; repeat it', collect, [])
      .option('--url <url>', 'MCP: the server address, instead of a command')
      .option('--env <NAME=value>', 'MCP or settings: one environment variable; repeat it', collect, [])
      .option('--item <skill>', 'skills: one skill; repeat it', collect, [])
      .option('--flag <flag>', 'settings: one launch flag; repeat it', collect, [])
      .option('--model <id>', 'model set: one model; repeat it', collect, [])
      .option('--default <id>', 'model set: the model it starts with');

  const put = async (reference: string, options: ComponentFlags, create: boolean): Promise<void> => {
    const { kind, name } = parseReference(reference);
    const current = create ? undefined : await find(reference);
    if (!create && current === undefined) {
      throw new AccountCommandError(
        `There is no component ${reference} to edit. Add it with \`${bin} component add ${reference}\`.`,
      );
    }
    const content = options.file === undefined ? undefined : await readLocalFile(deps.readText, options.file);
    await runChange(deps, {
      change: {
        kind: 'component.put',
        name,
        component: componentInput(kind, options, current),
        ...(content === undefined ? {} : { content }),
        create,
      },
      destructive: !create,
      options: writeFlags(options),
    });
  };

  writeOptions(
    fields(component.command('add').description('add a component').argument('<kind/name>', 'the component')),
  ).action(async (reference: string, options: ComponentFlags) => {
    await put(reference, options, true);
  });

  writeOptions(
    fields(
      component
        .command('edit')
        .description('change a component; every profile and runtime that uses it changes too')
        .argument('<kind/name>', 'the component'),
    ),
  ).action(async (reference: string, options: ComponentFlags) => {
    await put(reference, options, false);
  });

  writeOptions(
    component
      .command('rm')
      .alias('remove')
      .description('remove a component (refused while a profile uses it, unless --remove-from-profiles)')
      .argument('<kind/name>', 'the component')
      .option('--remove-from-profiles', 'take it out of every profile that has it first'),
  ).action(async (reference: string, options: ComponentFlags) => {
    const { kind, name } = parseReference(reference);
    await runChange(deps, {
      change: {
        kind: 'component.remove',
        componentKind: kind,
        name,
        ...(options.removeFromProfiles === true ? { removeFromProfiles: true } : {}),
      },
      destructive: true,
      options: writeFlags(options),
    });
  });
}
