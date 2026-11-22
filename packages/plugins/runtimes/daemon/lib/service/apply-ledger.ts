/**
 * The ledger of ONE setup apply: every write it makes, of every kind, as it lands (names and words only, never a value).
 *
 * The apply writes in a fixed order — keys in the secret store, logins, the owners' settings files, the settings files of
 * Runtimes' own, the fleet, then the variables of each login — and none of it rolls back with the next. So when it stops
 * part-way, for ANY reason (the request ended, a disk error, a refusal), what the person needs is the list of what
 * landed and the list of what did not, in the same words each time. This is where both lists come from; the answer, a
 * re-read of the spent change and the page all say them.
 */
import { ApiError } from '@ferretry/kernel/contract';
import { FleetCatalogFreshStepUpRequired, FleetCatalogRefusal } from './catalog-service.ts';
import { partlyAppliedSentence } from './apply-bracket.ts';

/** What the apply tells its ledger as each write lands. */
export interface WriteNotes {
  /** A key was filed in the secret store. */
  secret(name: string): void;
  /** A login was created. */
  login(id: string): void;
  /** A planned login already existed, so nothing was to be written for it. */
  existingLogin(id: string): void;
  /** The variables of a settings file were added to this login. */
  loginVariables(login: string): void;
  /** The fleet (runtimes and their files) was published. */
  fleet(): void;
}

/** The parts of a composed import the ledger plans from. */
export interface PlannedWrites {
  readonly secrets: readonly { readonly name: string }[];
  readonly newLogins?: readonly { readonly id: string }[];
  readonly configWrites?: readonly { readonly path: string }[];
  readonly owners?: { readonly writes: readonly { readonly file: string }[] };
  readonly loginEnvs?: readonly { readonly login: string }[];
}

const unique = <Item>(items: readonly Item[]): Item[] => [...new Set(items)];

export class ApplyLedger implements WriteNotes {
  readonly #secrets = new Set<string>();
  readonly #logins = new Set<string>();
  readonly #variables = new Set<string>();
  #fleet = false;
  readonly #plannedSecrets: string[];
  readonly #plannedLogins: string[];
  readonly #plannedFiles: string[];
  readonly #plannedVariables: string[];
  readonly #existing = new Set<string>();

  /** `files` is the apply's list of settings files that really landed (a held one did not): the ledger reads it live. */
  constructor(
    private readonly files: readonly string[],
    plan: PlannedWrites,
  ) {
    this.#plannedSecrets = unique(plan.secrets.map(secret => secret.name));
    this.#plannedLogins = unique((plan.newLogins ?? []).map(login => login.id));
    this.#plannedFiles = unique([
      ...(plan.owners?.writes ?? []).map(write => write.file),
      ...(plan.configWrites ?? []).map(write => write.path),
    ]);
    this.#plannedVariables = unique((plan.loginEnvs ?? []).map(env => env.login));
  }

  secret(name: string): void {
    this.#secrets.add(name);
  }
  login(id: string): void {
    this.#logins.add(id);
  }
  existingLogin(id: string): void {
    this.#existing.add(id);
  }
  loginVariables(login: string): void {
    this.#variables.add(login);
  }
  fleet(): void {
    this.#fleet = true;
  }

  /** What landed, in the order the apply writes it. */
  landed(): string[] {
    return [
      ...[...this.#secrets].map(name => `secret-store key ${name}`),
      ...[...this.#logins].map(id => `login ${id}`),
      ...unique(this.files),
      ...(this.#fleet ? ['the runtimes and fleet files'] : []),
      ...[...this.#variables].map(login => `variables of login ${login}`),
    ];
  }

  /** What the apply meant to write that has not landed (yet, or at all). */
  notLanded(): string[] {
    const files = new Set(this.files);
    return [
      ...this.#plannedSecrets.filter(name => !this.#secrets.has(name)).map(name => `secret-store key ${name}`),
      ...this.#plannedLogins.filter(id => !this.#logins.has(id) && !this.#existing.has(id)).map(id => `login ${id}`),
      ...this.#plannedFiles.filter(file => !files.has(file)),
      ...(this.#fleet ? [] : ['the runtimes and fleet files']),
      ...this.#plannedVariables
        .filter(login => !this.#variables.has(login))
        .map(login => `variables of login ${login}`),
    ];
  }
}

const stripStop = (text: string): string => text.trim().replace(/[.\s]+$/u, '');
const errorMessage = (error: unknown): string =>
  error instanceof Error && error.message.length > 0 ? error.message : String(error);

/**
 * Any failure AFTER a first write is answered with what landed and what did not (`extra.landed`, `extra.notLanded`, and
 * the same in words). The kind of failure is kept (a request that ended stays `request_aborted`, a refusal keeps its code);
 * one that was nothing a person can read (a disk error) becomes a refusal that says so, never a bare 500. A failure
 * before any write, and a step-up that asks for a passkey (nothing was written under it), are returned as they are.
 */
export function namedPartial(error: unknown, ledger: ApplyLedger): unknown {
  const landed = ledger.landed();
  if (landed.length === 0 || error instanceof FleetCatalogFreshStepUpRequired) return error;
  const notLanded = ledger.notLanded();
  const extra = { landed, notLanded };
  const said = (message: string): string => `${stripStop(message)}. ${partlyAppliedSentence(landed, notLanded)}`;
  if (error instanceof ApiError)
    return new ApiError(error.status, said(error.message), error.code, error.validationIssues, {
      ...error.extra,
      ...extra,
    });
  if (error instanceof FleetCatalogRefusal) return new FleetCatalogRefusal(error.code, said(error.message), extra);
  return new FleetCatalogRefusal('fleet_change_failed', said(errorMessage(error)), extra);
}

/**
 * Runs a setup apply's writes with its ledger and the list of settings files that really landed (a held one did not):
 * a failure of any kind after the first write is answered with both lists (`namedPartial`).
 */
export async function namingWhatLanded<T>(
  plan: PlannedWrites,
  work: (landed: string[], ledger: ApplyLedger) => Promise<T>,
): Promise<T> {
  const landed: string[] = [];
  const ledger = new ApplyLedger(landed, plan);
  try {
    return await work(landed, ledger);
  } catch (error) {
    throw namedPartial(error, ledger);
  }
}
