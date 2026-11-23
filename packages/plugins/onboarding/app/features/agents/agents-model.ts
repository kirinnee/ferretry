/**
 * "WHICH AI DO YOU WANT TO USE?" AS DATA (pure: no React, no storage, no clock, no network).
 *
 * The first page of setup asks which AI the person wants. The answer decides which harness segments the run walks (the flow marks
 * every page of an unpicked segment not needed, flow-model.ts `applyPicked`); nothing is written by choosing.
 *
 *   - The harnesses listed are the ones INSTALLED on the machine, as the daemon's registry states them (`GET /v1/onboarding`
 *     `harnesses`): nothing here names Claude Code or Codex but the one rule that Claude Code comes first and is ticked. A harness
 *     plugin that appears later is listed with no edit.
 *   - A placeholder row stays for an AI no installed harness covers yet (Google's Antigravity CLI), marked "Coming" and not pickable;
 *     it goes away the moment a harness that covers it is installed.
 *   - "Others" opens the provider list FROM THE CATALOG (`GET /v1/logins/presets`): nothing here names Kimi, GLM or DeepSeek. Each
 *     ticked provider then asks "Which harness runs it?", offering only the installed harnesses that have an offered half for it.
 *   - The answer is memory of this run (two comma lists of plugin ids) and nothing else.
 */
import { z } from 'zod';
import type { HarnessView } from '../../../contract/index.ts';

/**
 * An installed harness. Its `key` is the ONE name for it: the catalog's preset halves name a harness by its plugin id
 * (`claude-code`, `codex`; logins/contract/wire.ts), and the flow's pages belong to the plugin of that id.
 */
export type Harness = HarnessView;

/** The harness setup leads with and ticks: the one the product is built around. */
const LEADING_HARNESS = 'claude-code';

/** The installed harnesses in the order the page lists them and the run walks them: Claude Code first, the rest as the registry gave them. */
export const listedHarnesses = (installed: readonly Harness[]): readonly Harness[] => [
  ...installed.filter(harness => harness.key === LEADING_HARNESS),
  ...installed.filter(harness => harness.key !== LEADING_HARNESS),
];

/** An AI no installed harness runs yet: shown, never pickable, and hidden once a harness that covers it is installed. */
export interface ComingChoice {
  readonly id: string;
  readonly title: string;
  readonly line: string;
  readonly coming: string;
  /** The harness keys that would cover it. */
  readonly coveredBy: readonly string[];
}

const COMING_CHOICES: readonly ComingChoice[] = [
  {
    id: 'google',
    title: 'Google (Antigravity CLI)',
    line: 'Google’s Gemini models, run by Antigravity’s command-line tool.',
    coming: 'Coming',
    coveredBy: ['antigravity', 'gemini'],
  },
];

/** The placeholder rows still to show: those no installed harness covers. */
export const comingFor = (installed: readonly Harness[]): readonly ComingChoice[] =>
  COMING_CHOICES.filter(choice => !installed.some(harness => choice.coveredBy.includes(harness.key)));

/** The preset fields this page reads (the catalog row is wider; a field not named here is not used). */
const PresetRowSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  offered: z.object({ available: z.boolean() }),
  halves: z.array(z.object({ harness: z.string(), offered: z.object({ available: z.boolean() }) })),
});

export const PresetCatalogSchema = z.object({ presets: z.array(PresetRowSchema) });

/** One provider the person can pick under Others: its label and the installed harnesses that can run it. */
export interface Provider {
  readonly id: string;
  readonly label: string;
  /** Installed harness keys, in the order the run walks them. */
  readonly harnesses: readonly string[];
}

/** The providers the catalog offers that an installed harness can run, in catalog order; the rest are not shown. */
export function providersOf(
  catalog: z.infer<typeof PresetCatalogSchema>,
  installed: readonly Harness[],
): readonly Provider[] {
  const harnessKeys = listedHarnesses(installed).map(harness => harness.key);
  const seen = new Set<string>();
  const providers: Provider[] = [];
  for (const preset of catalog.presets) {
    if (!preset.offered.available || seen.has(preset.id)) continue;
    const usable = new Set(preset.halves.filter(half => half.offered.available).map(half => half.harness));
    const harnesses = harnessKeys.filter(key => usable.has(key));
    if (harnesses.length === 0) continue;
    seen.add(preset.id);
    providers.push({ id: preset.id, label: preset.label, harnesses });
  }
  return providers;
}

/** What the person ticked: the harnesses (by key), and `others` maps a ticked provider to the harness that runs it. */
export interface Pick {
  readonly ticked: readonly string[];
  readonly others: Readonly<Record<string, string>>;
}

