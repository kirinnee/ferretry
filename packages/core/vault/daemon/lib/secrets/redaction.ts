/**
 * Scrubbing known secret values out of anything this daemon is about to store or render.
 *
 * THIS IS THE PIECE THAT MAKES THE CLAIM TRUE. "A secret never appears in your transcripts" rests on
 * the daemon knowing the values and removing them; without it the promise is only "we did not put it
 * there on purpose", which is not a property anyone can rely on.
 *
 * IT FAILS CLOSED. A vault that cannot be opened means this daemon does not know what to scrub, and
 * text it cannot scrub is text it must not serve — so the failure travels to the caller, which turns
 * it into a refusal. Serving the raw text with a warning would be the leak; serving a blank would be
 * the "damaged state read as empty state" defect. A store that has simply never been written is a
 * different fact: there is nothing to mask and the text passes through unchanged.
 *
 * ONE OPEN PER READ, NOT PER STRING. Opening the vault reads the key file and the ciphertext from
 * disk, and a page of a session's journal or transcript is up to hundreds of strings. Opening it once
 * per string made one page cost hundreds of key-file reads. `batch` opens it once and hands the work
 * two pure functions over the values it opened; they are revoked when the work returns, so the
 * plaintext lives exactly as long as that one call and nothing outlives it — no cache across
 * requests and no state on this object.
 */

import { secretMask, type SecretName } from '../../../contract/index.ts';
import { mergeRanges, type TextRange } from './policy.ts';

/**
 * Where the values to mask come from: the vault, the saved logins, or both. Each opens on every call, and a
 * source that cannot open REJECTS, so the redactor fails closed rather than masking with half the values.
 */
export interface RedactionValueSource {
  values(): Promise<ReadonlyMap<string, string>>;
}

/**
 * Several stores as one source, for masking. Their names cannot collide (a saved login is keyed
 * `login:<ID>:<field>`, a shape no vault name takes), and one that rejects rejects the whole open.
 */
export function combinedValues(...sources: readonly RedactionValueSource[]): RedactionValueSource {
  return {
    values: async () => {
      const merged = new Map<string, string>();
      for (const opened of await Promise.all(sources.map(async source => await source.values())))
        for (const [name, value] of opened) merged.set(name, value);
      return merged;
    },
  };
}

/**
 * The values of one vault open, as three pure functions.
 *
 * Valid ONLY while the `batch` that handed it over is running: a scrub kept past that throws rather
 * than masking with values the daemon has since let go of. So the work given to `batch` is
 * synchronous by design — an `await` inside it would end the batch before the scrubbing after it.
 */
export interface Scrub {
  text(text: string, cut?: boolean, additional?: readonly MaskValue[]): string;
  data(value: unknown, additional?: readonly MaskValue[]): unknown;
  /** WHERE `text` holds a known value: merged ranges of UTF-16 offsets, never the value. For masking by position. */
  cover(text: string, additional?: readonly MaskValue[]): readonly TextRange[];
}

/** Daemon-only entries for one masking pass; duplicate names preserve both sides of a rotation. */
export interface MaskValue {
  readonly name: string;
  readonly value: string;
  readonly input?: true;
  readonly marker?: string;
}

export const namedMasks = (values: ReadonlyMap<string, string>): readonly MaskValue[] =>
  [...values].map(([name, value]) => ({ name, value }));

/**
 * What the operator read surface asks of redaction, expressed where that surface can depend on it
 * without depending on the secret subsystem at all.
 */
export interface TextRedactor {
  redact(text: string): Promise<string>;
  redactData(value: unknown): Promise<unknown>;
  /** Many strings under ONE vault open. A vault that cannot be opened rejects before `work` runs. */
  batch<T>(work: (scrub: Scrub) => T): Promise<T>;
}

/** The scrub of a daemon with nothing to hide. */
const IDENTITY_SCRUB = scrubValues(() => new Map());

/** A redactor for a daemon with no secret store wired: it has nothing to scrub and says so by
 *  returning its input. It exists so the read surface has one shape to depend on. */
export const NO_REDACTION: TextRedactor = {
  redact: async text => text,
  redactData: async value => value,
  batch: async work => work(IDENTITY_SCRUB),
};

/** Masks every known value. See `policy.redactSecretValues` for exactly what that does and does not
 *  catch — in particular that a value an agent deliberately transformed is not recognisable. */
export class SecretRedactor implements TextRedactor {
  constructor(private readonly vault: RedactionValueSource) {}

  async redact(text: string): Promise<string> {
    return await this.batch(scrub => scrub.text(text));
  }

