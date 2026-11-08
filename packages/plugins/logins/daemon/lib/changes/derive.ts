/**
 * What a person may ask of ONE login, and the file each ask means (today's `credential.*` account changes).
 *
 * A caller names one intent; this derives the `config/logins/<id>.yaml` edit it stands for from the logins in effect,
 * so the change is reviewable: "add this login" has one meaning and one derivation, where a whole-document
 * replacement can differ from what was previewed in ways nobody reads. The candidate is checked against the same
 * schema and cross-field rules a file on disk is, last.
 *
 * Sign-out is not an edit (it runs the harness's own logout) and is handled by the service. Pure.
 */
import { secretReferencesIn } from '@ferretry/core-vault/contract';
import { LOGIN_NAME, LoginFileSchema, type LoginChange, type LoginFile } from '../../../contract/index.ts';
import { credentialIssues, credentialOf, type Credential } from '../shared/credential.ts';
import { credentialHarnesses, credentialVariables, hasHalves } from '../shared/halves.ts';
import { type HarnessKind, harnessKey } from '../shared/harness.ts';
import { looksLikeRawSecret, looksSecret, urlCarries } from '../../../contract/secret-shape.ts';
import { credentialFromPreset, presetLoginRefusal } from '../presets/login.ts';
import type { ProviderPreset } from '../presets/schema.ts';

/** A refusal the caller can act on, rather than a schema violation or a daemon defect. */
export class LoginChangeRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoginChangeRefusal';
  }
}
const refuse = (message: string): never => {
  throw new LoginChangeRefusal(message);
};

/** The harness names a sentence uses. */
const HARNESS_WORDS: Readonly<Record<HarnessKind, string>> = { claude: 'Claude Code', codex: 'Codex' };

/** One file an edit writes: the changed top-level keys (`undefined` removes a key), or the file removed. */
type LoginWrite =
  | { readonly id: string; readonly patch: Readonly<Record<string, unknown>> }
  | { readonly id: string; readonly remove: true };

/** The edit a change stands for, and what the person approving it is told. */
export interface LoginEdit {
  readonly writes: readonly LoginWrite[];
  readonly summary: string;
  readonly consequences: readonly string[];
  /** A removed login's secret NAMES that nothing else refers to now: left in the store, said aloud. */
  readonly orphanedSecrets: readonly string[];
}

/** What a derivation needs to know that is not in the files. */
export interface LoginChangeFacts {
  readonly machineName: string;
  readonly presets: readonly ProviderPreset[];
  /** The runtimes on each login, by name, when known. */
  readonly usedBy: (id: string) => readonly string[];
}

const ENVIRONMENT_CONSEQUENCE =
  'Runtimes on it launch with these variables. A secret is put in from the secret store at launch and never written anywhere.';

/** C10: a runtime on a login would have nothing to launch with if it were removed. Today's sentence, word for word. */
export const inUseSentence = (users: readonly string[]): string =>
  `${String(users.length)} runtime${users.length === 1 ? '' : 's'} still ${users.length === 1 ? 'uses' : 'use'} this login (${users.join(', ')}). Move ${users.length === 1 ? 'it' : 'them'} to another login first.`;

/**
 * A login removal is NEVER held for the owner. Removing a login that has a budget lifts that budget, which the kernel
 * holds for a caller it governs; a held removal would leave the login in effect and be put through later by a path
 * that does not ask what uses it. So the removal is made with `refuseIfHeld`: whoever the kernel lets lift a budget
 * (the owner, or a confirmed step-up) removes the login in one step, and a caller it would hold is refused with this
 * sentence naming both steps. The refusal is the kernel's answer at apply, never a second copy of its rule here.
 */
export const BUDGET_FIRST_SENTENCE =
  'This login has a budget, so it was not removed: first drop its budget (you confirm that), then remove the login.';

/** A removal needs to know nothing uses the login; when that cannot be known it does not go ahead. */
export const USERS_UNKNOWN_SENTENCE = 'Ferretry cannot check what uses this login right now, so it was not removed.';

const listed = (names: readonly string[]): string => names.join(', ');
const counted = (count: number, noun: string): string => `${String(count)} ${noun}${count === 1 ? '' : 's'}`;

const freeName = (name: string, taken: (candidate: string) => boolean): string => {
  for (let n = 2; ; n += 1) if (!taken(`${name}-${String(n)}`)) return `${name}-${String(n)}`;
};

