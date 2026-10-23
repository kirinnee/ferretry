/**
 * PACK MODE'S TWO FILES AS TEXT: `pack.yaml` (the switch, who decides, the limits, the probe, Jev's
 * cap) and `models-guide.yaml` (the one routing prompt, and the `suggested` stamp of an accepted
 * clean-up), read and edited the way Voice cleanup edits `voice.yaml` — only the keys that change are
 * rewritten, so the owner's comments and key order survive (docs/config-files.md).
 *
 * A setting equal to its default is written only where the file already says something about it, so
 * an untouched machine keeps an empty `pack.yaml`. Saving the routing prompt writes `prompt` and always
 * removes `suggested`: saved text is the owner's words again, not the clean-up's. Saving it empty removes
 * `prompt`, which puts the prompt rendered from the model catalogs back in effect.
 *
 * Pure: text in, text out. `null` means the file does not check and cannot be edited here.
 */

import { editConfigText, readConfigText } from '@ferretry/fleet/config-text';
import {
  configSchemaModeline,
  DEFAULT_PACK_CONFIG,
  ModelsGuideFileSchema,
  type PackConfig,
  type PackFile,
  PackFileSchema,
} from '@ferretry/protocol';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const withoutKey = (record: Record<string, unknown>, key: string): Record<string, unknown> => {
  const { [key]: _removed, ...rest } = record;
  return rest;
};

/** The file's top-level mapping, `{}` for an empty file, `null` for one that does not parse. */
const rawOf = (text: string): Record<string, unknown> | null => {
  const read = readConfigText(text);
  if (!read.ok) return null;
  const value = read.read.value ?? {};
  return isRecord(value) ? value : null;
};

/** What `pack.yaml` says, or `null` when it does not parse or check. */
export function readPackFile(text: string): PackFile | null {
  const raw = rawOf(text);
  if (raw === null) return null;
  const checked = PackFileSchema.safeParse(raw);
  return checked.success ? checked.data : null;
}

/** A change to ask for: any setting, any part of a section. */
export interface PackConfigPatch {
  readonly enabled?: boolean;
  readonly decision?: PackConfig['decision'];
  readonly limits?: Partial<PackConfig['limits']>;
  readonly probe?: Partial<PackConfig['probe']>;
  readonly jev?: Partial<PackConfig['jev']>;
}

const SECTIONS = ['limits', 'probe', 'jev'] as const;

/** `pack.yaml` with the change made, or `null` when the file does not check. */
export function withPackConfig(text: string, patch: PackConfigPatch): string | null {
  const raw = rawOf(text);
  if (raw === null || readPackFile(text) === null) return null;
  let target: Record<string, unknown> = { ...raw };
  const setTop = (key: 'enabled' | 'decision', value: unknown): void => {
    if (value === undefined) return;
    if (key in raw || value !== DEFAULT_PACK_CONFIG[key]) target = { ...target, [key]: value };
  };
  setTop('enabled', patch.enabled);
  setTop('decision', patch.decision);
  for (const section of SECTIONS) {
    const change: Readonly<Record<string, unknown>> | undefined = patch[section];
    if (change === undefined) continue;
    const before = isRecord(raw[section]) ? raw[section] : {};
    const defaults: Readonly<Record<string, unknown>> = DEFAULT_PACK_CONFIG[section];
    let next: Record<string, unknown> = { ...before };
    for (const [key, value] of Object.entries(change)) {
      if (value !== undefined && (key in before || value !== defaults[key])) next = { ...next, [key]: value };
    }
    target = Object.keys(next).length === 0 ? withoutKey(target, section) : { ...target, [section]: next };
  }
  const edited = editConfigText(text, target, raw, configSchemaModeline({ kind: 'pack' }));
  return readPackFile(edited) === null ? null : edited;
}

// ── models-guide.yaml ────────────────────────────────────────────────────────────────────────────

/**
 * `models-guide.yaml` with the routing prompt written — trimmed — or, for `null` or blank words, with
 * `prompt` removed so the default prompt applies. Either way `suggested` goes: it records a clean-up
 * accepted as drafted, and a save makes the words the owner's. Every other key is left as the file has
 * it. `null` when the file does not parse or the result would not check (a prompt over the limit).
 */
export function withRoutingPrompt(text: string, prompt: string | null): string | null {
  const raw = rawOf(text);
  if (raw === null) return null;
  const words = prompt?.trim() ?? '';
  const owned = withoutKey(raw, 'suggested');
  const target = words === '' ? withoutKey(owned, 'prompt') : { ...owned, prompt: words };
  const edited = editConfigText(text, target, raw, configSchemaModeline({ kind: 'modelsGuide' }));
  const back = rawOf(edited);
  return back !== null && ModelsGuideFileSchema.safeParse(back).success ? edited : null;
}
