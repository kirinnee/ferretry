/**
 * HALF A of Accounts' daemon (rebuild unit accounts-a): accounts, sign-ins, saved logins and 2FA keys. It builds the
 * account store over the kernel's state port and the Vault's sealed store, and answers the `/v1/accounts` routes, the
 * `account_hint` tool and the `accounts` port. Half b (rules, plans, recipes, phone approval, secure copy) is
 * `./rules.ts`, built after this one and handed {@link AccountsCore}.
 */
import { ferretOf, isFerretCall } from '@ferretry/core-gate/contract';
import { ApiError, type ConfigFileDef, type StateFileDef } from '@ferretry/kernel/contract';
import type { DaemonContext, ToolHandler } from '@ferretry/kernel/manifest';
import { z } from 'zod';
import { type AccountsApi, type AccountsConfig, AccountsConfigSchema, type PlaceKey } from '../contract/index.ts';
import type manifest from '../manifest.ts';
import { accountHintSummary, placeHosts } from '../contract/routes/index.ts';
import { machineName } from './adapters/host.ts';
import { gateAuditSink } from './adapters/gate-audit.ts';
import { KernelAccountDefaultsWriter } from './adapters/kernel-defaults-writer.ts';
import { StateAccountIndexStore } from './adapters/state-account-index-store.ts';
import {
  boardProjectOf,
  ownerFerretOf,
  ownerHome,
  pageUrlOf,
  registeredProjects,
  workFolderOf,
} from './adapters/pending-reads.ts';
import { MemoryCipher, vaultSealedStore } from './adapters/vault-sealed.ts';
import { LOGIN_SECRETS } from '../contract/routes/sealed.ts';
import { AccountDefaults } from './lib/account-defaults.ts';
import { AccountVault, LoginStoreLock, narrowAccountVault } from './lib/accounts.ts';
import { LoginDirectory } from './lib/logins.ts';
import type { AccountSealedStore } from './lib/seal.ts';
import { SessionSignInContext } from './lib/sign-in-context.ts';
import { TwoFactorSeedAgendaAdapter } from './lib/two-factor-agenda.ts';
import { lateSeedCards, TwoFactorSeedStages } from './lib/two-factor-seeds.ts';
import { accountHint, accountRoutes, type RecipeMasking } from './routes/accounts.ts';

import { accountSecurity } from './adapters/pending-security.ts';

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
 * Builds half a over the kernel's state port (the index) and the Vault's sealed-document port (the values, in
 * Accounts' own `login-secrets.json`).
 */
export function buildAccounts(
  ctx: AccountsContext,
  options: { readonly recipes?: () => RecipeMasking | undefined } = {},
) {
  const { kernel } = ctx;
  const index = new StateAccountIndexStore(kernel.state, stateFile(ctx, 'accounts'));
  const store: AccountSealedStore = vaultSealedStore(ctx.needs.sealed.open(kernel.state, LOGIN_SECRETS));
  const { sealed, cipher } = store;
  const lock = new LoginStoreLock();
  const vault = new AccountVault(index, sealed, cipher);
  const narrowed = vault === undefined ? undefined : narrowAccountVault(vault);
  const declared = ctx.manifest.data.config[0];
  if (declared?.shape !== 'file') throw new Error('accounts declares accounts.yaml as its one config file');
  const configDef = declared as ConfigFileDef<AccountsConfig>;
  const inEffect = (): AccountsConfig | undefined => {
    const file = kernel.config.file(configDef);
    const parsed = AccountsConfigSchema.safeParse(file);
    return parsed.success ? parsed.data : undefined;
  };
  // The owner's own lines go through the kernel's one config writer; a repoint after an account act that cannot be
  // written is reported in the status warnings (the act itself stands).
  const defaults: AccountDefaults = new AccountDefaults({
    inEffect,
    writer: new KernelAccountDefaultsWriter(kernel.config, configDef),
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
    // I184: the project is the Board's (`projectOf`, from the credential-derived ferret), named by the Projects registry
    // and matched by id; the folder is Ferrets' REAL work folder, only for Unfiled. A plugin that is off or says nothing
    // leaves the site lines alone (the next rule, never a lost card).
    projectOf: async ferret => await boardProjectOf(ctx.uses.board, ferret),
    projects: async () => await registeredProjects(ctx.uses.projects),
    sessions: {
      read: async ferret => {
        const folder = await workFolderOf(ctx.uses.ferrets, ferret);
        return folder === undefined ? null : { cwd: folder };
      },
    },
    // Ferrets answers a folder only while it is still its own real path (a symlink swap answers nothing), so there is
    // nothing left to resolve here.
    realpath: async path => path,
    home: ownerHome(),
  });
  const seeds = new TwoFactorSeedStages({
    accounts,
    // A staged seed rests sealed in THIS process's memory only (S89), under a key that is never written anywhere.
    cipher: new MemoryCipher(),
    clock: kernel.clock,
    // Access supplies the paired-device/passkey read; an absent or unreadable provider refuses the stage.
    anyPasskey: accountSecurity(ctx.uses.access).passkeys.any,
    hostName: machineName(),
    agenda: new TwoFactorSeedAgendaAdapter(ctx.needs.asks),
    // The input card a seed is set up from (I173): where the daemon saw its target, and "use it now" (the Vault's).
    cards: lateSeedCards(() => ({
      cardTarget: requestId => ctx.needs.vault.cardTarget?.(requestId),
      useNow: async (requestId, use) => (await ctx.needs.vault.useNow?.(requestId, use)) ?? false,
    })),
    // The owner at their own shell has no ferret: their card goes under the most recently active live one.
    ownerSession: async () => await ownerFerretOf(ctx.uses.ferrets),
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
    audit: gateAuditSink(ctx.needs.gate),
  });

  /** `account_hint`: the summary only, never a value (S13, I131). A page by name is read for its address (Browsers). */
  const accountHintTool: ToolHandler = async (call, input) => {
    const parsed = AccountHintInputSchema.safeParse(input ?? {});
    if (!parsed.success) return { text: 'Name a site as a host like github.com, or a URL.', isError: true };
    const ferret = isFerretCall(call) ? ferretOf(call) : undefined;
    const site =
      parsed.data.site ??
      (parsed.data.name === undefined || ferret === undefined
        ? undefined
        : await pageUrlOf(ctx.uses.browsers, ferret, parsed.data.name));
    if (site === undefined)
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
        site,
        ferret,
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
  return {
    routes,
    tools: { account_hint: accountHintTool },
    provides: { accounts: port },
    core,
    masks: {
      values: async () =>
        new Map([
          ...(await vault.values()),
          ...[...(await seeds.values())].map(
            ([label, value]) => [label.replace(/^login:stage:/u, '2fa:'), value] as const,
          ),
        ]),
    },
  };
}
