/** `fy plugin …` (§3.6): list and show are complete; turning on and off is checked here and written by the kernel. */
import { EXIT, ShellError } from '../errors.ts';
import { renderTable } from '../render.ts';
import type { PluginInventory } from '../world.ts';
import { skeletonSentence } from '@ferretry/kernel/contract';
import { optionOn } from '../argv.ts';
import type { RegistryEntry } from '../registry.ts';
import type { ShellContext, ShellVerb } from '../shell-context.ts';

const count = (list: readonly unknown[] | undefined): number => list?.length ?? 0;

function addsSummary(entry: RegistryEntry): string {
  const actions = entry.manifest.actions;
  const ui = entry.manifest.ui;
  const parts = [
    [count(actions?.cli), 'verb'],
    [count(actions?.routes), 'route'],
    [count(actions?.agentTools), 'tool'],
    [count(ui?.screens), 'screen'],
  ] as const;
  const named = parts.filter(([n]) => n > 0).map(([n, noun]) => `${String(n)} ${noun}${n === 1 ? '' : 's'}`);
  return named.length === 0 ? '-' : named.join(', ');
}

export function contractState(
  inventory: PluginInventory,
  compiled: Readonly<Record<string, string>>,
  id: string,
): 'same' | 'differs' | 'daemon only' | 'fy only' {
  const entry = inventory.plugins.find(candidate => candidate.id === id);
  const ours = compiled[id];
  if (entry === undefined) return 'fy only';
  if (ours === undefined) return 'daemon only';
  return entry.contract === ours ? 'same' : 'differs';
}

export const pluginList: ShellVerb = async ctx => {
  const inventory = await (await ctx.deps()).inventory.current();
  const compiled = ctx.surfaces.compiled;
  const rows: string[][] = [];
  for (const entry of ctx.world.registry.plugins) {
    const held = inventory.plugins.find(candidate => candidate.id === entry.id);
    rows.push([
      entry.id,
      entry.manifest.core ? 'core' : 'code',
      held === undefined ? '-' : held.on ? 'on' : 'off',
      entry.manifest.version,
      contractState(inventory, compiled, entry.id),
      addsSummary(entry),
      ctx.graph.dependentsOf(entry.id).join(', ') || '-',
    ]);
  }
  for (const held of inventory.plugins)
    if (compiled[held.id] === undefined)
      rows.push([held.id, 'data', held.on ? 'on' : 'off', '-', 'daemon only', '-', '-']);
  ctx.world.io.out(`${renderTable(['PLUGIN', 'KIND', 'STATE', 'VERSION', 'CONTRACT', 'ADDS', 'NEEDED BY'], rows)}\n`);
  return EXIT.ok;
};

function names(list: readonly string[] | undefined): string {
  return list === undefined || list.length === 0 ? '-' : list.join(', ');
}

