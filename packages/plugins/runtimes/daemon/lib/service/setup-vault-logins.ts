import { type ExecutorCaller, type FleetCatalogServiceDeps } from './catalog-service.ts';
import { createLogins, type LoginEnvPlan } from './setup-login-env.ts';
import { assertMayFileSecrets, fileSecrets, type FiledSecret } from './setup-secrets.ts';

/**
 * The import's first owner writes: the Vault, then the logins it plans.
 *
 * A request that has ended stops the apply BEFORE its next owner write (each `live()`): what landed stays.
 */
export async function writeVaultAndLogins(
  deps: {
    readonly put: (name: string, value: string) => Promise<void>;
    readonly catalog: Pick<FleetCatalogServiceDeps, 'credentials' | 'loginChanges'>;
  },
  composed: LoginEnvPlan & { readonly secrets: readonly FiledSecret[] },
  caller: ExecutorCaller | undefined,
): Promise<void> {
  // The Vault is written first: the caller's right to write it is settled before the first write.
  assertMayFileSecrets(composed.secrets, caller, 'apply');
  caller?.live?.();
  await fileSecrets(deps.put, composed.secrets, () => caller?.live?.());
  caller?.live?.();
  await createLogins(deps.catalog, composed, () => caller?.live?.());
  caller?.live?.();
}

/** Tells the caller what a finished owner hand-over or settings write left waiting or refused (structured, never parsed). */
export function reportLeft(caller: ExecutorCaller | undefined, held: number, refused: number): void {
  if (held > 0) caller?.left?.('held');
  if (refused > 0) caller?.left?.('refused');
}