function assertNoRawSecrets(env: Readonly<Record<string, string>>, owner: string): void {
  for (const [name, value] of Object.entries(env)) {
    if (looksSecret(name, value) || looksLikeRawSecret(name, value)) {
      refuse(
        `${name} in ${owner} looks like a secret, and a secret never sits in a login file. Save it in this machine's secret store and write \${secret:NAME} here instead.`,
      );
    }
    if (urlCarries(value) === 'userinfo') {
      refuse(
        `${name} in ${owner} is an address with a user and password in it, and a secret never sits in a login file. Write the address without them and keep the password in this machine's secret store.`,
      );
    }
  }
}

/** A label two logins of one harness may not share (C9, E26). */
function assertLabelFree(
  files: ReadonlyMap<string, LoginFile>,
  id: string,
  harness: HarnessKind,
  label: string | undefined,
): void {
  if (label === undefined) return;
  for (const [other, file] of files) {
    if (other !== id && credentialOf(file).harness === harness && file.label === label) {
      refuse(`another ${HARNESS_WORDS[harness]} login is already labelled ${label}; pick a different label`);
    }
  }
}

/** The secret names only login `id` refers to: removing it leaves them in the store, unused. */
function orphanedSecretsOf(files: ReadonlyMap<string, LoginFile>, id: string): readonly string[] {
  const namesOf = (file: LoginFile): readonly string[] =>
    Object.values(credentialVariables(credentialOf(file))).flatMap(value => secretReferencesIn(value).map(String));
  const elsewhere = new Set([...files].filter(([other]) => other !== id).flatMap(([, file]) => namesOf(file)));
  const own = files.get(id);
  return own === undefined ? [] : [...new Set(namesOf(own))].filter(name => !elsewhere.has(name)).toSorted();
}

const present = (value: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));

/** The candidate file, proven by the file schema and the cross-field rules, or a refusal naming the field. */
function checked(id: string, candidate: Record<string, unknown>): void {
  const parsed = LoginFileSchema.safeParse(candidate);
  if (!parsed.success) {
    refuse(
      `login ${id} would not be a valid login: ${parsed.error.issues.map(issue => `${issue.path.join('.') || 'file'}: ${issue.message}`).join('; ')}`,
    );
  }
  const issues = parsed.success ? credentialIssues(credentialOf(parsed.data)) : [];
  if (issues.length > 0) refuse(`login ${id} would not be a valid login: ${issues.join('; ')}`);
}

function lowered(credential: Credential): Record<string, unknown> {
  return present({ ...credential, harness: harnessKey(credential.harness) });
}

function addLogin(
  files: ReadonlyMap<string, LoginFile>,
  change: Extract<LoginChange, { kind: 'login.add' }>,
  facts: LoginChangeFacts,
): LoginEdit {
  const taken = (candidate: string): boolean => files.has(candidate);
  if (!LOGIN_NAME.test(change.id) || change.id.length > 64) {
    refuse(`Use only lowercase letters, digits and dashes. Use ${freeName('login', taken)}?`);
  }
  if (taken(change.id)) {
    refuse(`${change.id} is already a login on ${facts.machineName}. Use ${freeName(change.id, taken)}?`);
  }
  const harness: HarnessKind = change.harness === 'claude-code' ? 'claude' : 'codex';
  assertLabelFree(files, change.id, harness, change.label);
  const store = change.store ?? 'ferretry';
  const consequences: string[] = [];
  let candidate: Record<string, unknown>;
  let summary: string;
  if (store === 'environment') {
    const env = change.env ?? {};
    assertNoRawSecrets(env, `login ${change.id}`);
    if (change.preset === undefined) {
      candidate = present({
        harness: change.harness,
        store,
        label: change.label,
        env: Object.keys(env).length === 0 ? undefined : { ...env },
        cloudCredential: change.cloudCredential,
      });
      consequences.push(ENVIRONMENT_CONSEQUENCE);
      summary = `Add a ${HARNESS_WORDS[harness]} login ${change.id} from its environment`;
    } else {
      const preset = facts.presets.find(candidateId => candidateId.id === change.preset);
      if (preset === undefined) return refuse(`there is no preset ${change.preset} on ${facts.machineName}`);
      const input = {
        env,
        harness,
        ...(change.cloudCredential === undefined ? {} : { cloudCredential: change.cloudCredential }),
        ...(change.label === undefined ? {} : { label: change.label }),
      };
      const refusal = presetLoginRefusal(preset, input);
      if (refusal !== undefined) refuse(refusal);
      const credential = credentialFromPreset(preset, input);
      candidate = lowered(credential);
      const harnesses = credentialHarnesses(credential);
      consequences.push(ENVIRONMENT_CONSEQUENCE);
      if (harnesses.length > 1) {
        consequences.push(
          `One login, one secret: runtimes on it can run ${harnesses.map(name => HARNESS_WORDS[name]).join(' or ')}.`,
        );
      }
      summary = `Add a ${harnesses.map(name => HARNESS_WORDS[name]).join(' + ')} login ${change.id} from ${preset.label}`;
    }
  } else {
    if (change.preset !== undefined || change.env !== undefined || change.cloudCredential !== undefined) {
      refuse('a preset, variables and a cloud credential belong only to an environment login');
    }
    if (store === 'host') {
      // One pointer at the person's own login is all there is to point at: the import reuses it.
      const existing = [...files].find(
        ([, file]) => credentialOf(file).harness === harness && file.store === 'host',
      )?.[0];
      if (existing !== undefined)
        refuse(`${existing} is already your own ${HARNESS_WORDS[harness]} login on this machine`);
    }
    candidate = present({ harness: change.harness, store, label: change.label });
    if (store === 'host') {
      consequences.push(
        `It is your own ${HARNESS_WORDS[harness]} login, shared with ${harness === 'claude' ? 'claude' : 'codex'} in your terminal: signing in here signs that in too.`,
      );
      summary = `Add your own ${HARNESS_WORDS[harness]} login as ${change.id}`;
    } else {
      consequences.push('It starts as an empty login that needs sign-in.');
      summary = `Add a ${HARNESS_WORDS[harness]} login ${change.id}`;
    }
  }
  checked(change.id, candidate);
  return { writes: [{ id: change.id, patch: candidate }], summary, consequences, orphanedSecrets: [] };
}

