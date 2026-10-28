import type { TranscriptHarness } from '../types.ts';
import { HARNESS_LABEL } from './conversation.ts';
import type { RolloutFormatVerdict } from './rollout-format.ts';

/**
 * The harness versions a conversion is allowed to read from and write for.
 *
 * GATED TO WHAT WAS MEASURED, not to what probably works. Both transcript formats are undocumented,
 * and a version that renamed one field would produce a file the target CLI opens as an empty or a
 * garbled conversation — the failure this feature exists to prevent. So a version outside this table
 * is refused with the table in the sentence, and widening it is a deliberate act: record the new
 * version's transcripts, add them to the round-trip fixtures and the contract suite, then add a row.
 *
 * ONE EXCEPTION, for Codex only: it releases almost daily, and what the converter depends on is the
 * SHAPE of its rollouts, not its number. A Codex version outside the table is therefore let through when
 * the caller has measured that its rollouts keep the validated shape ({@link harnessVersionGate}'s
 * `format`): the target's by a probe run of the installed binary, the source's from its own text. A
 * different shape, or one nobody could check, is refused exactly as before.
 *
 * Measured: Claude Code 2.1.281 and 2.1.304; Codex 0.145.0, 0.156.1, 0.163.0, 0.164.0 and 0.165.0 (their
 * recorded transcripts are the fixtures under `tests/fixtures/transcript/convert/`).
 */

/** A dotted version, parsed. */
export interface HarnessVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/** One supported band: an exact major.minor, and an inclusive patch range within it. */
interface SupportedBand {
  readonly major: number;
  readonly minor: number;
  readonly patchMin: number;
  readonly patchMax: number;
  /** How the band is written in a refusal. */
  readonly label: string;
}

const SUPPORTED: Readonly<Record<TranscriptHarness, readonly SupportedBand[]>> = {
  claude: [
    { major: 2, minor: 1, patchMin: 200, patchMax: 299, label: '2.1.2xx' },
    { major: 2, minor: 1, patchMin: 300, patchMax: 399, label: '2.1.3xx' },
  ],
  codex: [
    { major: 0, minor: 145, patchMin: 0, patchMax: Number.MAX_SAFE_INTEGER, label: '0.145' },
    { major: 0, minor: 156, patchMin: 0, patchMax: Number.MAX_SAFE_INTEGER, label: '0.156' },
    { major: 0, minor: 163, patchMin: 0, patchMax: Number.MAX_SAFE_INTEGER, label: '0.163' },
    { major: 0, minor: 164, patchMin: 0, patchMax: Number.MAX_SAFE_INTEGER, label: '0.164' },
    { major: 0, minor: 165, patchMin: 0, patchMax: Number.MAX_SAFE_INTEGER, label: '0.165' },
  ],
};

/**
 * The first `major.minor.patch` in `text`, from either a bare version (`2.1.281`, as a Claude record
 * stores it) or a CLI banner (`2.1.281 (Claude Code)`, `codex-cli 0.156.1`). A pre-release suffix is
 * ignored: `0.163.0-alpha.4` is a 0.163 build.
 */
export function parseHarnessVersion(text: string): HarnessVersion | undefined {
  const match = /(\d{1,6})\.(\d{1,6})\.(\d{1,6})/u.exec(text);
  if (match === null) return undefined;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

const supportedList = (harness: TranscriptHarness): string => SUPPORTED[harness].map(band => band.label).join(', ');

/** The newest band a harness was measured on: what an unrecognised version's format is compared with. */
const newestBand = (harness: TranscriptHarness): string =>
  SUPPORTED[harness].reduce((newest, band) => (band.minor > newest.minor ? band : newest)).label;

/** The band-table verdict alone: why `version` is outside what was measured, or `undefined` when it is inside. */
function bandRefusal(harness: TranscriptHarness, version: string | undefined, role: 'source' | 'target') {
  const label = HARNESS_LABEL[harness];
  const tested = `the converter is tested only on ${label} ${supportedList(harness)}`;
  const parsed = version === undefined ? undefined : parseHarnessVersion(version);
  if (parsed === undefined)
    return {
      parsed,
      reason:
        role === 'source'
          ? `This conversation doesn't record which ${label} version wrote it, and ${tested}, so it can't be converted safely.`
          : `Ferretry couldn't tell which ${label} version this machine runs, and ${tested}, so it won't write a conversation for it.`,
    };
  const supported = SUPPORTED[harness].some(
    band =>
      band.major === parsed.major &&
      band.minor === parsed.minor &&
      parsed.patch >= band.patchMin &&
      parsed.patch <= band.patchMax,
  );
  if (supported) return undefined;
  const written = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  return {
    parsed,
    reason:
      role === 'source'
        ? `This conversation was written by ${label} ${written}, and ${tested}, so it can't be converted safely.`
        : `This machine runs ${label} ${written}, and ${tested}, so Ferretry won't write a conversation it hasn't seen that version accept.`,
  };
}

/** How a version fares at the gate. */
export type VersionGate =
  | { readonly kind: 'supported' }
  /** Not a measured version, but its rollouts keep the validated shape. `note` says so, for the person. */
  | { readonly kind: 'by-format'; readonly note: string }
  | { readonly kind: 'refused'; readonly reason: string };

/**
 * Whether `version` of `harness` can take part in a conversion, and why not when it cannot.
 *
 * `role` says which side it is on, because the remedy differs: a source transcript written by an
 * untested version cannot be fixed by the person, while a target CLI can be upgraded or pinned.
 *
 * `format` is asked only for a Codex version outside the table, and only when its number parses: it
 * answers whether that version's rollouts keep the validated shape. Leaving it out is the strict gate.
 */
export function harnessVersionGate(
  harness: TranscriptHarness,
  version: string | undefined,
  role: 'source' | 'target',
  format?: () => RolloutFormatVerdict | undefined,
): VersionGate {
  const refusal = bandRefusal(harness, version, role);
  if (refusal === undefined) return { kind: 'supported' };
  const verdict = harness === 'codex' && refusal.parsed !== undefined ? format?.() : undefined;
  if (verdict === undefined) return { kind: 'refused', reason: refusal.reason };
  const label = HARNESS_LABEL[harness];
  const validated = newestBand(harness);
  if (verdict.kind === 'same')
    return {
      kind: 'by-format',
      note:
        `${label} ${refusal.parsed?.major}.${refusal.parsed?.minor}.${refusal.parsed?.patch} isn't one of the versions the converter was tested on; ` +
        `the conversation format it ${role === 'source' ? 'wrote' : 'writes'} is unchanged from the one validated on ${label} ${validated}.`,
    };
  return {
    kind: 'refused',
    reason:
      verdict.kind === 'different'
        ? `${refusal.reason} The conversation format it ${role === 'source' ? 'wrote' : 'writes'} also differs from the one validated on ${label} ${validated}: ${verdict.reason}.`
        : `${refusal.reason} Ferretry also couldn't check the conversation format it writes: ${verdict.reason}.`,
  };
}

/** Why `version` of `harness` cannot take part in a conversion by its number alone, or `undefined` when it can. */
export function harnessVersionRefusal(
  harness: TranscriptHarness,
  version: string | undefined,
  role: 'source' | 'target',
): string | undefined {
  return bandRefusal(harness, version, role)?.reason;
}
