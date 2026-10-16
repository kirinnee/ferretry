import { HARNESS_SCOPE_WORDS } from '@ferretry/fleet';
import type { FleetLayeredProfileCatalog, FleetLayeredProfileView, FleetProfileScope } from '@ferretry/protocol';
import type { Command } from 'commander';
import { runChange } from '../fleet/account-change.ts';
import { collect, readOptions, writeFlags, writeOptions } from '../fleet/account-commands.ts';
import { type AccountCommandDeps, AccountCommandError } from '../fleet/account-ports.ts';
import { HARNESS_LABEL, indent, listOrNone, unavailable } from '../fleet/account-render.ts';
import { renderStack } from '../runtime/render.ts';

/** A profile's scope badge: "Generic", "Claude only", "Codex only", or "Mixed" for one written before P7. */
const scopeBadge = (scope: FleetProfileScope): string =>
  scope.kind === 'mixed' ? 'Mixed' : HARNESS_SCOPE_WORDS[scope.scope];

/** The Profiles tab in a terminal. */
export function renderProfileList(catalog: FleetLayeredProfileCatalog, binaryName: string): string {
  if (catalog.profiles.length === 0) {
    return `No profiles yet. Build one with \`${binaryName} profile build <name> --layer instructions/<name>\`.`;
  }
  return catalog.profiles
    .map(profile => {
      const conflicts = profile.harnesses.reduce((total, stack) => total + stack.conflicts.length, 0);
      return [
        `${profile.name}  ${scopeBadge(profile.scope)} · ${profile.layers.length} layer${profile.layers.length === 1 ? '' : 's'}${conflicts > 0 ? ` · ${conflicts} override${conflicts === 1 ? '' : 's'}` : ''}`,
        ...indent([
          `Used by: ${listOrNone(profile.usedBy, 'no runtime')}`,
          ...(profile.scope.kind === 'mixed' ? [profile.scope.sentence] : []),
        ]),
      ].join('\n');
    })
    .join('\n');
}

/** One profile: its layers newest last, each harness's stack, and where it is used. */
export function renderProfile(profile: FleetLayeredProfileView): string {
  const lines = [
    `${profile.name}  (${scopeBadge(profile.scope)})`,
    ...indent([
      ...(profile.scope.kind === 'mixed' ? [profile.scope.sentence] : []),
      'Layers, oldest first (a later layer wins):',
      ...profile.layers.map(layer => `  ${layer}`),
      `Used by: ${listOrNone(profile.usedBy, 'no runtime')}`,
      ...(profile.baseFor.length === 0 ? [] : [`Base for: ${profile.baseFor.join(', ')}`]),
    ]),
  ];
  for (const stack of profile.harnesses) {
    lines.push(...indent([`On ${HARNESS_LABEL[stack.harness]}:`, ...renderStack(stack).map(line => `  ${line}`)]));
  }
  const removal = unavailable(profile.remove);
  if (removal !== undefined) lines.push(...indent([`Cannot delete yet: ${removal}`]));
  return lines.join('\n');
}

interface ProfileFlags extends Record<string, unknown> {
  readonly layer?: readonly string[];
  readonly switchRuntimesTo?: string;
}

const layersOf = (options: ProfileFlags, bin: string): string[] => {
  const layers = [...(options.layer ?? [])];
  if (layers.length === 0) {
    throw new AccountCommandError(
      `A profile needs at least one layer: --layer instructions/<name> (or profile/<name>). See them with \`${bin} components\`.`,
    );
  }
  return layers;
};

/** Mounts `profiles` and `profile …` (docs/design/account-model.md §6.2). */
export function registerProfileCommands(program: Command, deps: AccountCommandDeps): void {
  const bin = deps.binaryName;
  const list = async (options: { json?: boolean }): Promise<void> => {
    const catalog = await deps.gateway.profiles();
    deps.out.report(options.json ? JSON.stringify(catalog, null, 2) : renderProfileList(catalog, bin));
  };
  readOptions(
    program
      .command('profiles')
      .description('the profiles on this machine: scope, layers, overrides and where each is used'),
  ).action(list);

  const profile = program.command('profile').description('list, build, show, edit or delete profiles');

  readOptions(
    profile
      .command('ls')
      .alias('list')
      .description('the profiles on this machine, each with its scope: Generic, Claude only or Codex only'),
  ).action(list);

  readOptions(
    profile
      .command('show')
      .description('one profile: its layers, overrides and where it is used')
      .argument('<name>', 'the profile'),
  ).action(async (name: string, options: { json?: boolean }) => {
    const found = (await deps.gateway.profiles()).profiles.find(entry => entry.name === name);
    if (found === undefined) {
      throw new AccountCommandError(`There is no profile called "${name}". See them all with \`${bin} profiles\`.`);
    }
    deps.out.report(options.json ? JSON.stringify(found, null, 2) : renderProfile(found));
  });

  const layerOption = (command: Command): Command =>
    command.option(
      '--layer <kind/name>',
      'a component (instructions/main) or another profile (profile/default); repeat it, oldest first',
      collect,
      [],
    );

  writeOptions(
    layerOption(
      profile.command('build').description('build a new profile from layers').argument('<name>', 'the profile name'),
    ),
  ).action(async (name: string, options: ProfileFlags) => {
    await runChange(deps, {
      change: { kind: 'profile.put', name, layers: layersOf(options, bin), create: true },
      destructive: false,
      options: writeFlags(options),
    });
  });

  writeOptions(
    layerOption(
      profile
        .command('edit')
        .description("replace a profile's layers; every runtime on it changes")
        .argument('<name>', 'the profile'),
    ),
  ).action(async (name: string, options: ProfileFlags) => {
    await runChange(deps, {
      change: { kind: 'profile.put', name, layers: layersOf(options, bin), create: false },
      destructive: true,
      options: writeFlags(options),
    });
  });

  writeOptions(
    profile
      .command('rm')
      .alias('remove')
      .description('delete a profile')
      .argument('<name>', 'the profile')
      .option('--switch-runtimes-to <profile>', 'move every runtime on it to this profile first'),
  ).action(async (name: string, options: ProfileFlags) => {
    await runChange(deps, {
      change: {
        kind: 'profile.remove',
        name,
        ...(options.switchRuntimesTo === undefined ? {} : { switchRuntimesTo: options.switchRuntimesTo }),
      },
      destructive: true,
      options: writeFlags(options),
    });
  });
}