export const pluginShow: ShellVerb = async ctx => {
  const id = ctx.invocation.args[0];
  if (id === undefined) throw new ShellError(`usage: ${ctx.world.identity.binary} plugin show <id>`, EXIT.usage);
  const entry = ctx.world.registry.plugins.find(candidate => candidate.id === id);
  const inventory = await (await ctx.deps()).inventory.current();
  const held = inventory.plugins.find(candidate => candidate.id === id);
  if (entry === undefined) {
    if (held === undefined)
      throw new ShellError(`no plugin "${id}" (see \`${ctx.world.identity.binary} plugin list\`)`);
    ctx.world.io.out(
      `${id}  data plugin, ${held.on ? 'on' : 'off'}\nThis fy has no copy of it; the daemon holds its manifest.\n`,
    );
    return EXIT.ok;
  }
  const manifest = entry.manifest;
  const edges = ctx.graph.edges(id);
  const lines = [
    `${manifest.title} (${id}) ${manifest.version}  ${manifest.core ? 'core' : 'code'} plugin, ${held === undefined ? 'not known to the daemon' : held.on ? 'on' : 'off'}`,
    `contract  ${contractState(inventory, ctx.surfaces.compiled, id)}`,
    `needs     ${names(edges.needs)}`,
    `uses      ${names(edges.uses)}`,
    `needed by ${names(ctx.graph.dependentsOf(id))}`,
    `adds      ${addsSummary(entry)}`,
    `verbs     ${names(manifest.actions?.cli?.map(verb => verb.verb))}`,
    `tools     ${names(manifest.actions?.agentTools?.map(tool => tool.name))}`,
    `screens   ${names(manifest.ui?.screens?.map(screen => screen.id))}`,
    `offers    ${names(manifest.hooks?.offers?.map(offer => offer.hook.name))}`,
    `takes     ${names(manifest.hooks?.takes?.map(take => take.hook.name))}`,
    `state     ${names(manifest.data?.state?.map(file => file.path))}`,
    `config    ${names(manifest.data?.config?.map(file => ('file' in file ? String(file.file) : String((file as { name?: unknown }).name))))}`,
    `reaches   roots ${names(manifest.permissions?.roots)}; network ${names(manifest.permissions?.network)}; runs ${names(manifest.permissions?.spawn)}; secrets by name ${names(manifest.permissions?.secrets)}`,
  ];
  ctx.world.io.out(`${lines.join('\n')}\n`);
  return EXIT.ok;
};

/** What `fy plugin off <id>` / `on <id>` decide before the kernel writes `config/plugins.yaml`. */
async function switchPlugin(ctx: ShellContext, to: 'on' | 'off'): Promise<number> {
  const binary = ctx.world.identity.binary;
  const id = ctx.invocation.args[0];
  if (id === undefined) throw new ShellError(`usage: ${binary} plugin ${to} <id>`, EXIT.usage);
  const entry = ctx.world.registry.plugins.find(candidate => candidate.id === id);
  if (entry === undefined) throw new ShellError(`no plugin "${id}" in this ${binary} (see \`${binary} plugin list\`)`);
  if (entry.manifest.core)
    throw new ShellError(
      `${entry.manifest.title} is a core piece; core pieces cannot be turned ${to === 'off' ? 'off' : 'on or off'}`,
    );
  const inventory = await (await ctx.deps()).inventory.current();
  const stateOf = (plugin: string): boolean | undefined => inventory.plugins.find(held => held.id === plugin)?.on;
  if (to === 'off') {
    const running = ctx.graph.dependentsOf(id).filter(plugin => stateOf(plugin) === true);
    if (running.length > 0 && !optionOn(ctx.invocation, 'with-dependents'))
      throw new ShellError(
        `${entry.manifest.title} is needed by ${running.join(', ')}; turning it off stops them too. Run \`${binary} plugin off ${id} --with-dependents\` to confirm.`,
      );
  } else {
    const off = ctx.graph.edges(id).needs.filter(plugin => stateOf(plugin) === false);
    if (off.length > 0 && !optionOn(ctx.invocation, 'with-needs'))
      throw new ShellError(
        `${entry.manifest.title} needs ${off.join(', ')}, which ${off.length === 1 ? 'is' : 'are'} off. Run \`${binary} plugin on ${id} --with-needs\` to turn them on too.`,
      );
  }
  return unwired(ctx, `turning ${entry.manifest.title} ${to}`);
}

/** The write is the kernel's (a person-only, passkey-checked config write); this daemon build serves no route for it yet. */
function unwired(ctx: ShellContext, what: string): number {
  ctx.world.io.err(`${skeletonSentence(what)}\n`);
  return EXIT.unavailable;
}

export const pluginOn: ShellVerb = ctx => switchPlugin(ctx, 'on');
export const pluginOff: ShellVerb = ctx => switchPlugin(ctx, 'off');
export const pluginInstall: ShellVerb = async ctx => unwired(ctx, 'Installing and checking data plugins');
