/**
 * PACK MODE'S ONE FILE AS TEXT: `packs.yaml` — the switch, who decides, the limits, the probe, Jev's cap, and under
 * `routing` the one routing prompt with the `suggested` stamp of an accepted clean-up — read and edited the way Voice
 * cleanup edits `voice.yaml`: only the keys that change are rewritten, so the owner's comments and key order survive
 * (docs/config-files.md).
 *
 * A setting equal to its default is written only where the file already says something about it, so an untouched machine
 * keeps an empty `packs.yaml`. Saving the routing prompt writes `routing.prompt` and always removes `routing.suggested`:
 * saved text is the owner's words again, not the clean-up's. Saving it empty removes `prompt`, which puts the prompt
 * rendered from the model catalogs back in effect.
 *
 * Pure over the text editor it is given (`ConfigText`): text in, text out. `null` means the file does not check and cannot
 * be edited here.
 */

import {
  DEFAULT_PACK_CONFIG,
  type PackConfig,
  type PacksFile,
  PacksFileSchema,
  RoutingFileSchema,
} from '../../../contract/index.ts';
import type { ConfigText } from '../config-text.ts';

/** The modeline `packs.yaml` starts with (the editor's JSON schema, served by the daemon). */
const PACKS_MODELINE = '# yaml-language-server: $schema=schemas/packs.json';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const withoutKey = (record: Record<string, unknown>, key: string): Record<string, unknown> => {
  const { [key]: _removed, ...rest } = record;
  return rest;
};

/** A change to ask for: any setting, any part of a section. */
export interface PackConfigPatch {
  readonly enabled?: boolean;
  readonly decision?: PackConfig['decision'];
  readonly limits?: Partial<PackConfig['limits']>;
  readonly probe?: Partial<PackConfig['probe']>;
  readonly jev?: Partial<PackConfig['jev']>;
}

const SECTIONS = ['limits', 'probe', 'jev'] as const;

export interface PackFiles {
  /** What `packs.yaml` says, or `null` when it does not parse or check. */
  readPacksFile(text: string): PacksFile | null;
  /** `packs.yaml` with the change made, or `null` when the file does not check. */
  withPackConfig(text: string, patch: PackConfigPatch): string | null;
  /**
   * `packs.yaml` with the routing prompt written — trimmed — or, for `null` or blank words, with `routing.prompt` removed so
   * the default prompt applies. Either way `routing.suggested` goes: it records a clean-up accepted as drafted, and a save
   * makes the words the owner's. Every other key is left as the file has it. `null` when the file does not parse or the
   * result would not check (a prompt over the limit).
   */
  withRoutingPrompt(text: string, prompt: string | null): string | null;
}

export function packFiles(editor: ConfigText): PackFiles {
  /** The file's top-level mapping, `{}` for an empty file, `null` for one that does not parse. */
  const rawOf = (text: string): Record<string, unknown> | null => {
    const read = editor.read(text);
    if (!read.ok) return null;
    const value = read.value ?? {};
    return isRecord(value) ? value : null;
  };

  const readPacksFile = (text: string): PacksFile | null => {
    const raw = rawOf(text);
    if (raw === null) return null;
    const checked = PacksFileSchema.safeParse(raw);
    return checked.success ? checked.data : null;
  };

  const withPackConfig = (text: string, patch: PackConfigPatch): string | null => {
    const raw = rawOf(text);
    if (raw === null || readPacksFile(text) === null) return null;
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
    const edited = editor.edit(text, target, raw, PACKS_MODELINE);
    return readPacksFile(edited) === null ? null : edited;
  };

  const withRoutingPrompt = (text: string, prompt: string | null): string | null => {
    const raw = rawOf(text);
    if (raw === null) return null;
    const words = prompt?.trim() ?? '';
    const routing = isRecord(raw.routing) ? raw.routing : {};
    const owned = withoutKey(routing, 'suggested');
    const next = words === '' ? withoutKey(owned, 'prompt') : { ...owned, prompt: words };
    const target = Object.keys(next).length === 0 ? withoutKey(raw, 'routing') : { ...raw, routing: next };
    const edited = editor.edit(text, target, raw, PACKS_MODELINE);
    const back = rawOf(edited);
    const checked = back === null ? undefined : PacksFileSchema.safeParse(back);
    return checked?.success === true && RoutingFileSchema.safeParse(checked.data.routing ?? {}).success ? edited : null;
  };

  return { readPacksFile, withPackConfig, withRoutingPrompt };
}
