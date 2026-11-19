/**
 * Puts an imported harness environment onto a login's own file (r9 A8).
 *
 * Logins owns `config/logins/<id>.yaml`, so the import hands the variables here and Logins writes its own file through the
 * kernel's config service: the schema check, the refusal of a raw secret and the hold on a loosening all still apply.
 *
 * - **Who asks is checked here, live.** The caller's `fleet.configure` is asked at the write, and `secrets.configure` too
 *   when a Vault reference is bound. A reference is then held for the owner by the config layer, as for any other editor.
 * - **It adds only.** A variable the login already has is kept. The write is NOT a read-modify-replace of the whole `env`:
 *   the file's etag is read FIRST and passed as `ifMatch`, so the write lands only when the disk is still what this read, and
 *   a login with an edit held for the owner is refused (a held-only key is never dropped, and a held key is never replaced).
 * - **Nothing here reads a secret or moves one.** A minted variable is a secret NAME Runtimes filed create-only; this
 *   writes the reference to it.
 */
import { cap } from '@ferretry/core-gate/contract';
import { secretReferencesIn } from '@ferretry/core-vault/contract';
import type { ConfigWriteOutcome } from '@ferretry/kernel/contract';
import type { LoginFile } from '../../../contract/index.ts';
import {
  GITHUB_TOKEN_NAMES,
  type LoginEnvCaller,
  type LoginEnvImportApi,
  type LoginEnvImportOutcome,
  type LoginEnvImportRequest,
} from '../../../contract/env-import.ts';
import { nameLooksLikeKey } from '../../../contract/secret-shape.ts';
import { MASKED_NAME, planLoginEnv, shownName } from './env-plan.ts';

/** One look at a login file's disk: its etag and where it stands, read before the version in effect is. */
export interface LoginFileLook {
  readonly etag: string;
  readonly state: 'absent' | 'valid' | 'invalid' | 'held';
}

export interface LoginEnvImportDeps {
  /** The login files in effect, read live. */
  readonly files: () => ReadonlyMap<string, LoginFile>;
  /** The disk etag and state of one login file now (`ConfigPort.etag` and `fileState`). */
  readonly look: (id: string) => Promise<LoginFileLook>;
  /** Writes keys of one login's own file, only if the disk still has `ifMatch` (`ConfigPort.writeAsCaller` over Logins' own def). */
  readonly write: (
    id: string,
    patch: Readonly<Record<string, unknown>>,
    ifMatch: string,
  ) => Promise<ConfigWriteOutcome>;
}

/** The names a login's own file already sets, across its shared block and each harness half. */
const setNames = (file: LoginFile): ReadonlySet<string> =>
  new Set([
    ...Object.keys(file.env ?? {}),
    ...Object.keys(file.claude?.env ?? {}),
    ...Object.keys(file.codex?.env ?? {}),
  ]);

/** Why this caller may not do `axis` right now, in words, or `undefined` when it may. */
function standingRefusal(caller: LoginEnvCaller, capability: 'fleet' | 'secrets'): string | undefined {
  const what = capability === 'fleet' ? 'change a login' : 'add a secret reference to a login';
  if (caller.governance === undefined) {
    return `this daemon could not check whether this caller may ${what}, so nothing was changed`;
  }
  const decision = caller.governance.decide(cap(capability, 'configure'));
  if (decision.allowed) return undefined;
  return decision.refusal === 'step-up-required'
    ? `to ${what} from this device, unlock this machine with your passkey and import again`
    : `this device may not ${what}`;
}

export class LoginEnvImport implements LoginEnvImportApi {
  constructor(private readonly deps: LoginEnvImportDeps) {}

  async import(request: LoginEnvImportRequest): Promise<LoginEnvImportOutcome> {
    // Asked first so that nobody without standing learns which logins exist, and asked again at the write (below).
    const early = standingRefusal(request.caller, 'fleet');
    if (early !== undefined) return { outcome: 'refused', reason: early };
    // The disk is looked at BEFORE the version in effect, so a write that carries this etag can only land on what was read.
    const look = await this.deps.look(request.login);
    const file = this.deps.files().get(request.login);
    if (file === undefined) return { outcome: 'refused', reason: `there is no login named ${request.login}` };
    if (file.harness !== request.harness) {
      return { outcome: 'refused', reason: `the login ${request.login} is not a ${request.harness} login` };
    }
    const ticked = new Set((request.ticked ?? []).filter(name => GITHUB_TOKEN_NAMES.includes(name.toUpperCase())));
    const plan = planLoginEnv(request.plain, request.minted, ticked);
    const had = setNames(file);
    const kept = Object.keys(plan.env).filter(name => had.has(name));
    const added = Object.keys(plan.env).filter(name => !had.has(name));
    if (added.length === 0) return { outcome: 'unchanged', kept: kept.map(shownName), skipped: plan.skipped };
    if (look.state !== 'valid') {
      return {
        outcome: 'refused',
        reason:
          look.state === 'held'
            ? `the login ${request.login} has a change waiting for the owner to confirm; confirm or discard it, then import again`
            : `the login file ${request.login} is not in a state to add to (${look.state})`,
      };
    }
    const env = { ...file.env, ...Object.fromEntries(added.map(name => [name, plan.env[name] as string])) };
    // The caller's standing is asked LAST, after every awaited read, immediately before the write: a grant revoked or
    // narrowed while the file was read is what is judged. A reference is bound only when an ADDED variable is one.
    const fleet = standingRefusal(request.caller, 'fleet');
    if (fleet !== undefined) return { outcome: 'refused', reason: fleet };
    if (added.some(name => secretReferencesIn(plan.env[name] as string).length > 0)) {
      const secrets = standingRefusal(request.caller, 'secrets');
      if (secrets !== undefined) return { outcome: 'refused', reason: secrets };
    }
    const answer = await this.deps.write(request.login, { env }, look.etag);
    if (answer.kind === 'refused') {
      // The config layer names a key and a rule, never a value; this masks the values and key-shaped names it was given all the same.
      const first = masked(answer.issues[0]?.message, Object.keys(plan.env), Object.values(plan.env));
      return {
        outcome: 'refused',
        reason: first === undefined ? 'the login file was refused' : `the login file was refused: ${first}`,
      };
    }
    if (answer.kind === 'conflict') {
      return { outcome: 'refused', reason: `the login ${request.login} changed while this was written; import again` };
    }
    return {
      outcome: answer.kind === 'held' ? 'held' : 'written',
      added: added.map(shownName),
      kept: kept.map(shownName),
      skipped: plan.skipped,
      sentences: answer.kind === 'held' ? answer.sentences : [],
    };
  }
}

/** `text` with every value in `values` and every key-shaped name in `names` hidden, and cut short. */
const masked = (text: string | undefined, names: readonly string[], values: readonly string[]): string | undefined => {
  if (text === undefined) return undefined;
  const hidden = names.filter(nameLooksLikeKey).reduce((rest, name) => rest.split(name).join(MASKED_NAME), text);
  const clean = values.filter(value => value.length > 0).reduce((rest, value) => rest.split(value).join('***'), hidden);
  return clean.length > 200 ? `${clean.slice(0, 200)}…` : clean;
};

/**
 * The port as every plugin but the setup import is handed it: it refuses, and writes nothing. The provider (not a manifest line
 * alone) is what scopes it, because a plugin that declares `needs` for it would otherwise hold a door into every login's file.
 */
export const refusedEnvImport: LoginEnvImportApi = {
  import: async () => ({
    outcome: 'refused',
    reason: "only the setup import may add to a login's environment",
  }),
};