  async redactData(value: unknown): Promise<unknown> {
    return await this.batch(scrub => scrub.data(value));
  }

  async batch<T>(work: (scrub: Scrub) => T): Promise<T> {
    let opened: ReadonlyMap<SecretName, string> | undefined = await this.vault.values();
    const values = (): ReadonlyMap<SecretName, string> => {
      if (opened === undefined) throw new Error('a scrub was used after the batch that opened its values ended');
      return opened;
    };
    try {
      return work(scrubValues(values));
    } finally {
      // Revoked, so a scrub that escaped its work holds nothing.
      opened = undefined;
    }
  }
}

/** One value set and one pass over ORIGINAL bytes, for vault, contributed, injected and typed values. */
export function scrubValues(values: () => ReadonlyMap<string, string>): Scrub {
  const all = (additional: readonly MaskValue[] = []): readonly MaskValue[] => [...namedMasks(values()), ...additional];
  const data = (value: unknown, entries: readonly MaskValue[]): unknown => {
    if (typeof value === 'string') return redactOutput(value, entries, false);
    if (Array.isArray(value)) return value.map(item => data(item, entries));
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [redactOutput(key, entries, false), data(item, entries)]),
      );
    return value;
  };
  return {
    text: (text, cut = false, additional) => redactOutput(text, all(additional), cut),
    data: (value, additional) => data(value, all(additional)),
    cover: (text, additional) =>
      mergeRanges(matches(text, all(additional), false).map(({ start, end }) => ({ start, end }))),
  };
}

interface Match extends TextRange {
  readonly entry: MaskValue;
}

function matches(text: string, values: readonly MaskValue[], cut: boolean): Match[] {
  const found: Match[] = [];
  const ordered = [...values].filter(entry => entry.value !== '').sort((a, b) => b.value.length - a.value.length);
  for (const entry of ordered)
    for (let at = text.indexOf(entry.value); at !== -1; at = text.indexOf(entry.value, at + 1))
      found.push({ start: at, end: at + entry.value.length, entry });
  const prefix = cut ? cutValue(text, ordered) : undefined;
  if (prefix !== undefined) found.push(prefix);
  return found.sort((a, b) => a.start - b.start || b.end - a.end);
}

/** Today's whole-value and cut-prefix rules, with their ranges collected before replacing any bytes. */
function redactOutput(text: string, values: readonly MaskValue[], cut: boolean): string {
  const found = matches(text, values, cut);
  let output = '';
  let at = 0;
  for (let index = 0; index < found.length; ) {
    const first = found[index++];
    if (first === undefined) break;
    let end = first.end;
    const run = [first];
    // Touching matches keep their own labels; overlapping matches must hide the entire union.
    for (let next = found[index]; next !== undefined && next.start < end; next = found[++index]) {
      end = Math.max(end, next.end);
      run.push(next);
    }
    const covering = run.find(match => match.start === first.start && match.end === end);
    const mixed = run.some(match => match.entry.input) && run.some(match => !match.entry.input);
    const marker =
      covering === undefined || mixed ? '[redacted]' : (covering.entry.marker ?? secretMask(covering.entry.name));
    output += text.slice(at, first.start) + marker;
    at = end;
  }
  return output + text.slice(at);
}

/**
 * Masks the BEGINNING of a value that a cut left at the very end of the text.
 *
 * A WHOLE-VALUE MATCH CANNOT SEE IT. Output is capped before it reaches redaction — and a timeout
 * kills the child mid-write — so a value straddling the cut arrives as a prefix that is not the value
 * and passes straight through, handing the reader that many characters of the credential. The cost of
 * the fix is that a truncated output whose last characters merely LOOK like the start of a value loses
 * them to a mask; on output that was already cut short that is the right side to err on.
 *
 * A byte cut can split a character, which the decoder writes as U+FFFD, so trailing replacement
 * characters are set aside before matching — otherwise one would shield the prefix in front of it.
 */
function cutValue(text: string, values: readonly MaskValue[]): Match | undefined {
  const body = text.replace(/\uFFFD+$/u, '');
  let longest: { readonly entry: MaskValue; readonly length: number } | undefined;
  for (const entry of values) {
    const { value } = entry;
    for (let length = Math.min(value.length - 1, body.length); length > (longest?.length ?? 0); length--)
      if (body.endsWith(value.slice(0, length))) {
        longest = { entry, length };
        break;
      }
  }
  return longest === undefined
    ? undefined
    : { start: body.length - longest.length, end: text.length, entry: longest.entry };
}
