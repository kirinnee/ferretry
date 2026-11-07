/**
 * One config file, evaluated: what is in effect, what is wrong, and what waits for the owner (§7.2). Today's
 * `evaluateConfigFiles` without its per-file knowledge: the schema and the `loosens` judgement now come from the
 * plugin's own `defineConfig`.
 *
 * TWO RULES, in this order, for every file:
 *
 * 1. **Last good wins.** A file that does not parse, holds a raw secret or breaks its schema is reported, located,
 *    and its LAST GOOD version stays in effect — the one accepted before, kept in `state/kernel/accepted-config/`. A
 *    file never half-applies: all of it is in effect or none.
 * 2. **Loosening waits.** A valid edit for which `loosens(before, after)` names something is HELD: the tighter
 *    version stays in effect until the owner confirms the edit by its etag. Tightening applies at once. Deleting a
 *    file is an edit to its defaults, judged the same way.
 *
 * "Accepted" is the record of what was put into effect, with the text it was in effect as. A file whose etag
 * matches its accepted entry is in effect as written without a loosening check: the owner confirmed it, or the
 * daemon wrote it on the owner's behalf.
 *
 * Pure: the caller reads the file and the accepted record, and stores the next record.
 */
import type { AnyConfigDef as ConfigDef } from './claims.ts';
import { judgeLoosening } from '../../contract/define.ts';
import { addedSecretReferenceSentences } from '../secrets.ts';
import { type ConfigIssue, checkConfigText } from './check.ts';

/** What was put into effect for one file: the text, and its etag. */
export interface AcceptedConfig {
  readonly etag: string;
  readonly text: string;
}

/** The etag a file that does not exist has. */
export const ABSENT_CONFIG_ETAG = 'absent';

export type DiskState =
  | { readonly kind: 'text'; readonly text: string }
  /** A link, or larger than a configuration file may be: never read, its last good version stays. */
  | { readonly kind: 'unreadable' }
  | { readonly kind: 'absent' };

export type ConfigEntryState = 'ok' | 'invalid' | 'pending' | 'absent';

export interface EvaluatedConfig {
  readonly state: ConfigEntryState;
  /** The parsed value in effect, or `undefined` when nothing is. */
  readonly value: unknown;
  /** The text and etag in effect. */
  readonly inEffect: AcceptedConfig | undefined;
  readonly issues: readonly ConfigIssue[];
  /** Set when an edit is held: its etag (`absent` for a removal) and what it would loosen. */
  readonly held?: { readonly etag: string; readonly sentences: readonly string[] };
  /** The record to store for the next evaluation; `undefined` removes it. */
  readonly accepted: AcceptedConfig | undefined;
}

export interface EvaluateInput {
  readonly def: ConfigDef;
  /** The file, relative to `config/`. */
  readonly path: string;
  readonly disk: DiskState;
  readonly accepted: AcceptedConfig | undefined;
  /** sha256 of the text's UTF-8 bytes, hex. */
  digest(text: string): string;
  readonly binary: string;
}

interface Candidate {
  readonly value: unknown;
  readonly text: string;
  readonly etag: string;
}

/** What an empty file means, when the schema has a default for everything; `undefined` otherwise. */
export function defaultsOf(def: ConfigDef): unknown {
  const parsed = def.schema.safeParse({});
  return parsed.success ? parsed.data : undefined;
}

/** A stored accepted entry, checked again: a release that changed a schema retires an old good file. */
function acceptedCandidate(input: EvaluateInput): Candidate | undefined {
  const accepted = input.accepted;
  if (accepted === undefined) return undefined;
  const checked = checkConfigText(input.def, input.path, accepted.text, input.binary);
  return checked.ok ? { value: checked.value, text: accepted.text, etag: accepted.etag } : undefined;
}

const kept = (
  state: ConfigEntryState,
  previous: Candidate | undefined,
  issues: readonly ConfigIssue[],
  held?: EvaluatedConfig['held'],
): EvaluatedConfig => ({
  state,
  value: previous?.value,
  inEffect: previous === undefined ? undefined : { etag: previous.etag, text: previous.text },
  issues,
  accepted: previous === undefined ? undefined : { etag: previous.etag, text: previous.text },
  ...(held === undefined ? {} : { held }),
});

/** Evaluate one file. Total: every problem is an issue, never a throw. */
export function evaluateConfig(input: EvaluateInput): EvaluatedConfig {
  const previous = acceptedCandidate(input);
  const { def, path, disk } = input;

  if (disk.kind === 'unreadable') {
    return kept('invalid', previous, [
      {
        path,
        severity: 'error',
        message: 'this file is not read: it is a link, or larger than the 256 KiB a configuration file may be',
        fix: 'make it an ordinary file (a copy, not a link) of a sensible size',
      },
    ]);
  }

  if (disk.kind === 'absent') {
    if (previous === undefined)
      return { state: 'absent', value: undefined, inEffect: undefined, issues: [], accepted: undefined };
    // A file that was in effect and is gone: a deletion, which is an edit to the defaults.
    const defaults = defaultsOf(def);
    // judged even with no defaults: `after` is `undefined`, so a deletion can be a loosening (K5)
    const sentences = judgeLoosening(def, previous.value, defaults);
    if (sentences.length > 0) return kept('pending', previous, [], { etag: ABSENT_CONFIG_ETAG, sentences });
    return { state: 'absent', value: undefined, inEffect: undefined, issues: [], accepted: undefined };
  }

  const checked = checkConfigText(def, path, disk.text, input.binary);
  if (!checked.ok) return kept('invalid', previous, checked.issues);
  const etag = input.digest(disk.text);
  if (etag !== previous?.etag) {
    // A file changed on disk that nobody acknowledged (a plugin's own write, a hand edit) and that adds a secret
    // reference waits for the owner: only an owner-written reference may be resolved by `kernel.secrets` (NN2).
    const sentences = [
      ...judgeLoosening(def, previous?.value, checked.value),
      ...addedSecretReferenceSentences(previous?.value, checked.value),
    ];
    if (sentences.length > 0) return kept('pending', previous, [], { etag, sentences });
  }
  return {
    state: 'ok',
    value: checked.value,
    inEffect: { etag, text: disk.text },
    issues: [],
    accepted: { etag, text: disk.text },
  };
}
