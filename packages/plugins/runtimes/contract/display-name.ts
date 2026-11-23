/**
 * THE ONE PLACE A RUNTIME IS GIVEN A NAME A PERSON UNDERSTANDS (O9-5).
 *
 * A runtime's stored name is plumbing: a machine-made one reads `claude-you` or `claude-default`, which means nothing to
 * the owner. Every surface that names a runtime or its login calls {@link runtimeDisplayName}, so two screens cannot
 * word one runtime two ways. It is display only: the stored id, name and wrapper are never changed, and nothing is
 * migrated.
 *
 * - **A name the owner chose wins** and is shown as typed. A name is machine-made when it is its login's id (a runtime
 *   derived from a ready login) or starts with its own CLI word and nothing else (`claude-you`, `codex-default-2`).
 *   No wire field says who named a runtime, so a hand-typed `claude-work` reads as machine-made; that is the declared limit.
 * - Otherwise it is "<Harness> · <where its sign-in comes from>": the CLI the person already uses in a terminal, a
 *   sign-in made inside Ferretry, or a key or endpoint of a provider.
 * - A label the owner put on the login is appended: `Claude · your terminal sign-in (work)`.
 *
 * Pure: no filesystem, no clock.
 */
import type { HarnessKey } from '@ferretry/core-ferrets/contract';
import type { CredentialStore } from './wire/shared.ts';

// Words by harness key, read by lookup so a harness this table does not know still has a name (its own key) and no
// branch here names a harness.
/** The harness as a person says it. */
const HARNESS_WORD: Readonly<Record<string, string>> = { 'claude-code': 'Claude', codex: 'Codex' };

/** The word a machine-made runtime name starts with: the CLI's short name, not the wire harness key. */
const CLI_WORD: Readonly<Record<string, string>> = { 'claude-code': 'claude', codex: 'codex' };

/** Where a ferretry-store sign-in comes from, which is the harness maker's own account. */
const FERRETRY_SIGN_IN: Readonly<Record<string, string>> = {
  'claude-code': 'Claude.ai sign-in',
  codex: 'ChatGPT sign-in',
};

/** A harness as a person says it: "Claude", "Codex". */
export const harnessWord = (harness: HarnessKey): string => HARNESS_WORD[harness] ?? harness;

const cliWordOf = (harness: HarnessKey): string => CLI_WORD[harness] ?? harness;

/** What {@link runtimeDisplayName} reads: the fields `GET /v1/runtimes` already carries. */
export interface RuntimeNameSource {
  /** The stored name (what `--agent` takes). */
  readonly name: string;
  readonly harness: HarnessKey;
  readonly credential: {
    readonly id: string;
    readonly store: CredentialStore;
    /** The owner's own label for the login. */
    readonly label?: string | undefined;
  };
  /** The profile it starts with: the plain word that tells two runtimes on one login apart. */
  readonly profile?: string | undefined;
  /** The login's provider, when it reads a model catalog (`models.catalog.label`). */
  readonly models?: { readonly catalog: { readonly label: string } } | undefined;
}

/** Whether a stored name is one the machine made: its login's id, or its own CLI word with plain suffixes. */
export const isMachineMadeRuntimeName = (source: Pick<RuntimeNameSource, 'name' | 'harness' | 'credential'>): boolean =>
  source.name === source.credential.id ||
  new RegExp(`^${cliWordOf(source.harness)}(-[a-z0-9]+)*$`, 'u').test(source.name);

/** Where the sign-in a runtime spends comes from, in plain words. */
const signInSource = (source: RuntimeNameSource): string => {
  switch (source.credential.store) {
    case 'host':
      return 'your terminal sign-in';
    case 'ferretry':
      return FERRETRY_SIGN_IN[source.harness] ?? 'sign-in';
    case 'environment':
      return source.models?.catalog.label ?? 'API key';
  }
};

/** The words for a machine-made runtime's login, before anything tells two runtimes on one login apart. */
const baseName = (source: RuntimeNameSource): string => {
  const label = source.credential.label?.trim();
  const named = `${harnessWord(source.harness)} · ${signInSource(source)}`;
  return label === undefined || label === '' ? named : `${named} (${label})`;
};

/**
 * "Claude · your terminal sign-in", "Codex · ChatGPT sign-in", "Claude · API key", or the owner's own name.
 *
 * `others` is the machine's other runtimes, when the caller has the list (a picker, the Runtimes list). Two machine-made
 * runtimes can stand on one login (two profiles on the same sign-in) and would then read the same, so each of them also
 * says its profile (`Claude · your terminal sign-in — Fast profile`), or its stored name when the profile does not tell
 * them apart either. A caller with one runtime alone passes none.
 */
export const runtimeDisplayName = (source: RuntimeNameSource, others: readonly RuntimeNameSource[] = []): string => {
  if (!isMachineMadeRuntimeName(source)) return source.name;
  const base = baseName(source);
  const twins = others.filter(
    other => other.name !== source.name && isMachineMadeRuntimeName(other) && baseName(other) === base,
  );
  if (twins.length === 0) return base;
  const profileTellsApart = source.profile !== undefined && twins.every(twin => twin.profile !== source.profile);
  return profileTellsApart ? `${base} — ${source.profile} profile` : `${base} — ${source.name}`;
};
