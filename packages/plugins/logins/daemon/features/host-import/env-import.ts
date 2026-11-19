/**
 * Puts an imported harness environment onto a login's own file (r9 A8).
 *
 * Logins owns `config/logins/<id>.yaml`, so the import hands the variables here and Logins writes its own file through the
 * kernel's config service: the schema check, the refusal of a raw secret and the hold on a loosening all still apply. It
 * adds only: a variable the login already has is kept as it is, so an import never replaces what a person set.
 *
 * Nothing here reads a secret or moves one. By now each secret-looking value is a `${secret:NAME}` reference to a key
 * Runtimes filed in the Vault, create-only; this writes the reference.
 */
import type { ConfigWriteOutcome } from '@ferretry/kernel/contract';
import type { LoginFile } from '../../../contract/index.ts';
import {
  GITHUB_TOKEN_NAMES,
  type LoginEnvImportApi,
  type LoginEnvImportOutcome,
  type LoginEnvImportRequest,
} from '../../../contract/env-import.ts';
import { planLoginEnv } from './env-plan.ts';

export interface LoginEnvImportDeps {
  /** The login files in effect, read live. */
  readonly files: () => ReadonlyMap<string, LoginFile>;
  /** Writes keys of one login's own file (`ConfigPort.writeAsCaller` over Logins' own def: the person's act). */
  readonly write: (id: string, patch: Readonly<Record<string, unknown>>) => Promise<ConfigWriteOutcome>;
}

/** The names a login's own file already sets, across its shared block and each harness half. */
const setNames = (file: LoginFile): ReadonlySet<string> =>
  new Set([
    ...Object.keys(file.env ?? {}),
    ...Object.keys(file.claude?.env ?? {}),
    ...Object.keys(file.codex?.env ?? {}),
  ]);

export class LoginEnvImport implements LoginEnvImportApi {
  constructor(private readonly deps: LoginEnvImportDeps) {}

  async import(request: LoginEnvImportRequest): Promise<LoginEnvImportOutcome> {
    const file = this.deps.files().get(request.login);
    if (file === undefined) return { outcome: 'refused', reason: `there is no login named ${request.login}` };
    if (file.harness !== request.harness) {
      return { outcome: 'refused', reason: `the login ${request.login} is not a ${request.harness} login` };
    }
    const ticked = new Set((request.ticked ?? []).filter(name => GITHUB_TOKEN_NAMES.includes(name.toUpperCase())));
    const plan = planLoginEnv(request.env, ticked);
    const had = setNames(file);
    const kept = Object.keys(plan.env).filter(name => had.has(name));
    const added = Object.keys(plan.env).filter(name => !had.has(name));
    if (added.length === 0) return { outcome: 'unchanged', kept, skipped: plan.skipped };
    const env = { ...file.env, ...Object.fromEntries(added.map(name => [name, plan.env[name] as string])) };
    const answer = await this.deps.write(request.login, { env });
    if (answer.kind === 'refused') {
      // The config layer names a key and a rule, never a value; this masks the values it was given all the same.
      const first = masked(answer.issues[0]?.message, Object.values(plan.env));
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
      added,
      kept,
      skipped: plan.skipped,
      sentences: answer.kind === 'held' ? answer.sentences : [],
    };
  }
}

/** `text` with every value in `values` hidden, and cut short. */
const masked = (text: string | undefined, values: readonly string[]): string | undefined => {
  if (text === undefined) return undefined;
  const clean = values.filter(value => value.length > 0).reduce((rest, value) => rest.split(value).join('***'), text);
  return clean.length > 200 ? `${clean.slice(0, 200)}…` : clean;
};
