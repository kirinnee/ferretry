/**
 * The provider-preset catalogue a machine offers, from preset texts the caller hands in.
 *
 * The shipped preset files and the machine's own `config/endpoints/` are DATA that Logins owns and reads; this module
 * only checks a text into a {@link ProviderPreset} and orders a catalogue. Reading a text as YAML is the config
 * layer's, so it arrives as {@link ConfigText}.
 *
 * Pure.
 */
import type { ConfigText } from '../ports.ts';
import { type ProviderPreset, ProviderPresetFileSchema, presetFromFile } from './schema.ts';

/** A built-in preset that does not check: a defect in this repository, never a person's mistake. */
export class BuiltInPresetError extends Error {
  constructor(id: string, problem: string) {
    super(`built-in preset ${id} does not check: ${problem}`);
    this.name = 'BuiltInPresetError';
  }
}

/** One preset file's text, checked: the preset, or every problem in one sentence. */
export function parsePresetText(
  config: ConfigText,
  id: string,
  text: string,
  origin: ProviderPreset['origin'],
): { readonly ok: true; readonly preset: ProviderPreset } | { readonly ok: false; readonly problem: string } {
  const read = config.read(text);
  if (!read.ok) return { ok: false, problem: read.errors.map(error => error.message).join('; ') };
  const parsed = ProviderPresetFileSchema.safeParse(read.read.value);
  if (!parsed.success) {
    return {
      ok: false,
      problem: parsed.error.issues.map(issue => `${issue.path.join('.') || 'file'}: ${issue.message}`).join('; '),
    };
  }
  return { ok: true, preset: presetFromFile(id, parsed.data, origin) };
}

/** The built-in catalogue from its texts, checked. Throws {@link BuiltInPresetError} when a shipped file is broken. */
export function builtInPresets(config: ConfigText, texts: Readonly<Record<string, string>>): readonly ProviderPreset[] {
  return Object.entries(texts).map(([id, text]) => {
    const parsed = parsePresetText(config, id, text, 'built-in');
    if (!parsed.ok) throw new BuiltInPresetError(id, parsed.problem);
    return parsed.preset;
  });
}

/**
 * The catalogue a machine offers: the built-ins in their order, a file of the same id replacing a
 * built-in in its place, then the machine's own new presets by id.
 */
export function presetCatalog(
  builtIns: readonly ProviderPreset[],
  files: Readonly<Record<string, ProviderPreset>>,
): readonly ProviderPreset[] {
  const known = new Set(builtIns.map(preset => preset.id));
  return [
    ...builtIns.map(preset => files[preset.id] ?? preset),
    ...Object.entries(files)
      .filter(([id]) => !known.has(id))
      .toSorted(([left], [right]) => (left < right ? -1 : 1))
      .map(([, preset]) => preset),
  ];
}
