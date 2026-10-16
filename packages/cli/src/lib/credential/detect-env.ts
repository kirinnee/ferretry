/**
 * Detecting a provider for `fy login add --from-env` and a bare `fy login add --env …`
 * (docs/provider-presets.md § Detect) against the catalogue's own clues, through the fleet package's
 * pure `detectProvider`. Never a value: variable NAMES and the preset's own host text only.
 *
 * Pure.
 */
import type { DetectablePreset, DetectionClue, ProviderDetection } from '@ferretry/fleet';
import type { FleetProviderPresetCatalog, FleetProviderPresetView } from '@ferretry/protocol';

/** The catalogue's presets that declare detection clues, in catalogue order. */
export function detectionTable(catalog: FleetProviderPresetCatalog): readonly DetectablePreset[] {
  return catalog.presets.flatMap(preset =>
    preset.detect === undefined ? [] : [{ id: preset.id, detect: preset.detect }],
  );
}

/** A shell environment's `string | undefined` values, narrowed to the ones actually set. */
export function definedEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) if (value !== undefined) result[name] = value;
  return result;
}

const clueText = (clue: DetectionClue): string =>
  clue.kind === 'host' ? `${clue.variable} (${clue.host})` : clue.variable;

/**
 * What detection found, in one sentence a person can trust was never a value: a provider it is
 * confident of and what pointed there, or a custom gateway with the variable names it recognised.
 */
export function detectionSentence(preset: FleetProviderPresetView | undefined, detection: ProviderDetection): string {
  if (preset === undefined) {
    return detection.recognised.length === 0
      ? 'Detected a custom gateway: nothing recognisable.'
      : `Detected a custom gateway: ${detection.recognised.join(', ')}.`;
  }
  return `Detected ${preset.label} from ${detection.clues.map(clueText).join(', ')}.`;
}
