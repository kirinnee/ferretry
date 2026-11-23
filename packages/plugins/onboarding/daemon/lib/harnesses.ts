import type { FerretsApi } from '@ferretry/core-ferrets/contract';
import type { HarnessView } from '../../contract/index.ts';

/**
 * The harnesses installed on this machine, as the registry lists them (`FerretsApi.harnesses`), each with the name its own
 * facts give (`harnessFacts`). Nothing here names a harness: a third plugin appears with no edit. A key whose facts the registry
 * cannot give is left out (it cannot be named to a person), and Ferrets off is none.
 */
export function installedHarnesses(
  ferrets: Pick<FerretsApi, 'harnesses' | 'harnessFacts'> | undefined,
): readonly HarnessView[] {
  if (ferrets === undefined) return [];
  try {
    return ferrets.harnesses().flatMap(key => {
      const label = ferrets.harnessFacts(key)?.displayName;
      return label === undefined ? [] : [{ key, label }];
    });
  } catch {
    return [];
  }
}
