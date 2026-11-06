import {
  type AccountId,
  type AccountSummary,
  type LoginMethod,
  type SignInSummary,
  placeKeys,
  savedLoginPlaces,
} from '@ferretry/protocol';
import type { AccountDirectory, LoginDirectory } from '../../../src/lib/secrets/index.ts';

/**
 * A SAVED LOGIN AS A FIXTURE: one account and the places it signs in, written through the account store's own API.
 * Tests that need "an account with a password that signs in at github.com" say so in one call instead of two or three.
 */

/** What a fixture says about one account: its fields, where it signs in, and how the first place does. */
export interface SavedLoginFixture {
  readonly label?: string;
  readonly username?: string;
  readonly password?: string;
  /** Every place it signs in: web hosts and `program@host` terminal keys. A fixture that names it replaces the places. */
  readonly match?: readonly string[];
  readonly domains?: readonly string[];
  /** The first place's method, recipe and auto-apply. */
  readonly method?: LoginMethod;
  readonly recipe?: string;
  readonly autoApplyRecipe?: boolean;
}

const accountsOf = (directory: AccountDirectory | LoginDirectory): AccountDirectory =>
  'accounts' in directory ? directory.accounts : directory;

/** Creates the account or changes the parts named; a fixture that names `match` or `domains` replaces its places. */
export async function putSavedLogin(
  directory: AccountDirectory | LoginDirectory,
  id: string,
  fixture: SavedLoginFixture,
): Promise<void> {
  const accounts = accountsOf(directory);
  const handle = id as AccountId;
  await accounts.putAccount(handle, {
    ...(fixture.label === undefined ? {} : { label: fixture.label }),
    ...(fixture.username === undefined ? {} : { username: fixture.username }),
    ...(fixture.password === undefined ? {} : { password: fixture.password }),
  });
  const places =
    fixture.match === undefined && fixture.domains === undefined
      ? undefined
      : savedLoginPlaces(
          { match: fixture.match ?? [], ...(fixture.domains === undefined ? {} : { domains: fixture.domains }) },
          accounts.hostName,
        );
  if (places === undefined) return;
  const listing = await accounts.list();
  for (const signIn of listing.signIns.filter(each => each.account === handle)) await accounts.removeSignIn(signIn.id);
  for (const [index, place] of places.entries())
    await accounts.addSignIn(handle, {
      place,
      ...(index === 0 && fixture.method !== undefined ? { method: fixture.method } : {}),
      ...(index === 0 && fixture.recipe !== undefined ? { recipe: fixture.recipe } : {}),
      ...(index === 0 && fixture.autoApplyRecipe === true ? { autoApplyRecipe: true } : {}),
    });
}

/** One account as a test reads it back: its fields and every key it signs in at. Never a value. */
export interface SavedLoginRead extends AccountSummary {
  readonly match: readonly string[];
}

/** Every account with the keys it signs in at, by label. */
export async function savedLogins(directory: AccountDirectory | LoginDirectory): Promise<readonly SavedLoginRead[]> {
  const listing = await accountsOf(directory).list();
  const keysOf = (signIns: readonly SignInSummary[]): string[] => [
    ...new Set(
      signIns.flatMap(signIn => (signIn.place.kind === 'site' ? signIn.place.match : placeKeys(signIn.place))),
    ),
  ];
  return listing.accounts.map(account => ({
    ...account,
    match: keysOf(listing.signIns.filter(signIn => signIn.account === account.id)),
  }));
}
