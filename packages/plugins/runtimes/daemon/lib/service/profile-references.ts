import { secretReferencesIn } from '@ferretry/core-vault/contract';
import type { RuntimeHome } from '../../../contract/index.ts';

/**
 * The secret NAMES `runtime`'s profile binds to its environment: the `${secret:NAME}` references in its home's
 * published `secretEnv`, deduped. Names only, never a value; none for a runtime no home lists or one that binds none.
 */
export function profileSecretNames(homes: readonly RuntimeHome[], runtime: string): readonly string[] {
  const home = homes.find(candidate => candidate.runtimes.some(name => name === runtime));
  return [...new Set(Object.values(home?.secretEnv ?? {}).flatMap(value => secretReferencesIn(value)))];
}
