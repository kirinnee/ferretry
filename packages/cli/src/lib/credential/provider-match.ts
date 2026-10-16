/**
 * Resolving a word typed at `fy login add <provider>` against the preset catalogue
 * (docs/provider-presets.md): the preset's own id exactly, else an alias — one of the id's
 * dash-separated segments, or a word of its label — case-insensitively. A loose word that names more
 * than one preset picks the first in catalogue order and says which others also matched.
 *
 * Reads the WIRE catalogue (`FleetProviderPresetView`) the daemon sends, never the fleet package's own
 * internal preset shape, which this process never holds.
 *
 * Pure.
 */
import type { FleetCredentialAct, FleetProviderPresetView } from '@ferretry/protocol';
import type { AccountHarness } from '../fleet/account-ports.ts';
import { HARNESS_LABEL } from '../fleet/account-render.ts';

const HARNESS_ORDER: readonly AccountHarness[] = ['claude', 'codex'];

/** One half of a preset, whichever shape the catalogue sent it in. */
interface PresetHalfView {
  readonly harness: AccountHarness;
  readonly offered: FleetCredentialAct;
  readonly docs?: string;
  readonly models: readonly string[];
}

/**
 * A preset's halves. A daemon that predates halves sends only the legacy top-level `harness` (and
 * `offered`), which reads as that one CLI's half.
 */
function presetHalves(preset: FleetProviderPresetView): readonly PresetHalfView[] {
  if (preset.halves !== undefined) return preset.halves;
  return [{ harness: preset.harness, offered: preset.offered, docs: preset.docs, models: preset.models }];
}

/** The CLIs a login made from `preset` can drive right now, Claude Code before Codex. */
export function offeredHarnesses(preset: FleetProviderPresetView): readonly AccountHarness[] {
  const halves = presetHalves(preset);
  return HARNESS_ORDER.filter(harness => halves.some(half => half.harness === harness && half.offered.available));
}

/** One matched preset, and every other preset a loose word also matched (catalogue order). */
export interface PresetMatch {
  readonly preset: FleetProviderPresetView;
  readonly alsoMatched: readonly string[];
}

/** A label's words, lower case: "Kimi / Moonshot" → ["kimi", "moonshot"]. */
const labelWords = (label: string): readonly string[] =>
  label
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(word => word.length > 0);

/** Whether `word` names `preset` by an alias: one of its id's own segments, or a word of its label. */
function matchesAlias(preset: FleetProviderPresetView, word: string): boolean {
  if (preset.id.toLowerCase().split('-').includes(word)) return true;
  return labelWords(preset.label).includes(word);
}

/**
 * The preset `word` names: its own id, exactly, first; otherwise the first preset in catalogue order
 * whose id or label carries it as a word, with every other preset that also matched. `undefined` when
 * nothing in the catalogue matches at all.
 */
export function matchPresetWord(presets: readonly FleetProviderPresetView[], word: string): PresetMatch | undefined {
  const needle = word.trim().toLowerCase();
  const exact = presets.find(preset => preset.id.toLowerCase() === needle);
  if (exact !== undefined) return { preset: exact, alsoMatched: [] };
  const [winner, ...rest] = presets.filter(preset => matchesAlias(preset, needle));
  return winner === undefined ? undefined : { preset: winner, alsoMatched: rest.map(entry => entry.id) };
}

/** Why a login from `preset` cannot be made at all, said once, or `undefined` when it can. */
export function presetOfferedRefusal(preset: FleetProviderPresetView): string | undefined {
  return preset.offered.available ? undefined : `${preset.label} is not offered here: ${preset.offered.reason}`;
}

/** The CLI listed first for `credential.add`, or why a named `--for` CLI cannot be used. */
export function resolveAddHarness(
  preset: FleetProviderPresetView,
  forHarness: AccountHarness | undefined,
): { readonly harness: AccountHarness } | { readonly refusal: string } {
  if (forHarness !== undefined) {
    const half = presetHalves(preset).find(entry => entry.harness === forHarness);
    const label = HARNESS_LABEL[forHarness];
    if (half === undefined) return { refusal: `${preset.label} has no half for ${label}` };
    if (!half.offered.available) return { refusal: `${preset.label} does not drive ${label}: ${half.offered.reason}` };
    return { harness: forHarness };
  }
  const [first] = offeredHarnesses(preset);
  return first === undefined
    ? { refusal: presetOfferedRefusal(preset) ?? `${preset.label} drives no CLI here.` }
    : { harness: first };
}

const SCOPE_WORD: Record<AccountHarness, string> = { claude: 'Claude', codex: 'Codex' };

/** The scope chip `fy login presets` shows: "Claude + Codex", "Claude only", "Codex only", or "not offered". */
export function presetScopeChip(preset: FleetProviderPresetView): string {
  const offered = offeredHarnesses(preset);
  if (offered.length === 2) return `${SCOPE_WORD.claude} + ${SCOPE_WORD.codex}`;
  const [only] = offered;
  return only === undefined ? 'not offered' : `${SCOPE_WORD[only]} only`;
}

/** The sentence a one-click add prints: "drives Claude Code + Codex", from the preset's offered halves. */
export function presetDriveSentence(preset: FleetProviderPresetView): string {
  return `drives ${offeredHarnesses(preset)
    .map(harness => HARNESS_LABEL[harness])
    .join(' + ')}`;
}
