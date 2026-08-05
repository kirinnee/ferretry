import { configuredReferences, type SecretRecipes, type SecretReferenceSource } from '../../lib/index.ts';

/** Where the recipes come from. A function rather than a document, so an operator's edit to
 *  `config/daemon.json` is picked up on the next use instead of at the next restart. */
export type RecipeSource = () => Promise<Readonly<Record<string, string>>>;

/**
 * The operator's `secretEnvironment` block, as both of the things the domain asks for: the recipes a
 * use child may earn, and the reference list the management surface shows.
 *
 * ONE ADAPTER FOR BOTH because they must never disagree. A reference shown as unresolved in the UI
 * and a recipe silently injected anyway would be the worst of both — the screen says one thing and
 * the child gets another.
 */
export class ConfigSecretRecipes implements SecretRecipes, SecretReferenceSource {
  constructor(private readonly source: RecipeSource) {}

  async read(): Promise<Readonly<Record<string, string>>> {
    return await this.source();
  }

  async references(): Promise<readonly { readonly name: string; readonly origin: string }[]> {
    return configuredReferences(await this.source());
  }
}
