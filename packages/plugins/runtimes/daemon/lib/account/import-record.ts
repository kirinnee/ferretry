/**
 * The import record as it is stored (`setup/import.json`): read back, keeping only what is usable. Pure. Split out of the
 * setup service (one feature, one file).
 */
import { supportedKinds } from '../harness-kind.ts';
import type { ImportRecord } from './import.ts';

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const strings = (value: unknown): string[] | undefined => {
  const kept = Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  return kept.length === 0 ? undefined : kept;
};

const etagsOf = (value: unknown): Record<string, string> | undefined => {
  if (!isRecord(value)) return undefined;
  const kept = Object.entries(value).filter((pair): pair is [string, string] => typeof pair[1] === 'string');
  return kept.length === 0 ? undefined : Object.fromEntries(kept);
};

/** The import record, or none when what is stored cannot be read: then nothing is ever offered as an update. */
export function parseImportRecord(text: string | undefined): ImportRecord | undefined {
  if (text === undefined) return undefined;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.components)) return undefined;
  const components: Record<
    string,
    { sources: string[]; digest: string; left?: string[]; owned?: string[]; etags?: Record<string, string> }
  > = {};
  for (const [reference, entry] of Object.entries(raw.components)) {
    if (!isRecord(entry) || typeof entry.digest !== 'string' || !Array.isArray(entry.sources)) continue;
    const left = strings(entry.left);
    const owned = strings(entry.owned);
    const etags = etagsOf(entry.etags);
    components[reference] = {
      sources: entry.sources.filter(source => typeof source === 'string'),
      digest: entry.digest,
      ...(left === undefined ? {} : { left }),
      ...(owned === undefined ? {} : { owned }),
      ...(etags === undefined ? {} : { etags }),
    };
  }
  const profiles = isRecord(raw.profiles)
    ? Object.fromEntries(
        supportedKinds().flatMap(harness => {
          const name = (raw.profiles as Readonly<Record<string, unknown>>)[harness];
          return typeof name === 'string' ? [[harness, name]] : [];
        }),
      )
    : {};
  return {
    version: 1,
    components,
    ...(typeof raw.profile === 'string' ? { profile: raw.profile } : {}),
    ...(Object.keys(profiles).length === 0 ? {} : { profiles }),
  };
}