/** The environment an edit asks for, with every "keep" resolved against what the login has. */
function resolvedEnv(
  input: Readonly<Record<string, string | { readonly keep: true }>>,
  existing: Readonly<Record<string, string>>,
  owner: string,
): Record<string, string> {
  assertNoRawSecrets(
    Object.fromEntries(Object.entries(input).filter(([, value]) => typeof value === 'string')) as Record<
      string,
      string
    >,
    owner,
  );
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    if (typeof value === 'string') {
      env[name] = value;
      continue;
    }
    const kept = existing[name];
    if (kept === undefined) refuse(`${owner} has no value for ${name} to keep; type one`);
    env[name] = kept as string;
  }
  return env;
}

/** A two-CLI login's variables, put back where each belongs. */
interface SplitVariables {
  readonly shared: Record<string, string>;
  readonly claude?: Record<string, string>;
  readonly codex?: Record<string, string>;
}

/**
 * A login with halves, its edited variables put back: a name it shares stays shared, a name a half sets stays in that
 * half (in both, when both set it), a new name goes to the half its preset declares it in, and anything else is shared
 * by both.
 */
function splitHalves(
  credential: Credential,
  preset: ProviderPreset | undefined,
  env: Readonly<Record<string, string>>,
): SplitVariables {
  const harnesses = credentialHarnesses(credential);
  const halves: Partial<Record<HarnessKind, Record<string, string>>> = Object.fromEntries(
    harnesses.map(harness => [harness, {}]),
  );
  const shared: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    const owners = harnesses.filter(harness => credential[harness]?.env?.[name] !== undefined);
    const declared = harnesses.filter(harness => preset?.halves[harness]?.env[name] !== undefined);
    const into = credential.env?.[name] !== undefined ? [] : owners.length > 0 ? owners : declared;
    if (into.length === 0) shared[name] = value;
    for (const harness of into) (halves[harness] as Record<string, string>)[name] = value;
  }
  return { shared, ...halves };
}

