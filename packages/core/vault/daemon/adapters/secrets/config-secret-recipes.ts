import { configuredReferences } from '../../lib/secrets/policy.ts';
import type { SecretReferenceSource } from '../../lib/secrets/types.ts';
import type { SecretRecipes } from '../../lib/secrets/use.ts';

/** Where the recipes come from: a function, so an edit to `config/vault.yaml` is picked up on the next use. */
export type RecipeSource = () => Readonly<Record<string, string>>;

/**
 * The operator's `secretEnvironment` block, as both of the things the domain asks for: the recipes a use child may
 * earn, and the reference list the management surface shows.
 *
 * ONE ADAPTER FOR BOTH because they must never disagree. A reference shown as unresolved in the UI and a recipe
 * silently injected anyway would be the worst of both: the screen says one thing and the child gets another.
 */
export class ConfigSecretRecipes implements SecretRecipes, SecretReferenceSource {
  constructor(private readonly source: RecipeSource) {}

  async read(): Promise<Readonly<Record<string, string>>> {
    return this.source();
  }

  async references(): Promise<readonly { readonly name: string; readonly origin: string }[]> {
    return configuredReferences(this.source());
  }
}
