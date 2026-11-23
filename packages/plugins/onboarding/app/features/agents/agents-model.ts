/**
 * "WHICH AI DO YOU WANT TO USE?" AS DATA (pure: no React, no storage, no clock, no network).
 *
 * The first page of setup asks which AI the person wants. The answer decides which harness segments the run walks (the flow marks
 * every page of an unpicked segment not needed, flow-model.ts `applyPicked`); nothing is written by choosing.
 *
 *   - Claude (ticked first) and Codex are the two harnesses Ferretry runs today. Gemini is shown, marked "coming", and cannot be picked
 *     until a Gemini harness exists.
 *   - "Others" opens the provider list FROM THE CATALOG (`GET /v1/logins/presets`): nothing here names Kimi, GLM or DeepSeek. Each
 *     ticked provider then asks "Which harness runs it?", offering only the supported harnesses that have an offered half for it.
 *   - The answer is memory of this run (two comma lists of plugin ids) and nothing else.
 */
import { z } from 'zod';

/**
 * A harness this build can run. Its `plugin` id is the ONE name for it: the catalog's preset halves name a harness by its plugin
 * id (`claude-code`, `codex`; logins/contract/wire.ts `KnownHarnessKeySchema`), and the flow's pages belong to the plugin of that id.
 */
export interface SupportedHarness {
  readonly plugin: string;
  readonly label: string;
}

/** Every harness a setup segment exists for, in the order the run walks them (Claude, then Codex). */
export const SUPPORTED_HARNESSES: readonly SupportedHarness[] = [
  { plugin: 'claude-code', label: 'Claude Code' },
  { plugin: 'codex', label: 'Codex' },
];

/** The first-party AIs the page lists by name. Gemini has no harness yet, so it is shown and cannot be picked. */
export interface AiChoice {
  readonly id: 'claude' | 'codex' | 'gemini';
  readonly title: string;
  readonly line: string;
  /** The supported harness that runs it (its plugin id); absent when none does yet. */
  readonly harness?: string;
  /** Why it cannot be picked; absent when it can. */
  readonly coming?: string;
}

export const AI_CHOICES: readonly AiChoice[] = [
  { id: 'claude', title: 'Claude', line: 'Anthropic’s Claude, run by Claude Code.', harness: 'claude-code' },
  { id: 'codex', title: 'Codex', line: 'OpenAI’s Codex.', harness: 'codex' },
  { id: 'gemini', title: 'Gemini', line: 'Google’s Gemini.', coming: 'Coming' },
];

/** The preset fields this page reads (the catalog row is wider; a field not named here is not used). */
const PresetRowSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  offered: z.object({ available: z.boolean() }),
  halves: z.array(z.object({ harness: z.string(), offered: z.object({ available: z.boolean() }) })),
});

export const PresetCatalogSchema = z.object({ presets: z.array(PresetRowSchema) });

/** One provider the person can pick under Others: its label and the supported harnesses that can run it. */
export interface Provider {
  readonly id: string;
  readonly label: string;
  /** Supported harness keys, in the order the run walks them. */
  readonly harnesses: readonly string[];
}

const harnessKeys = SUPPORTED_HARNESSES.map(harness => harness.plugin);

/** The providers the catalog offers that a supported harness can run, in catalog order; the rest are not shown. */
export function providersOf(catalog: z.infer<typeof PresetCatalogSchema>): readonly Provider[] {
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

/** What the person ticked. `others` maps a ticked provider to the harness that runs it. */
export interface Pick {
  readonly claude: boolean;
  readonly codex: boolean;
  readonly others: Readonly<Record<string, string>>;
}

/** What a first-time run starts with: Claude ticked. */
export const DEFAULT_PICK: Pick = { claude: true, codex: false, others: {} };

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

/** Flattens a pick into the segments it walks: Claude, then Codex, whether picked directly or as the harness of a provider. */
export function segmentsOf(pick: Pick, providers: readonly Provider[]): Segments {
  const wanted = new Set<string>();
  if (pick.claude) wanted.add('claude-code');
  if (pick.codex) wanted.add('codex');
  for (const provider of providers) {
    const harness = pick.others[provider.id];
    if (harness !== undefined && provider.harnesses.includes(harness)) wanted.add(harness);
  }
  const on = SUPPORTED_HARNESSES.filter(harness => wanted.has(harness.plugin)).map(harness => harness.plugin);
  const off = SUPPORTED_HARNESSES.filter(harness => !wanted.has(harness.plugin)).map(harness => harness.plugin);
  return { on, off };
}

/** Whether the pick walks no harness at all: there is then nothing to set up, so Next is held (agents-page.tsx). */
export const isEmptyPick = (pick: Pick, providers: readonly Provider[]): boolean =>
  segmentsOf(pick, providers).on.length === 0;

/**
 * The memory patch for a pick: the segments the run walks (`agentsOn` / `agentsOff`, read back by the flow: flow-model.ts `pickedOf`)
 * and the pick itself (`agentsPick`), so Back to this page shows what was ticked instead of the default.
 */
export function memoryOfPick(
  pick: Pick,
  providers: readonly Provider[],
): { readonly agentsOn: string; readonly agentsOff: string; readonly agentsPick: string } {
  const segments = segmentsOf(pick, providers);
  return { agentsOn: segments.on.join(','), agentsOff: segments.off.join(','), agentsPick: JSON.stringify(pick) };
}

const PickSchema = z.object({
  claude: z.boolean(),
  codex: z.boolean(),
  others: z.record(z.string(), z.string()),
});

/** The pick this run's memory holds, or the default when it holds none (a first visit, or a reload that dropped the memory). */
export function pickFromMemory(memory: Readonly<Record<string, unknown>>): Pick {
  const said = memory['agentsPick'];
  if (typeof said !== 'string') return DEFAULT_PICK;
  try {
    const parsed = PickSchema.safeParse(JSON.parse(said));
    return parsed.success ? parsed.data : DEFAULT_PICK;
  } catch {
    return DEFAULT_PICK;
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
  for (const choice of AI_CHOICES) {
    const tool = choice.harness === undefined ? undefined : tools[choice.harness];
    if (tool?.installed === true) found[choice.id] = { ready: !tool.empty };
  }
  return found;
}
