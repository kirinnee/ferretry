import { expect, test } from 'bun:test';
import { ConfigSecretRecipes } from '../../../../daemon/adapters/secrets/config-secret-recipes.ts';

test('the recipes and the references shown for them come from the same block, read again at each use', async () => {
  let block: Record<string, string> = { DATABASE_URL: 'postgres://app:${secret:DB_PASSWORD}@db/app' };
  const recipes = new ConfigSecretRecipes(() => block);
  expect(await recipes.read()).toEqual({ DATABASE_URL: 'postgres://app:${secret:DB_PASSWORD}@db/app' });
  expect(await recipes.references()).toEqual([
    { name: 'DB_PASSWORD', origin: expect.stringContaining('DATABASE_URL') },
  ]);

  // An edit to config/vault.yaml is the next use's block: the screen and the child cannot disagree.
  block = { TOKEN: '${secret:API_TOKEN}', PLAIN: 'no-reference' };
  expect(await recipes.read()).toEqual(block);
  expect((await recipes.references()).map(reference => reference.name)).toEqual(['API_TOKEN']);
});