/** What a first-time run starts with: Claude Code ticked (the first harness when it is not installed). */
export function defaultPick(installed: readonly Harness[]): Pick {
  const [first] = listedHarnesses(installed);
  return { ticked: first === undefined ? [] : [first.key], others: {} };
}

/** Ticks or unticks an installed harness. */
export const withTicked = (pick: Pick, key: string, on: boolean): Pick => ({
  ...pick,
  ticked: on
    ? pick.ticked.includes(key)
      ? pick.ticked
      : [...pick.ticked, key]
    : pick.ticked.filter(each => each !== key),
});

/** Ticks a provider with its first harness; the harness is the one the person already chose when it is still offered. */
export function withProvider(pick: Pick, provider: Provider, on: boolean): Pick {
  const others = { ...pick.others };
  if (!on) delete others[provider.id];
  else {
    const first = provider.harnesses[0];
    if (first !== undefined) others[provider.id] = first;
  }
  return { ...pick, others };
}

/** Chooses which harness runs a ticked provider (only one it offers). */
export function withHarness(pick: Pick, provider: Provider, harness: string): Pick {
  if (pick.others[provider.id] === undefined || !provider.harnesses.includes(harness)) return pick;
  return { ...pick, others: { ...pick.others, [provider.id]: harness } };
}

/** The plugin ids of the segments the pick walks (`on`) and the ones it leaves out (`off`), each in the order the run walks them. */
export interface Segments {
  readonly on: readonly string[];
  readonly off: readonly string[];
}

/** Flattens a pick into the segments it walks: installed harnesses in listed order, whether picked directly or as the harness of a provider. */
export function segmentsOf(pick: Pick, providers: readonly Provider[], installed: readonly Harness[]): Segments {
  const wanted = new Set<string>(pick.ticked);
  for (const provider of providers) {
    const harness = pick.others[provider.id];
    if (harness !== undefined && provider.harnesses.includes(harness)) wanted.add(harness);
  }
  const listed = listedHarnesses(installed);
  const on = listed.filter(harness => wanted.has(harness.key)).map(harness => harness.key);
  const off = listed.filter(harness => !wanted.has(harness.key)).map(harness => harness.key);
  return { on, off };
}

/** Whether the pick walks no harness at all: there is then nothing to set up, so Next is held (agents-page.tsx). */
export const isEmptyPick = (pick: Pick, providers: readonly Provider[], installed: readonly Harness[]): boolean =>
  segmentsOf(pick, providers, installed).on.length === 0;

/**
 * The memory patch for a pick: the segments the run walks (`agentsOn` / `agentsOff`, read back by the flow: flow-model.ts `pickedOf`)
 * and the pick itself (`agentsPick`), so Back to this page shows what was ticked instead of the default.
 */
export function memoryOfPick(
  pick: Pick,
  providers: readonly Provider[],
  installed: readonly Harness[],
): { readonly agentsOn: string; readonly agentsOff: string; readonly agentsPick: string } {
  const segments = segmentsOf(pick, providers, installed);
  return { agentsOn: segments.on.join(','), agentsOff: segments.off.join(','), agentsPick: JSON.stringify(pick) };
}

const PickSchema = z.object({ ticked: z.array(z.string()), others: z.record(z.string(), z.string()) });

/** The pick this run's memory holds, or the default when it holds none (a first visit, or a reload that dropped the memory). */
export function pickFromMemory(memory: Readonly<Record<string, unknown>>, installed: readonly Harness[]): Pick {
  const said = memory['agentsPick'];
  if (typeof said !== 'string') return defaultPick(installed);
  try {
    const parsed = PickSchema.safeParse(JSON.parse(said));
    return parsed.success ? parsed.data : defaultPick(installed);
  } catch {
    return defaultPick(installed);
  }
}

/** A harness found on this computer; `ready` when it holds a setup (settings, logins, skills) that can be brought over. */
export interface Found {
  readonly ready: boolean;
}

/** What this computer holds of a harness, as the scan read it: installed, and whether it has a setup to bring over. */
export interface HostTool {
  readonly installed: boolean;
  readonly empty: boolean;
}

/** The "found on this computer" note of each harness that is installed here, from the scan the flow started when it opened. */
export function foundOn(tools: Readonly<Record<string, HostTool>> | null): Readonly<Record<string, Found>> {
  if (tools === null) return {};
  const found: Record<string, Found> = {};
  for (const [key, tool] of Object.entries(tools)) if (tool.installed) found[key] = { ready: !tool.empty };
  return found;
}
