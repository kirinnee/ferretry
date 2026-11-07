import type { VerbInvocation } from '@ferretry/kernel/manifest';
import type { ComponentCatalog, ComponentInput, ComponentView } from '../../../contract/index.ts';
import { ComponentInputSchema } from '../../../contract/index.ts';
import { runChange } from '../fleet/account-change.ts';
import { flagList, flagOn, flagText, positional, writeFlags } from '../fleet/account-commands.ts';
import { type AccountCommandDeps, AccountCommandError } from '../fleet/account-ports.ts';
import { indent, listOrNone, unavailable } from '../fleet/account-render.ts';

/**
 * Model sets are the one kind of component with verbs of their own now: instructions, MCP servers, skills,
 * settings and hooks live with the plugins that own them, and a model set is what a runtime's profile picks its
 * models from. The wire is unchanged: a model set is the `modelSets` component, named `modelSets/<name>`.
 */

const KIND = 'modelSets' as const;

/** The model sets in a catalogue, in the order the daemon listed them. */
const modelSetsOf = (catalog: ComponentCatalog): readonly ComponentView[] =>
  catalog.kinds.find(group => group.kind === KIND)?.components ?? [];

/** One model set by name, or a refusal naming the list command. */
async function findModelSet(deps: AccountCommandDeps, name: string): Promise<ComponentView> {
  const found = modelSetsOf(await deps.gateway.components()).find(entry => entry.name === name);
  if (found === undefined) {
    throw new AccountCommandError(
      `There is no model set called "${name}". See them all with \`${deps.binaryName} model-set ls\`.`,
    );
  }
  return found;
}

/** What a model set holds. */
const detailLines = (component: ComponentView): string[] =>
  component.detail.kind === KIND
    ? [`Models: ${component.detail.models.join(', ')}`, `Starts with: ${component.detail.default}`]
    : [];

/** One model set in full. */
export function renderModelSet(component: ComponentView): string {
  const removal = unavailable(component.remove);
  return [
    component.reference,
    ...indent([
      ...detailLines(component),
      ...component.warnings.map(warning => `Note: ${warning}`),
      `Used by profiles: ${listOrNone(component.usedBy.profiles)}`,
      `Used by runtimes: ${listOrNone(component.usedBy.runtimes)}`,
      component.editNote,
      ...(removal === undefined ? [] : [`Cannot remove yet: ${removal}`]),
    ]),
  ].join('\n');
}

/** The model sets on this machine, one line each. */
export function renderModelSetList(components: readonly ComponentView[], binaryName: string): string {
  if (components.length === 0) {
    return `No model sets yet. Add one with \`${binaryName} model-set add <name> --model <id>\`.`;
  }
  const lines = components.map(component => {
    const notes = component.warnings.length > 0 ? `  · ${component.warnings.length} note(s)` : '';
    return `${component.name}  ${listOrNone(component.detail.kind === KIND ? component.detail.models : [])}  used by ${component.usedBy.profiles.length} profile(s)${notes}`;
  });
  return [...lines, '', `Show one with \`${binaryName} model-set show <name>\`.`].join('\n');
}

/**
 * The model set's fields from the flags, falling back to what it already has on an edit.
 *
 * Parsed through the shared schema, so a missing field is refused here in words rather than as a daemon error.
 */
export function modelSetInput(invocation: VerbInvocation, current: ComponentView | undefined): ComponentInput {
  const was = current?.detail.kind === KIND ? current.detail : undefined;
  const given = flagList(invocation.options, 'model');
  const models = given.length > 0 ? given : was === undefined ? [] : [...was.models];
  const startsWith = flagText(invocation.options, 'default') ?? was?.default ?? models[0];
  const parsed = ComponentInputSchema.safeParse({ kind: KIND, models, default: startsWith });
  if (!parsed.success || !models.includes(startsWith as string)) {
    throw new AccountCommandError('A model set needs at least one --model <id>, and --default must be one of them.');
  }
  return parsed.data;
}

/** `model-set ls`. */
export async function modelSetLs(deps: AccountCommandDeps, invocation: VerbInvocation): Promise<void> {
  const catalog = await deps.gateway.components();
  const sets = modelSetsOf(catalog);
  deps.out.report(
    flagOn(invocation.options, 'json')
      ? JSON.stringify({ ...catalog, kinds: catalog.kinds.filter(group => group.kind === KIND) }, null, 2)
      : renderModelSetList(sets, deps.binaryName),
  );
}

/** `model-set show <name>`. */
export async function modelSetShow(deps: AccountCommandDeps, invocation: VerbInvocation): Promise<void> {
  const found = await findModelSet(deps, positional(invocation, 0, 'model set to show'));
  deps.out.report(flagOn(invocation.options, 'json') ? JSON.stringify(found, null, 2) : renderModelSet(found));
}

/** `model-set add <name> --model <id>... [--default <id>]`. */
export async function modelSetAdd(deps: AccountCommandDeps, invocation: VerbInvocation): Promise<void> {
  const name = positional(invocation, 0, 'model set to add');
  await runChange(deps, {
    change: { kind: 'component.put', name, component: modelSetInput(invocation, undefined), create: true },
    destructive: false,
    options: writeFlags(invocation.options),
  });
}

/** `model-set edit <name> [--model <id>...] [--default <id>]`: every profile and runtime that uses it changes too. */
export async function modelSetEdit(deps: AccountCommandDeps, invocation: VerbInvocation): Promise<void> {
  const name = positional(invocation, 0, 'model set to change');
  const current = modelSetsOf(await deps.gateway.components()).find(entry => entry.name === name);
  if (current === undefined) {
    throw new AccountCommandError(
      `There is no model set ${name} to change. Add it with \`${deps.binaryName} model-set add ${name}\`.`,
    );
  }
  await runChange(deps, {
    change: { kind: 'component.put', name, component: modelSetInput(invocation, current), create: false },
    destructive: true,
    options: writeFlags(invocation.options),
  });
}

/** `model-set rm <name> [--remove-from-profiles]`: refused while a profile uses it, unless told to take it out first. */
export async function modelSetRm(deps: AccountCommandDeps, invocation: VerbInvocation): Promise<void> {
  const name = positional(invocation, 0, 'model set to remove');
  await runChange(deps, {
    change: {
      kind: 'component.remove',
      componentKind: KIND,
      name,
      ...(flagOn(invocation.options, 'remove-from-profiles') ? { removeFromProfiles: true } : {}),
    },
    destructive: true,
    options: writeFlags(invocation.options),
  });
}
