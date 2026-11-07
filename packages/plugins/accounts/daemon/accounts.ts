/**
 * HALF A of Accounts' daemon (rebuild unit accounts-a): accounts, sign-ins, saved logins and 2FA keys. It builds the
 * account store over the kernel's state port and the Vault's sealed store, and answers the `/v1/accounts` routes, the
 * `account_hint` tool and the `accounts` port. Half b (rules, plans, recipes, phone approval, secure copy) is
 * `./rules.ts`, built after this one and handed {@link AccountsCore}.
 */
import { ApiError, type StateFileDef } from '@ferretry/kernel/contract';
import type { DaemonContext, ToolHandler } from '@ferretry/kernel/manifest';
import { z } from 'zod';
import { type AccountsApi, type AccountsConfig, AccountsConfigSchema, type PlaceKey } from '../contract/index.ts';
import type manifest from '../manifest.ts';
import { accountHintSummary, placeHosts } from '../contract/routes/index.ts';
import { machineName } from './adapters/host.ts';
import { StateAccountIndexStore } from './adapters/state-account-index-store.ts';
import { UNBUILT_CIPHER, UNBUILT_SEALED_STORE } from './adapters/unbuilt-seal.ts';
import { AccountDefaults } from './lib/account-defaults.ts';
import { AccountVault, LoginStoreLock, narrowAccountVault } from './lib/accounts.ts';
import { LoginDirectory } from './lib/logins.ts';
import type { AccountSealedStore } from './lib/seal.ts';
import { SessionSignInContext } from './lib/sign-in-context.ts';
import { TwoFactorSeedAgendaAdapter } from './lib/two-factor-agenda.ts';
import { TwoFactorSeedStages } from './lib/two-factor-seeds.ts';
import { accountHint, accountRoutes, type RecipeMasking } from './routes/accounts.ts';

export type AccountsContext = DaemonContext<typeof manifest>;

/** What half b is handed: the one store (and its lock), and the one place recipes are masked. */
export interface AccountsCore {
  readonly logins: LoginDirectory;
  /** The plaintext side: handed only to the Vault's redactor and input service, never to a route (S10). */
  readonly vault?: AccountVault;
  readonly lock: LoginStoreLock;
}

/** The input an `account_hint` call takes (today's `account.hint` arm): a page by name, or a site. */
const AccountHintInputSchema = z.strictObject({
  name: z.string().min(1).max(64).optional(),
  site: z.string().min(1).max(2_048).optional(),
});

const stateFile = (ctx: AccountsContext, name: string): StateFileDef => {
  const file = ctx.manifest.data.state.find(each => each.name === name);
  if (file === undefined) throw new Error(`accounts declares no state file ${name}`);
  return file;
};

/**
 * Builds half a. `sealed` is the Vault's sealed store for login values; until the Vault's contract offers it, it is
 * absent and every change that seals fails closed (`UNBUILT_SEALED_STORE`), while the listing, hints and every change
 * that seals nothing still work from the index.
 */
