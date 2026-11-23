/**
 * The runtimes a machine has WITHOUT anybody making one: every login that is ready and has no runtime of its own yields
 * one, on Ferretry's default profile. It is derived at read time from the logins and the explicit files, never written:
 * nothing is migrated, and the moment the owner makes a runtime on that login (or edits the derived one, which writes it)
 * the explicit file is the only one there is.
 *
 * What "Ferretry's default profile" holds (`builtin-autonomous.ts`) is a starter model set, the "work alone well"
 * instructions and Claude's comfort settings, and NO permissions. The autonomous settings (permission mode, the Ferretry
 * tools) are the fixed layer a ferret started in `auto` mode gets (`fixed-layer.ts`, applied by the wrapper only for that
 * launch), so a derived runtime runs unattended exactly as one made by hand does, and runs as the person's own CLI from a
 * shell or for an `interactive` ferret.
 *
 * The two built-in profiles and their starter model sets are derived whether or not any login is, so a runtime saved on
 * one of them never dangles.
 *
 * An environment login (a key or endpoint of another provider) is not derived: it needs a preset the owner chooses, so it
 * is added explicitly.
 *
 * Pure: no filesystem, no clock.
 */
import type { LoginView } from '@ferretry/plugin-logins/contract';
import type { ModelSetFile, ProfileFile, RuntimeFile } from '../../../contract/index.ts';
import { builtinProfileLayers, starterModelSet } from './builtin-autonomous.ts';
import { harnessKindOfKey } from '../manifest.ts';
import { isRuntimeName } from './schema.ts';

/** What the explicit files already hold, by name. */
export interface DerivedFrom {
  readonly runtimes: ReadonlyMap<string, RuntimeFile>;
  readonly profiles: ReadonlyMap<string, ProfileFile>;
  readonly modelSets: ReadonlyMap<string, ModelSetFile>;
  readonly logins: readonly LoginView[];
}

/** What is derived, to be added beside the explicit files (an entry already there is never in here). */
export interface Derived {
  readonly runtimes: ReadonlyMap<string, RuntimeFile>;
  readonly profiles: ReadonlyMap<string, ProfileFile>;
  readonly modelSets: ReadonlyMap<string, ModelSetFile>;
}

/** The profile and model set a derived runtime of a harness uses. */
const defaultProfileName = (harness: 'claude' | 'codex'): string => `ferretry-${harness}`;

/** A login a person can start a ferret on now: signed in (or about to be refreshed), not an environment login. */
const usable = (login: LoginView): boolean => login.store !== 'environment' && login.status.word !== 'needs_sign_in';

export function deriveRuntimes(from: DerivedFrom): Derived {
  const runtimes = new Map<string, RuntimeFile>();
  const profiles = new Map<string, ProfileFile>();
  const modelSets = new Map<string, ModelSetFile>();
  // The built-in profiles and model sets are ALWAYS here (an explicit one of the same name wins), never only while a runtime is
  // derived: a runtime the owner saves from Advanced on a preset must not dangle the moment its login stops being derived.
  for (const harness of ['claude', 'codex'] as const) {
    const wanted = defaultProfileName(harness);
    if (!from.profiles.has(wanted))
      profiles.set(wanted, { contents: [...builtinProfileLayers(harness)] } as ProfileFile);
    if (!from.modelSets.has(wanted)) modelSets.set(wanted, starterModelSet(harness) as ModelSetFile);
  }
  const taken = new Set([...from.runtimes.values()].map(runtime => runtime.login as string));
  for (const login of from.logins) {
    const id = login.id as string;
    if (!usable(login) || taken.has(id) || from.runtimes.has(id) || !isRuntimeName(id)) continue;
    runtimes.set(id, { login: id, profile: defaultProfileName(harnessKindOfKey(login.harness)) } as RuntimeFile);
  }
  return { runtimes, profiles, modelSets };
}

/** The explicit entries with the derived ones beside them; an explicit entry is never replaced. */
export const withDerived = <T>(explicit: ReadonlyMap<string, T>, derived: ReadonlyMap<string, T>): Map<string, T> =>
  new Map([...derived, ...explicit]);