/** `login.env`: an environment login's variables and cloud credential reference, changed (today's `credential.env`). */
function changeEnvironment(
  file: LoginFile,
  change: Extract<LoginChange, { kind: 'login.env' }>,
  facts: LoginChangeFacts,
): LoginEdit {
  const credential = credentialOf(file);
  if (credential.store !== 'environment') {
    refuse(`login ${change.id} is signed in, not made from environment variables — it has no variables to change`);
  }
  const owner = `login ${change.id}`;
  // A login that drives both CLIs is edited as one set of variables and put back half by half.
  const env = resolvedEnv(change.env, credentialVariables(credential), owner);
  const cloudCredential =
    change.cloudCredential === undefined ? credential.cloudCredential : (change.cloudCredential ?? undefined);
  const preset =
    credential.preset === undefined ? undefined : facts.presets.find(candidate => candidate.id === credential.preset);
  const harnesses = credentialHarnesses(credential);
  if (preset !== undefined) {
    const refusal = presetLoginRefusal(preset, {
      env,
      halves: harnesses,
      ...(cloudCredential === undefined ? {} : { cloudCredential }),
    });
    if (refusal !== undefined) refuse(refusal);
  }
  const split = hasHalves(credential) ? splitHalves(credential, preset, env) : { shared: env };
  const patch: Record<string, unknown> = {
    env: Object.keys(split.shared).length === 0 ? undefined : split.shared,
    cloudCredential,
  };
  for (const harness of harnesses) {
    const half = split[harness];
    if (half === undefined) continue;
    const written = { ...credential[harness] } as Record<string, unknown>;
    if (Object.keys(half).length === 0) delete written.env;
    else written.env = half;
    patch[harness === 'claude' ? 'claude' : 'codex'] = written;
  }
  const users = facts.usedBy(change.id);
  const candidate: Record<string, unknown> = { ...lowered(credential) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete candidate[key];
    else candidate[key] = value;
  }
  checked(change.id, candidate);
  return {
    writes: [{ id: change.id, patch }],
    summary: `Change the variables of login ${change.id}`,
    consequences: [
      users.length === 0
        ? ENVIRONMENT_CONSEQUENCE
        : `${listed(users)} ${users.length === 1 ? 'starts' : 'start'} with the new variables next launch. Running sessions keep the old ones until restarted.`,
    ],
    orphanedSecrets: [],
  };
}

/** Derive the edit one change stands for from the logins in effect. Signing out is not an edit: see the service. */
export function deriveLoginChange(
  files: ReadonlyMap<string, LoginFile>,
  change: Exclude<LoginChange, { kind: 'login.signout' }>,
  facts: LoginChangeFacts,
): LoginEdit {
  if (change.kind === 'login.add') return addLogin(files, change, facts);
  const file = files.get(change.id);
  if (file === undefined) return refuse(`no login ${change.id} exists on this machine`);
  switch (change.kind) {
    case 'login.env':
      return changeEnvironment(file, change, facts);
    case 'login.label': {
      if (change.label !== null) assertLabelFree(files, change.id, credentialOf(file).harness, change.label);
      return {
        writes: [{ id: change.id, patch: { label: change.label ?? undefined } }],
        summary:
          change.label === null
            ? `Remove the label from login ${change.id}`
            : `Label login ${change.id} ${change.label}`,
        consequences: [],
        orphanedSecrets: [],
      };
    }
    case 'login.disable': {
      const disabled = present({ reason: change.reason, until: change.until });
      return {
        writes: [{ id: change.id, patch: { disabled } }],
        summary: `Disable login ${change.id}`,
        consequences: [
          'Nothing running is stopped: ferrets already on this login keep going. New starts on it are refused.',
        ],
        orphanedSecrets: [],
      };
    }
    case 'login.enable':
      return {
        writes: [{ id: change.id, patch: { disabled: undefined } }],
        summary: `Enable login ${change.id}`,
        consequences: [],
        orphanedSecrets: [],
      };
    case 'login.remove': {
      const users = facts.usedBy(change.id);
      // C10: a runtime on it would have nothing to launch with.
      if (users.length > 0) refuse(inUseSentence(users));
      const consequences: string[] = [];
      const credential = credentialOf(file);
      if (file.store === 'host') {
        consequences.push(
          `Your own ${credential.harness} in your terminal keeps its login; Ferretry only stops using it.`,
        );
      } else if (file.store === 'ferretry') {
        consequences.push(
          'Its saved sign-in stays on this machine. To delete it, sign the login out before removing it.',
        );
      }
      const orphaned = orphanedSecretsOf(files, change.id);
      if (orphaned.length > 0) {
        consequences.push(
          `${counted(orphaned.length, 'saved secret')} (${listed(orphaned)}) ${orphaned.length === 1 ? 'is' : 'are'} used by nothing else now, and ${orphaned.length === 1 ? 'stays' : 'stay'} in the secret store until you delete ${orphaned.length === 1 ? 'it' : 'them'} there.`,
        );
      }
      return {
        writes: [{ id: change.id, remove: true }],
        summary: `Remove login ${change.id}`,
        consequences,
        orphanedSecrets: orphaned,
      };
    }
  }
}
