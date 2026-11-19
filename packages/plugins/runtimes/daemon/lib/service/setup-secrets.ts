/**
 * What the setup import does with the keys it found: who may file them in the Vault, one create per name, and an honest
 * answer when a later create fails. The Vault write itself is create-only (`putNewOver`); this is the caller's side of it.
 */
import { cap, type CallerGovernance } from '@ferretry/core-gate/contract';
import { type ExecutorCaller, FleetCatalogRefusal } from './catalog-service.ts';

/** One key to file: its NAME and the value the daemon re-read from the host file. The value never leaves this path. */
export interface FiledSecret {
  readonly name: string;
  readonly value: string;
}

/**
 * Why this caller may not add secrets to the Vault, in words, or `undefined` when it may (or only needs a passkey the preview
 * does not ask for yet). `fleet.configure` on the route does not stand in for `secrets.configure`; no standing fails closed.
 */
function secretsRefusal(governance: CallerGovernance | undefined, stage: 'describe' | 'apply'): string | undefined {
  if (governance === undefined)
    return 'this daemon could not check whether this caller may add secrets, which is a daemon bug (update it: fy daemon update)';
  const decision = governance.decide(cap('secrets', 'configure'));
  if (decision.allowed) return undefined;
  if (decision.refusal === 'step-up-required')
    return stage === 'describe'
      ? undefined
      : 'adding secrets from this device needs a passkey confirmation; unlock this machine and apply again';
  return 'this device may not add secrets to the secret store, so the keys found in your Claude Code or Codex settings cannot be imported from it';
}

/** Throws, before anything is written, when there are keys to file and this caller may not file them. */
export function assertMayFileSecrets(
  secrets: readonly FiledSecret[],
  caller: ExecutorCaller | undefined,
  stage: 'describe' | 'apply',
): void {
  if (secrets.length === 0) return;
  const why = secretsRefusal(caller?.governance, stage);
  if (why !== undefined) throw new FleetCatalogRefusal('fleet_change_refused', `${why}; nothing was changed`);
}

/**
 * One entry per NAME: a key shared by several parts, or by a new part and an accepted update, is planned once under one name
 * (the planner hands a name out once per value), and a second create of it would answer `exists`.
 */
export const uniqueByName = <Secret extends FiledSecret>(secrets: readonly Secret[]): Secret[] => [
  ...new Map(secrets.map(secret => [secret.name, secret] as const)).values(),
];

/** Files each key, in order. A failure says exactly which names were already added (they stay) and that nothing else changed. */
export async function fileSecrets(
  put: (name: string, value: string) => Promise<void>,
  secrets: readonly FiledSecret[],
): Promise<void> {
  const created: string[] = [];
  for (const secret of secrets) {
    try {
      await put(secret.name, secret.value);
      created.push(secret.name);
    } catch (error) {
      const why = error instanceof Error && error.message.length > 0 ? error.message : String(error);
      throw new FleetCatalogRefusal(
        'fleet_change_failed',
        created.length === 0
          ? `the secret store could not take ${secret.name}, so nothing was changed: ${why}`
          : `the secret store could not take ${secret.name}: ${why}. Already added to the secret store and kept: ${created.join(', ')}. Nothing else was changed.`,
      );
    }
  }
}

/**
 * Which held names an earlier import already filed with exactly the value this scan found again, as name -> that value. The
 * COMPARISON is the Vault's (`filedSame`: one boolean, true only for an entry this plugin's own create filed and nobody replaced
 * since); no value comes back and nothing here is a digest. `found` is a scan planned against an EMPTY store, so each name is the
 * one the import wants; the held names to ask about are that name's own family (`NAME`, `NAME_2`, ...). Without `filedSame`, or
 * when it fails, nothing is reused and the import files under the next free name, as before.
 */
export async function reusableSecrets(
  found: readonly FiledSecret[],
  held: readonly string[],
  filedSame: ((name: string, value: string) => Promise<boolean>) | undefined,
): Promise<Map<string, string>> {
  const reusable = new Map<string, string>();
  if (filedSame === undefined) return reusable;
  for (const secret of found) {
    const stem = secret.name.replace(/_\d+$/u, '');
    for (const name of held) {
      if (name !== stem && !name.startsWith(`${stem}_`)) continue;
      if (await filedSame(name, secret.value).catch(() => false)) reusable.set(name, secret.value);
    }
  }
  return reusable;
}

/** What the answer says about the keys: the names it filed and the names it reused. Names only, never a value. */
export const secretSentences = (filed: readonly string[], reused: readonly string[]): string[] => [
  ...(filed.length === 0 ? [] : [`Filed in the secret store: ${filed.join(', ')}.`]),
  ...(reused.length === 0 ? [] : [`Reused from an earlier import: ${reused.join(', ')}.`]),
];
