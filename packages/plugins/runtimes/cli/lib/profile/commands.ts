import type { VerbInvocation } from '@ferretry/kernel/manifest';
import type { LayeredProfileCatalog, LayeredProfileView, ProfileScope } from '../../../contract/index.ts';
import { runChange } from '../fleet/account-change.ts';
import { flagList, flagOn, flagText, positional, writeFlags } from '../fleet/account-commands.ts';
import { type AccountCommandDeps, AccountCommandError } from '../fleet/account-ports.ts';
import { HARNESS_LABEL, HARNESS_SCOPE_WORDS, indent, listOrNone, unavailable } from '../fleet/account-render.ts';
import { renderStack } from '../runtime/render.ts';

/** A profile's scope badge: "Generic", "Claude only", "Codex only", or "Mixed" for one written before P7. */
const scopeBadge = (scope: ProfileScope): string =>
  scope.kind === 'mixed' ? 'Mixed' : HARNESS_SCOPE_WORDS[scope.scope];

/** The Profiles tab in a terminal. */
export function renderProfileList(catalog: LayeredProfileCatalog, binaryName: string): string {
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
export function renderProfile(profile: LayeredProfileView): string {
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

const layersOf = (invocation: VerbInvocation, bin: string): string[] => {
  const layers = flagList(invocation.options, 'layer');
  if (layers.length === 0) {
    throw new AccountCommandError(
      `A profile needs at least one layer: --layer instructions/<name> (or profile/<name>). Profiles you can build on are listed by \`${bin} profile ls\`.`,
    );
  }
  return layers;
};

/** `profile ls`: the profiles on this machine, each with its scope. */
export async function profileLs(deps: AccountCommandDeps, invocation: VerbInvocation): Promise<void> {
  const catalog = await deps.gateway.profiles();
  deps.out.report(
    flagOn(invocation.options, 'json') ? JSON.stringify(catalog, null, 2) : renderProfileList(catalog, deps.binaryName),
  );
}

/** `profile show <name>`: one profile, its layers, overrides and where it is used. */
export async function profileShow(deps: AccountCommandDeps, invocation: VerbInvocation): Promise<void> {
  const name = positional(invocation, 0, 'profile to show');
  const found = (await deps.gateway.profiles()).profiles.find(entry => entry.name === name);
  if (found === undefined) {
    throw new AccountCommandError(
      `There is no profile called "${name}". See them all with \`${deps.binaryName} profile ls\`.`,
    );
  }
  deps.out.report(flagOn(invocation.options, 'json') ? JSON.stringify(found, null, 2) : renderProfile(found));
}

/** `profile build <name> --layer <kind/name>...`: a new profile, layers oldest first. */
export async function profileBuild(deps: AccountCommandDeps, invocation: VerbInvocation): Promise<void> {
  const name = positional(invocation, 0, 'profile to build');
  await runChange(deps, {
    change: { kind: 'profile.put', name, layers: layersOf(invocation, deps.binaryName), create: true },
    destructive: false,
    options: writeFlags(invocation.options),
  });
}

/** `profile edit <name> --layer <kind/name>...`: replace the layers; every runtime on it changes. */
export async function profileEdit(deps: AccountCommandDeps, invocation: VerbInvocation): Promise<void> {
  const name = positional(invocation, 0, 'profile to edit');
  await runChange(deps, {
    change: { kind: 'profile.put', name, layers: layersOf(invocation, deps.binaryName), create: false },
    destructive: true,
    options: writeFlags(invocation.options),
  });
}

/** `profile rm <name> [--switch-runtimes-to <profile>]`. */
export async function profileRm(deps: AccountCommandDeps, invocation: VerbInvocation): Promise<void> {
  const name = positional(invocation, 0, 'profile to delete');
  const switchRuntimesTo = flagText(invocation.options, 'switch-runtimes-to');
  await runChange(deps, {
    change: {
      kind: 'profile.remove',
      name,
      ...(switchRuntimesTo === undefined ? {} : { switchRuntimesTo }),
    },
    destructive: true,
    options: writeFlags(invocation.options),
  });
}