export function buildAccounts(
  ctx: AccountsContext,
  options: { readonly sealed?: AccountSealedStore; readonly recipes?: () => RecipeMasking | undefined } = {},
) {
  const { kernel } = ctx;
  const index = new StateAccountIndexStore(kernel.state, stateFile(ctx, 'accounts'));
  const sealed = options.sealed?.sealed ?? UNBUILT_SEALED_STORE;
  const cipher = options.sealed?.cipher ?? UNBUILT_CIPHER;
  const lock = new LoginStoreLock();
  const vault = options.sealed === undefined ? undefined : new AccountVault(index, sealed, cipher);
  const narrowed = vault === undefined ? undefined : narrowAccountVault(vault);
  const configDef = ctx.manifest.data.config[0];
  const inEffect = (): AccountsConfig | undefined => {
    if (configDef?.shape !== 'file') return undefined;
    const file = kernel.config.file(configDef);
    const parsed = AccountsConfigSchema.safeParse(file);
    return parsed.success ? parsed.data : undefined;
  };
  // The kernel offers no config write yet: an owner's line is refused with a sentence, and a repoint after an account
  // act is reported in the status warnings (the act itself stands).
  const defaults: AccountDefaults = new AccountDefaults({
    inEffect,
    writer: {
      amend: async () => {
        throw new ApiError(503, 'this daemon cannot write accounts.yaml yet; edit the file by hand', 'unavailable');
      },
    },
    listing: async () => await logins.accounts.list(),
  });
  const logins: LoginDirectory = new LoginDirectory(index, sealed, cipher, kernel.clock, {
    hostName: machineName(),
    lock,
    ...(narrowed === undefined ? {} : { seals: narrowed.seals }),
    repointDefaults: async changes => await defaults.repoint(changes),
  });
  const accounts = logins.accounts;
  const choice = new SessionSignInContext({
    defaults: async () => inEffect() ?? {},
    // No Projects or Ferrets port names a session's board or folder yet: every session reads as Unfiled with no
    // recorded folder, so only the site lines order a card (the next rule, never a lost card).
    projectOf: async () => 'unfiled',
    projects: async () => [],
    sessions: { read: async () => null },
    realpath: async () => undefined,
    home: '/',
  });
  const seeds =
    options.sealed === undefined
      ? undefined
      : new TwoFactorSeedStages({
          accounts,
          cipher: options.sealed.cipher,
          clock: kernel.clock,
          // Access's passkey list is not reachable from Accounts yet: no seed can be saved ("add a passkey first").
          anyPasskey: async () => false,
          hostName: machineName(),
          agenda: new TwoFactorSeedAgendaAdapter(ctx.needs.asks),
        });
  const recipes = (): RecipeMasking | undefined => options.recipes?.();

  kernel.jobs.add({
    id: 'accounts.sweep',
    schedule: { onceAfterStart: true },
    run: async () => {
      const boot = await logins.sweepUnreferenced();
      if (boot.damaged !== undefined) kernel.log.warn('accounts: the account store is damaged', { why: boot.damaged });
    },
  });

  const routes = accountRoutes({
    accounts,
    get recipes() {
      return recipes();
    },
    ...(narrowed === undefined ? {} : { lookAlike: narrowed.lookAlike }),
    defaults,
    choice,
    ...(seeds === undefined ? {} : { seeds }),
  });

  /** `account_hint`: the summary only, never a value (S13, I131). A page by name needs Browsers' page address. */
  const accountHintTool: ToolHandler = async (call, input) => {
    const parsed = AccountHintInputSchema.safeParse(input ?? {});
    if (!parsed.success) return { text: 'Name a site as a host like github.com, or a URL.', isError: true };
    if (parsed.data.site === undefined)
      return {
        text:
          parsed.data.name === undefined
            ? 'Name a site as a host like github.com, or a URL.'
            : 'Name the site the page is on, as a host like github.com, or a URL.',
        isError: true,
      };
    try {
      const recipesNow = recipes();
      const hint = await accountHint(
        { accounts, choice, ...(recipesNow === undefined ? {} : { recipes: recipesNow }) },
        parsed.data.site,
        call.credential?.tokenClass === 'ferret' ? call.credential.ferret : undefined,
      );
      return { text: accountHintSummary(hint.site, hint.hints) };
    } catch (error) {
      if (error instanceof ApiError && error.code === 'invalid_site')
        return { text: 'Name a site as a host like github.com, or a URL.', isError: true };
      return { text: 'The accounts cannot be read right now; ask the owner to check Settings.', isError: true };
    }
  };

  /** The `accounts` port: which sign-ins are saved for one place, by id and account. Never a value. */
  const port: AccountsApi = {
    signInsFor: async (place: PlaceKey) => {
      const listing = await accounts.list();
      return listing.signIns
        .filter(signIn => placeHosts(signIn.place).includes(place))
        .map(signIn => ({ id: signIn.id, account: signIn.account, place: signIn.place }));
    },
  };

  const core: AccountsCore = { logins, lock, ...(vault === undefined ? {} : { vault }) };
  return { routes, tools: { account_hint: accountHintTool }, provides: { accounts: port }, core };
}
