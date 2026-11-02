import {
  type AccountHintList,
  type AccountId,
  AccountIdSchema,
  type AccountList,
  type AccountLookAlike,
  AccountPairRequestSchema,
  AddSignInRequestSchema,
  AddTwoFactorKeyRequestSchema,
  accountHintsFor,
  ConfirmTwoFactorSeedRequestSchema,
  type LoginEntryId,
  LoginEntryIdSchema,
  type LoginEntryList,
  type LoginEntrySummary,
  type LoginHintList,
  LoginRecipeDecisionSchema,
  LoginRecipeProposalIdSchema,
  loginHintSite,
  loginHintsFor,
  PatchTwoFactorKeyRequestSchema,
  PutAccountDefaultRequestSchema,
  type PutAccountDefaultResult,
  PutAccountRequestSchema,
  PutLoginEntryRequestSchema,
  PutSecretRequestSchema,
  PutSignInRequestSchema,
  RemovedTwoFactorKeySchema,
  RenameAccountRequestSchema,
  RenameLoginEntryRequestSchema,
  type SecretCloneRefusal,
  SecretExportRequestSchema,
  SecretExportResponseSchema,
  SecretImportCompleteRequestSchema,
  type SecretImportId,
  SecretImportIdSchema,
  SecretImportOfferSchema,
  SecretImportResultSchema,
  type SecretName,
  SecretNameSchema,
  type SecretSummary,
  SecretUseRequestSchema,
  type SignInId,
  SignInIdSchema,
  STEP_UP_ACTS,
  STEP_UP_REQUIRED_CODE,
  StageTwoFactorSeedRequestSchema,
  type StepUpRequiredBody,
  TWO_FACTOR_ERROR_CODES,
  type TwoFactorId,
  TwoFactorIdSchema,
  TwoFactorSeedConfirmingSchema,
  TwoFactorSeedSavedSchema,
  TwoFactorSeedStagedSchema,
  TwoFactorSeedStageViewSchema,
  type TwoFactorStageId,
  TwoFactorStageIdSchema,
} from '@ferretry/protocol';
import { parseActor } from '../../api/actor.ts';
import { isAgentCaller, OWNER_ONLY_CODE, ownerOnlyWords } from '../../api/agent-caller.ts';
import { parseBody } from '../../api/body.ts';
import type { CapabilityDemand } from '../../api/capability.ts';
import { ApiError } from '../../api/error.ts';
import { type ApiResponse, decodeParameter } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import {
  AccountDefaultNotUsable,
  type AccountDefaults,
  AccountDefaultsFileBroken,
  type AccountDirectory,
  type AccountListing,
  type AccountVault,
  DEVICE_OWNER,
  type LoginDirectory,
  LoginEntryError,
  type LoginRecipeService,
  RecipeValueError,
  SecretCloneError,
  type SecretDirectory,
  type SecretExportService,
  type SecretImportService,
  type SecretReferenceSource,
  SecretStoreError,
  SecretUseError,
  type SecretUseService,
  type SeedSaver,
  type SignInChoicePort,
  type StageCaller,
  secretListView,
  TwoFactorSeedError,
  TwoFactorSeedProofMissing,
  type TwoFactorSeedStages,
  UnknownSecretError,
} from '../../secrets/index.ts';
import { heldEditRefusal, spendHeldEditProof } from './config-files.ts';

/**
 * What a ferret is told when it tries to set a place's default account: only the owner does, and how a ferret asks.
 * `config_write` is off unless the owner turned on "Ferretry settings", so the agenda card is named first.
 */
export const ACCOUNT_DEFAULT_OWNER_ONLY = `${ownerOnlyWords('chooses the default account for a place')}: say which account and why on an agenda card, or, where "Ferretry settings" is on, write the line with config_write to account-defaults.yaml, where it waits for them`;

/**
 * The secret store's HTTP surface.
 *
 * READ THE ROUTE LIST AND NOTICE WHAT IS ABSENT. There is no `GET /v1/secrets/:name`, and there
 * never will be: **no route returns a secret value.** Not to a browser, not to the CLI, not to an
 * agent, not to a debug endpoint. That is the property the whole subsystem rests on, and it is
 * enforced by the type this mount is handed — `SecretDirectory` has no method that opens ciphertext,
 * so a value cannot be projected here even by accident. Adding a getter "just for testing" would
 * delete the feature.
 *
 * `POST /v1/secrets/use` is how a value is used instead. The daemon spawns a child with the secret
 * in THAT child's environment, and answers with the child's output, scrubbed. An agent writes the
 * name; the value never enters the agent's own conversation, so there is nothing for it to echo into
 * a transcript.
 *
 * WHAT THAT DOES AND DOES NOT PROMISE — say it wherever this is described, including on screen:
 *
 * - Protects against: secrets landing in transcripts and shell history, a person reading one off a
 *   screen, a value written into configuration or copied along with it, a tool printing one by
 *   accident.
 * - Does NOT protect against: an agent that is actively trying to exfiltrate a secret it may use. It
 *   can transform the value — `echo $KEY | base64` — and scrubbing cannot recognise what it cannot
 *   match. The boundary is the one `sudo` has.
 *
 * Every route is `admin`. A warden supervises sessions and has no business enumerating, replacing or
 * spending the operator's credentials, and the route table is where that decision belongs.
 *
 * A FERRET HOLDS THE ADMIN TOKEN BUT MAY NOT WRITE THE STORE: set, replace, delete, saved logins, and
 * filing or sealing a copy are refused to an agent (`ownerOnly`). It lists names and uses a secret by name.
 */

/** A domain failure's HTTP answer. A damaged store is a 500: the caller did nothing wrong, and
 *  reporting it as a client error would send a person looking at their own request. */
const STORE_STATUS: Readonly<Record<SecretStoreError['failure'], number>> = {
  unreadable: 500,
  key_missing: 500,
  undecipherable: 500,
  full: 409,
};

const USE_STATUS: Readonly<Record<SecretUseError['refusal'], number>> = {
  invalid_cwd: 400,
  unknown_secret: 404,
};

/** How each clone refusal answers. An unreadable identity is this daemon's fault, so it is a 503. */
const CLONE_STATUS: Readonly<Record<SecretCloneRefusal, number>> = {
  identity_unavailable: 503,
  offer_invalid: 400,
  offer_expired: 410,
  same_machine: 400,
  import_unknown: 404,
  import_spent: 409,
  bundle_invalid: 400,
};

const LOGIN_STATUS: Readonly<Record<LoginEntryError['refusal'], number>> = {
  unknown_login: 404,
  login_exists: 409,
  label_required: 400,
  no_such_field: 400,
  bad_via: 400,
  unknown_proposal: 404,
  stale_proposal: 409,
  unknown_sign_in: 404,
  place_taken: 409,
  invalid_change: 409,
  account_has_sign_ins: 409,
  account_has_2fa_keys: 409,
  no_sign_in: 409,
  merge_refused: 409,
  unknown_2fa_key: 404,
  add_2fa_key_needs_passkey: 403,
};

/** Re-raises a domain failure as its HTTP answer, and anything else as itself so a genuine bug is
 *  still a 500 rather than being reported as the caller's fault. */
function reraise(error: unknown): never {
  if (error instanceof UnknownSecretError)
    throw new ApiError(404, `this daemon holds no secret named ${error.names.join(', ')}`, 'unknown_secret');
  if (error instanceof SecretCloneError) throw new ApiError(CLONE_STATUS[error.refusal], error.message, error.refusal);
  if (error instanceof SecretUseError) throw new ApiError(USE_STATUS[error.refusal], error.message, error.refusal);
  if (error instanceof SecretStoreError) throw new ApiError(STORE_STATUS[error.failure], error.message, error.failure);
  if (error instanceof LoginEntryError) throw new ApiError(LOGIN_STATUS[error.refusal], error.message, error.refusal);
  if (error instanceof RecipeValueError) throw new ApiError(400, error.message, 'recipe_holds_value');
  throw error;
}

/**
 * THE SECRET STORE IS THE OWNER'S TO WRITE. Every ferret holds the host admin token, so without this a
 * confused or prompt-injected agent could replace `GITHUB_TOKEN` with a value it controls, or delete it.
 * It is refused here, before a body is read, with the two ways a ferret does reach the store: an input
 * request, or a sealed copy. Both put a card in front of the owner. The owner's own `fy` in a shell, and
 * a paired device, are not agents.
 */
function ownerOnly(context: RouteContext, act: string): void {
  if (!isAgentCaller(context)) return;
  throw new ApiError(
    403,
    `a ferret cannot ${act}; the owner does. To get a value into the store, ask the owner with an input request (they see a card and type it), or paste a sealed copy into the store (secure copy). Both show the owner a card.`,
    'forbidden',
  );
}

/** The saved login's handle in the path. */
function pathLoginId(context: RouteContext): LoginEntryId {
  const parsed = LoginEntryIdSchema.safeParse(decodeParameter(context.params.get('id') ?? '') ?? '');
  if (!parsed.success) throw new ApiError(400, 'the account name in the path is not usable', 'invalid_login_id');
  return parsed.data;
}

/**
 * SAVED LOGINS (docs/input-requests.md): labels, matches, usernames and WHICH secret fields exist. Like the
 * secret routes, nothing here answers a value: the directory a route holds seals and never opens. A damaged
 * store is part of the listing, never an empty one.
 */
/**
 * The entries as a route may answer them: every recipe and proposal masked through the redactor at READ time (a value
 * kept after the text was written shows as a mask), or left out where nothing can mask them.
 */
async function served(
  logins: LoginDirectory,
  recipes: LoginRecipeService | undefined,
): Promise<readonly LoginEntrySummary[]> {
  const entries = await logins.list();
  if (recipes !== undefined) return await recipes.scrubbed(entries);
  return entries.map(({ recipe: _recipe, recipeBy: _by, proposals: _proposals, ...entry }) => entry);
}

async function listLogins(logins: LoginDirectory, recipes: LoginRecipeService | undefined): Promise<ApiResponse> {
  try {
    return jsonResponse({ v: 1, health: 'ready', entries: await served(logins, recipes) } satisfies LoginEntryList);
  } catch (error) {
    if (!(error instanceof SecretStoreError)) throw error;
    return jsonResponse({
      v: 1,
      health: 'damaged',
      diagnosis: `the accounts cannot be read: ${error.message}`,
      entries: [],
    } satisfies LoginEntryList);
  }
}

/**
 * WHAT A FERRET MAY KNOW ABOUT SIGNING IN TO A SITE: the entries for it and the providers they go via, by handle,
 * label, method, login domains and the plain username. A narrower view than the listing (no `fields`, no
 * `match`, no times), and never a value. A damaged store is a 500, never an empty hint.
 */
async function loginHint(
  logins: LoginDirectory,
  recipes: LoginRecipeService | undefined,
  context: RouteContext,
): Promise<ApiResponse> {
  const site = loginHintSite(context.request.query.get('site')?.[0] ?? '');
  if (site === undefined) throw new ApiError(400, 'name a site: a host like github.com, or a URL', 'invalid_site');
  try {
    const hints = loginHintsFor(site, await served(logins, recipes));
    return jsonResponse({ v: 1, site, hints, passkeys: 'off' } satisfies LoginHintList);
  } catch (error) {
    return reraise(error);
  }
}

async function putLogin(
  logins: LoginDirectory,
  recipes: LoginRecipeService | undefined,
  context: RouteContext,
): Promise<ApiResponse> {
  ownerOnly(context, 'change an account');
  const id = pathLoginId(context);
  const change = await parseBody(context.request, PutLoginEntryRequestSchema);
  try {
    // A recipe never holds a value: without the checker that proves it, a recipe is not taken at all.
    if (typeof change.recipe === 'string') {
      if (recipes === undefined) throw new ApiError(503, 'this daemon cannot check recipes for values', 'unavailable');
      await recipes.assertNoValue(change.recipe);
    }
    const changed = await logins.put(id, change);
    return jsonResponse(recipes === undefined ? changed : ((await recipes.scrubbed([changed]))[0] ?? changed));
  } catch (error) {
    return reraise(error);
  }
}

/**
 * THE OWNER'S ANSWER TO A FERRET'S RECIPE PROPOSAL. Owner only, like every change to a saved login: an agent
 * answering its own proposal is refused before the body is read.
 */
async function decideRecipe(recipes: LoginRecipeService, context: RouteContext): Promise<ApiResponse> {
  ownerOnly(context, 'approve or decline a recipe proposal');
  const id = pathLoginId(context);
  const proposal = LoginRecipeProposalIdSchema.safeParse(decodeParameter(context.params.get('proposalId') ?? '') ?? '');
  if (!proposal.success) throw new ApiError(400, 'the proposal in the path is not usable', 'invalid_proposal');
  const { decision } = await parseBody(context.request, LoginRecipeDecisionSchema);
  try {
    return jsonResponse(await recipes.decide(id, proposal.data, decision));
  } catch (error) {
    return reraise(error);
  }
}

async function renameLogin(logins: LoginDirectory, context: RouteContext): Promise<ApiResponse> {
  ownerOnly(context, 'rename an account');
  const id = pathLoginId(context);
  const { to } = await parseBody(context.request, RenameLoginEntryRequestSchema);
  try {
    return jsonResponse(await logins.rename(id, to));
  } catch (error) {
    return reraise(error);
  }
}

async function removeLogin(logins: LoginDirectory, context: RouteContext): Promise<ApiResponse> {
  ownerOnly(context, 'delete an account');
  const id = pathLoginId(context);
  try {
    if (!(await logins.remove(id))) throw new ApiError(404, `there is no account ${id}`, 'unknown_login');
    return jsonResponse({ id, removed: true });
  } catch (error) {
    return reraise(error);
  }
}

/** The saved-login routes, when the daemon keeps them. */
function loginRoutes(logins: LoginDirectory | undefined, recipes: LoginRecipeService | undefined): readonly ApiRoute[] {
  if (logins === undefined) return [];
  return [
    {
      method: 'GET',
      path: '/v1/secrets/logins',
      minimum: 'operator',
      caller: 'person',
      capability: SECRETS_USE,
      noStore: true,
      handle: async () => await listLogins(logins, recipes),
    },
    {
      method: 'GET',
      path: '/v1/secrets/logins/hint',
      minimum: 'operator',
      caller: 'any',
      capability: SECRETS_USE,
      noStore: true,
      handle: async context => await loginHint(logins, recipes, context),
    },
    {
      method: 'PUT',
      path: '/v1/secrets/logins/:id',
      minimum: 'operator',
      caller: 'person',
      capability: SECRETS_CONFIGURE,
      noStore: true,
      handle: async context => await putLogin(logins, recipes, context),
    },
    ...(recipes === undefined
      ? []
      : [
          {
            method: 'POST',
            path: '/v1/secrets/logins/:id/recipe/proposals/:proposalId',
            minimum: 'operator',
            caller: 'person',
            capability: SECRETS_CONFIGURE,
            noStore: true,
            handle: async (context: RouteContext) => await decideRecipe(recipes, context),
          } satisfies ApiRoute,
        ]),
    {
      method: 'POST',
      path: '/v1/secrets/logins/:id/rename',
      minimum: 'operator',
      caller: 'person',
      capability: SECRETS_CONFIGURE,
      noStore: true,
      handle: async context => await renameLogin(logins, context),
    },
    {
      method: 'DELETE',
      path: '/v1/secrets/logins/:id',
      minimum: 'operator',
      caller: 'person',
      capability: SECRETS_CONFIGURE,
      noStore: true,
      handle: async context => await removeLogin(logins, context),
    },
  ];
}

// ── Accounts and sign-ins (docs/secrets.md) ──────────────────────────────────────────────────────

/** The account's handle in the path. */
function pathAccountId(context: RouteContext): AccountId {
  const parsed = AccountIdSchema.safeParse(decodeParameter(context.params.get('id') ?? '') ?? '');
  if (!parsed.success) throw new ApiError(400, 'the account name in the path is not usable', 'invalid_account_id');
  return parsed.data;
}

/** The sign-in id in the path. */
function pathSignInId(context: RouteContext): SignInId {
  const parsed = SignInIdSchema.safeParse(decodeParameter(context.params.get('signIn') ?? '') ?? '');
  if (!parsed.success) throw new ApiError(400, 'the sign-in in the path is not usable', 'invalid_sign_in');
  return parsed.data;
}

/** The listing as a route may answer it: every recipe and proposal masked at READ time, or left out. */
async function servedAccounts(
  accounts: AccountDirectory,
  recipes: LoginRecipeService | undefined,
): Promise<AccountListing> {
  const listing = await accounts.list();
  if (recipes !== undefined) return await recipes.scrubbedAccounts(listing);
  return {
    accounts: listing.accounts,
    signIns: listing.signIns.map(
      ({ recipe: _recipe, recipeBy: _by, recipeVersion: _version, proposals: _proposals, ...signIn }) => signIn,
    ),
  };
}

async function listAccounts(accounts: AccountDirectory, recipes: LoginRecipeService | undefined): Promise<ApiResponse> {
  try {
    return jsonResponse({ v: 1, health: 'ready', ...(await servedAccounts(accounts, recipes)) } satisfies AccountList);
  } catch (error) {
    if (!(error instanceof SecretStoreError)) throw error;
    return jsonResponse({
      v: 1,
      health: 'damaged',
      diagnosis: `the accounts cannot be read: ${error.message}`,
      accounts: [],
      signIns: [],
    } satisfies AccountList);
  }
}

/**
 * WHAT A FERRET MAY KNOW ABOUT SIGNING IN TO A SITE, one entry per sign-in (`accountHintsFor`): never a value, which
 * secret fields exist, a seed's existence, seals, "keep apart" pairs, look-alike groups, auto-apply or proposals.
 */
async function accountHint(
  accounts: AccountDirectory,
  recipes: LoginRecipeService | undefined,
  choice: SignInChoicePort | undefined,
  context: RouteContext,
): Promise<ApiResponse> {
  const site = loginHintSite(context.request.query.get('site')?.[0] ?? '');
  if (site === undefined) throw new ApiError(400, 'name a site: a host like github.com, or a URL', 'invalid_site');
  try {
    const order = await choice?.of(callingSession(context));
    const hints = accountHintsFor(site, await servedAccounts(accounts, recipes), order);
    return jsonResponse({ v: 1, site, hints, passkeys: 'off' } satisfies AccountHintList);
  } catch (error) {
    return reraise(error);
  }
}

/**
 * The session a request is FROM, read from the credential-derived actor (`peer:<id>`) and only for an agent caller;
 * never from the query or the body, so a ferret cannot ask for another session's project default. The owner's own
 * request has none.
 */
function callingSession(context: RouteContext): string | undefined {
  if (!isAgentCaller(context)) return undefined;
  const { kind, id } = parseActor(context.actor ?? '');
  return kind === 'peer' && id !== undefined && id !== '' ? id : undefined;
}

/** A recipe never holds a value: without the checker that proves it, a recipe is not taken at all. */
async function checkedRecipe(recipes: LoginRecipeService | undefined, recipe: unknown): Promise<void> {
  if (typeof recipe !== 'string') return;
  if (recipes === undefined) throw new ApiError(503, 'this daemon cannot check recipes for values', 'unavailable');
  await recipes.assertNoValue(recipe);
}

/** The routes of the account store. Every write is the OWNER's: a ferret is refused before the body is read. */
function accountRoutes(
  accounts: AccountDirectory | undefined,
  recipes: LoginRecipeService | undefined,
  lookAlike: Pick<AccountVault, 'lookAlike'> | undefined,
  defaults: AccountDefaults | undefined,
  choice: SignInChoicePort | undefined,
): readonly ApiRoute[] {
  if (accounts === undefined) return [];
  /** An owner-only handler: a ferret is refused before the body is read, and a domain refusal is its HTTP answer. */
  const owned =
    (act: string, run: (context: RouteContext) => Promise<unknown>) =>
    async (context: RouteContext): Promise<ApiResponse> => {
      ownerOnly(context, act);
      try {
        return jsonResponse(await run(context));
      } catch (error) {
        return reraise(error);
      }
    };
  const configure = { minimum: 'operator', caller: 'person', capability: SECRETS_CONFIGURE, noStore: true } as const;
  return [
    {
      method: 'GET',
      path: '/v1/accounts',
      minimum: 'operator',
      caller: 'person',
      capability: SECRETS_USE,
      noStore: true,
      // The OWNER's view: which fields each account holds, which 2FA keys Ferretry makes codes for and whether they
      // worked, every username and place. A ferret reads `/v1/accounts/hint` instead.
      handle: async context => {
        ownerOnly(context, 'list the accounts');
        return await listAccounts(accounts, recipes);
      },
    },
    {
      method: 'GET',
      path: '/v1/accounts/hint',
      minimum: 'operator',
      caller: 'any',
      capability: SECRETS_USE,
      noStore: true,
      handle: async context => await accountHint(accounts, recipes, choice, context),
    },
    // "THESE LOOK LIKE ONE ACCOUNT" is derived from passwords, so it is the owner's alone even though it only reads:
    // a ferret is refused, and the answer is handles only (never a username, never which field matched).
    ...(lookAlike === undefined
      ? []
      : [
          {
            method: 'GET',
            path: '/v1/accounts/look-alike',
            minimum: 'operator',
            caller: 'person',
            capability: SECRETS_CONFIGURE,
            noStore: true,
            handle: async (context: RouteContext) => {
              ownerOnly(context, 'see which accounts look like one');
              try {
                return jsonResponse({ v: 1, groups: await lookAlike.lookAlike() } satisfies AccountLookAlike);
              } catch (error) {
                return reraise(error);
              }
            },
          } satisfies ApiRoute,
        ]),
    {
      method: 'PUT',
      path: '/v1/accounts/sign-ins/:signIn',
      ...configure,
      handle: owned('change a sign-in', async context => {
        const signIn = pathSignInId(context);
        const change = await parseBody(context.request, PutSignInRequestSchema);
        await checkedRecipe(recipes, change.recipe);
        const changed = await accounts.putSignIn(signIn, change);
        return recipes === undefined
          ? changed
          : (await recipes.scrubbedAccounts({ accounts: [], signIns: [changed] })).signIns[0];
      }),
    },
    {
      method: 'DELETE',
      path: '/v1/accounts/sign-ins/:signIn',
      ...configure,
      handle: owned('remove a sign-in', async context => {
        const signIn = pathSignInId(context);
        if (!(await accounts.removeSignIn(signIn)))
          throw new ApiError(404, `there is no sign-in ${signIn}`, 'unknown_sign_in');
        return { id: signIn, removed: true };
      }),
    },
    ...(recipes === undefined
      ? []
      : [
          {
            method: 'POST',
            path: '/v1/accounts/sign-ins/:signIn/recipe/proposals/:proposalId',
            ...configure,
            handle: owned('approve or decline a recipe proposal', async context => {
              const signIn = pathSignInId(context);
              const proposal = LoginRecipeProposalIdSchema.safeParse(
                decodeParameter(context.params.get('proposalId') ?? '') ?? '',
              );
              if (!proposal.success)
                throw new ApiError(400, 'the proposal in the path is not usable', 'invalid_proposal');
              const { decision } = await parseBody(context.request, LoginRecipeDecisionSchema);
              return await recipes.decideSignIn(signIn, proposal.data, decision);
            }),
          } satisfies ApiRoute,
        ]),
    // THE DEFAULT ACCOUNT FOR A PLACE (docs/config-files.md, account-defaults.yaml). Registered BEFORE `/:id`, which
    // would otherwise read "defaults" as a handle. Every change to that file is HELD when anyone else makes it, so
    // this is the owner's own act: a ferret is refused before the body is read, a paired device needs the passkey
    // step-up for loosening a configuration file, and at the machine it is direct. The line is written and in effect
    // in the same act. It is `caller: 'person'` (from `configure`), so the boundary refuses a ferret first.
    ...(defaults === undefined
      ? []
      : [
          {
            method: 'PUT',
            path: '/v1/accounts/defaults',
            ...configure,
            handle: async (context: RouteContext) => {
              if (isAgentCaller(context)) throw new ApiError(403, ACCOUNT_DEFAULT_OWNER_ONLY, OWNER_ONLY_CODE);
              const refused = heldEditRefusal(context, 'account-defaults.yaml', 'confirm');
              if (refused !== undefined) return refused;
              const change = await parseBody(context.request, PutAccountDefaultRequestSchema);
              try {
                const written = await defaults.set(change, change.account);
                spendHeldEditProof(context);
                return jsonResponse({ defaults: written } satisfies PutAccountDefaultResult);
              } catch (error) {
                if (error instanceof AccountDefaultsFileBroken)
                  throw new ApiError(409, error.message, 'defaults_file_invalid');
                if (error instanceof AccountDefaultNotUsable) throw new ApiError(409, error.message, 'no_sign_in_here');
                return reraise(error);
              }
            },
          } satisfies ApiRoute,
        ]),
    {
      method: 'PUT',
      path: '/v1/accounts/:id',
      ...configure,
      handle: owned('change an account', async context => {
        const id = pathAccountId(context);
        return await accounts.putAccount(id, await parseBody(context.request, PutAccountRequestSchema));
      }),
    },
    {
      method: 'POST',
      path: '/v1/accounts/:id/rename',
      ...configure,
      handle: owned('rename an account', async context => {
        const id = pathAccountId(context);
        const { to } = await parseBody(context.request, RenameAccountRequestSchema);
        return await accounts.renameAccount(id, to);
      }),
    },
    {
      method: 'DELETE',
      path: '/v1/accounts/:id',
      ...configure,
      handle: owned('delete an account', async context => {
        const id = pathAccountId(context);
        if (!(await accounts.removeAccount(id))) throw new ApiError(404, `there is no account ${id}`, 'unknown_login');
        return { id, removed: true };
      }),
    },
    {
      method: 'POST',
      path: '/v1/accounts/:id/sign-ins',
      ...configure,
      handle: owned('add a sign-in', async context => {
        const id = pathAccountId(context);
        const add = await parseBody(context.request, AddSignInRequestSchema);
        await checkedRecipe(recipes, add.recipe);
        const added = await accounts.addSignIn(id, add);
        return recipes === undefined
          ? added
          : (await recipes.scrubbedAccounts({ accounts: [], signIns: [added] })).signIns[0];
      }),
    },
    {
      method: 'POST',
      path: '/v1/accounts/:id/merge',
      ...configure,
      handle: owned('merge accounts', async context => {
        const id = pathAccountId(context);
        const { from } = await parseBody(context.request, AccountPairRequestSchema);
        return await accounts.merge(id, from);
      }),
    },
    {
      method: 'POST',
      path: '/v1/accounts/:id/apart',
      ...configure,
      handle: owned('keep accounts apart', async context => {
        const id = pathAccountId(context);
        const { from } = await parseBody(context.request, AccountPairRequestSchema);
        return await accounts.apart(id, from);
      }),
    },
  ];
}

// ── 2FA keys (docs/secrets.md, "2FA keys") ───────────────────────────────────────────────────────

/** The 2FA key id in the path. */
function pathFactorId(context: RouteContext): TwoFactorId {
  const parsed = TwoFactorIdSchema.safeParse(decodeParameter(context.params.get('factor') ?? '') ?? '');
  if (!parsed.success) throw new ApiError(400, 'the 2FA key in the path is not usable', 'invalid_factor');
  return parsed.data;
}

/** The staged seed in the path. One this daemon could never have minted is simply not waiting. */
function pathStageId(context: RouteContext): TwoFactorStageId {
  const parsed = TwoFactorStageIdSchema.safeParse(decodeParameter(context.params.get('stage') ?? '') ?? '');
  if (!parsed.success)
    throw new ApiError(404, 'that 2FA key is not waiting to be saved', TWO_FACTOR_ERROR_CODES.stageGone);
  return parsed.data;
}

/**
 * Who is asking about a stage, from the boundary: a paired device by its id, anything else by its actor.
 *
 * NO FERRET IS EVER ONE OF THEM. Every stage route is `caller: 'person'`, so a ferret's own session
 * credential — and the admin token naming a ferret's session — is refused at the boundary, and again by
 * `ownerOnly` above, before a stage is keyed at all: a ferret cannot use up or drop a stage the owner made.
 * What is left is the admin token with no session, which this daemon cannot tell from the owner's own `fy`.
 */
function stageCaller(context: RouteContext): StageCaller {
  const device = context.request.device;
  return device === undefined
    ? { key: context.actor ?? 'unknown', device: false }
    : { key: `${DEVICE_OWNER}${device.deviceId}`, device: true };
}

/** Who saved a seed, as an input card's deliver names the owner ("use it now"): a paired device, or the machine. */
function seedSaver(context: RouteContext): SeedSaver {
  const credential = context.credential;
  return credential?.tokenClass === 'device' ? { kind: 'device', deviceId: credential.deviceId } : { kind: 'host' };
}

/** Who asked for a save, in the card's words: the owner's shell, the app at the machine, or a paired device. */
function askedByWords(context: RouteContext): string {
  const { kind } = parseActor(context.actor ?? '');
  if (kind === 'admin-cli') return 'fy';
  if (kind === 'device') return 'a paired device';
  return 'the app on this machine';
}

/**
 * The commit's refusal without a proof: the ordinary step-up demand, naming `add-2fa-key`, so the app runs the
 * ceremony for this stage and sends the commit again. The machine's own token gets it too: it proves nothing.
 */
const seedProofDemand = (): ApiResponse =>
  jsonResponse(
    {
      error: 'saving a 2FA key needs a passkey confirmation for this one save, from a paired device',
      code: STEP_UP_REQUIRED_CODE,
      demand: { ...SECRETS_CONFIGURE, act: STEP_UP_ACTS.addTwoFactorKey },
    } satisfies StepUpRequiredBody,
    403,
  );

/**
 * The 2FA key routes of the account store. Every one is the OWNER's (a ferret is refused before the body is read).
 * Adding a key with no value, relabelling and removing never ask for a passkey; saving a SEED is staged here and
 * committed only with a fresh `add-2fa-key` proof bound to that stage — asked of every caller, the machine included:
 * the commit never reads `governance`, an unlock or `stepUpOnActions`.
 */
function factorRoutes(
  accounts: AccountDirectory | undefined,
  seeds: TwoFactorSeedStages | undefined,
): readonly ApiRoute[] {
  if (accounts === undefined) return [];
  const configure = { minimum: 'operator', caller: 'person', capability: SECRETS_CONFIGURE, noStore: true } as const;
  const owned =
    (act: string, run: (context: RouteContext) => Promise<unknown>, status = 200) =>
    async (context: RouteContext): Promise<ApiResponse> => {
      ownerOnly(context, act);
      try {
        return jsonResponse(await run(context), status);
      } catch (error) {
        if (error instanceof TwoFactorSeedError) throw new ApiError(error.status, error.message, error.code);
        if (error instanceof LoginEntryError && error.refusal === 'unknown_2fa_key')
          throw new ApiError(404, error.message, TWO_FACTOR_ERROR_CODES.unknownFactor);
        return reraise(error);
      }
    };
  const seedRoutes: readonly ApiRoute[] =
    seeds === undefined
      ? []
      : [
          {
            method: 'POST',
            path: '/v1/accounts/:id/factors/seed',
            ...configure,
            handle: owned(
              'stage a 2FA key',
              async context => {
                const id = pathAccountId(context);
                return TwoFactorSeedStagedSchema.parse(
                  await seeds.stage(
                    id,
                    await parseBody(context.request, StageTwoFactorSeedRequestSchema),
                    stageCaller(context),
                  ),
                );
              },
              201,
            ),
          },
          {
            method: 'GET',
            path: '/v1/accounts/:id/factors/seed/:stage',
            ...configure,
            handle: owned('read a staged 2FA key', async context =>
              TwoFactorSeedStageViewSchema.parse(
                await seeds.view(pathAccountId(context), pathStageId(context), stageCaller(context)),
              ),
            ),
          },
          {
            method: 'POST',
            path: '/v1/accounts/:id/factors/seed/:stage/commit',
            ...configure,
            handle: async context => {
              ownerOnly(context, 'save a 2FA key');
              const id = pathAccountId(context);
              const stage = pathStageId(context);
              try {
                // EVERY CALLER proves it: no `governance` read here, so the machine's token skips nothing.
                const saved = await seeds.commit(
                  id,
                  stage,
                  subject => context.claimFreshStepUp?.(STEP_UP_ACTS.addTwoFactorKey, subject) === true,
                  seedSaver(context),
                );
                return jsonResponse(TwoFactorSeedSavedSchema.parse(saved));
              } catch (error) {
                if (error instanceof TwoFactorSeedProofMissing) return seedProofDemand();
                if (error instanceof TwoFactorSeedError) throw new ApiError(error.status, error.message, error.code);
                return reraise(error);
              }
            },
          },
          {
            method: 'POST',
            path: '/v1/accounts/:id/factors/seed/:stage/confirm-in-app',
            ...configure,
            handle: owned(
              'ask the owner to save a 2FA key',
              async context => {
                const id = pathAccountId(context);
                const stage = pathStageId(context);
                const { session } = await parseBody(context.request, ConfirmTwoFactorSeedRequestSchema);
                const { agendaItemId } = await seeds.confirmInApp(
                  id,
                  stage,
                  session,
                  askedByWords(context),
                  stageCaller(context),
                );
                return TwoFactorSeedConfirmingSchema.parse({ stage, session, agendaItemId });
              },
              201,
            ),
          },
          {
            method: 'DELETE',
            path: '/v1/accounts/:id/factors/seed/:stage',
            ...configure,
            handle: owned('drop a staged 2FA key', async context => {
              const stage = pathStageId(context);
              await seeds.drop(pathAccountId(context), stage, stageCaller(context));
              return { stage, dropped: true };
            }),
          },
        ];
  return [
    ...seedRoutes,
    {
      method: 'POST',
      path: '/v1/accounts/:id/factors',
      ...configure,
      handle: owned(
        'add a 2FA key',
        async context => {
          const id = pathAccountId(context);
          return await accounts.addFactor(id, await parseBody(context.request, AddTwoFactorKeyRequestSchema));
        },
        201,
      ),
    },
    {
      method: 'PATCH',
      path: '/v1/accounts/:id/factors/:factor',
      ...configure,
      handle: owned('change a 2FA key', async context => {
        const id = pathAccountId(context);
        const factor = pathFactorId(context);
        return await accounts.patchFactor(id, factor, await parseBody(context.request, PatchTwoFactorKeyRequestSchema));
      }),
    },
    {
      // NEVER a passkey: removing a key only narrows what this machine can do. Its seed is swept with it.
      method: 'DELETE',
      path: '/v1/accounts/:id/factors/:factor',
      ...configure,
      handle: owned('remove a 2FA key', async context => {
        const id = pathAccountId(context);
        const factor = pathFactorId(context);
        if (!(await accounts.removeFactor(id, factor)))
          throw new ApiError(404, `${id} has no 2FA key ${factor}`, TWO_FACTOR_ERROR_CODES.unknownFactor);
        return RemovedTwoFactorKeySchema.parse({ account: id, factor, removed: true });
      }),
    },
  ];
}

/** The name in the path, decoded and validated as a name this store could ever have held. */
function pathSecretName(context: RouteContext): SecretName {
  const decoded = decodeParameter(context.params.get('name') ?? '');
  const parsed = SecretNameSchema.safeParse(decoded ?? '');
  if (!parsed.success) throw new ApiError(400, 'the secret name in the path is not usable', 'invalid_secret_name');
  return parsed.data;
}

async function list(directory: SecretDirectory, references: SecretReferenceSource): Promise<ApiResponse> {
  // Deliberately NOT wrapped in `reraise`: a damaged store is part of this answer rather than a
  // failure of it, and `secretListView` reports it as `health: 'damaged'` with a diagnosis. A person
  // shown an empty list over an unreadable vault would recreate every secret on top of it.
  return jsonResponse(await secretListView(directory, references));
}

async function put(directory: SecretDirectory, context: RouteContext): Promise<ApiResponse> {
  ownerOnly(context, 'set or replace a secret');
  const request = await parseBody(context.request, PutSecretRequestSchema);
  try {
    const summary: SecretSummary = await directory.put(request.name, request.value);
    return jsonResponse(summary);
  } catch (error) {
    return reraise(error);
  }
}

async function remove(directory: SecretDirectory, context: RouteContext): Promise<ApiResponse> {
  ownerOnly(context, 'delete a secret');
  const name = pathSecretName(context);
  try {
    if (!(await directory.remove(name))) throw new ApiError(404, `no secret named ${name}`, 'unknown_secret');
    return jsonResponse({ name, removed: true });
  } catch (error) {
    return reraise(error);
  }
}

async function use(uses: SecretUseService, context: RouteContext): Promise<ApiResponse> {
  const request = await parseBody(context.request, SecretUseRequestSchema);
  try {
    return jsonResponse(await uses.run(request));
  } catch (error) {
    return reraise(error);
  }
}

/** The import id in the path, validated as one this daemon could ever have minted. */
function pathImportId(context: RouteContext): SecretImportId {
  const parsed = SecretImportIdSchema.safeParse(decodeParameter(context.params.get('importId') ?? '') ?? '');
  if (!parsed.success) throw new ApiError(404, 'no such secret import', 'import_unknown');
  return parsed.data;
}

async function openImport(imports: SecretImportService, context: RouteContext): Promise<ApiResponse> {
  ownerOnly(context, 'open a secret import');
  try {
    return jsonResponse(SecretImportOfferSchema.parse(await imports.open()), 201);
  } catch (error) {
    return reraise(error);
  }
}

async function completeImport(imports: SecretImportService, context: RouteContext): Promise<ApiResponse> {
  ownerOnly(context, 'file secrets into the store');
  const importId = pathImportId(context);
  const { bundle } = await parseBody(context.request, SecretImportCompleteRequestSchema);
  try {
    return jsonResponse(SecretImportResultSchema.parse(await imports.complete(importId, bundle)));
  } catch (error) {
    return reraise(error);
  }
}

/**
 * Sealing secrets for another machine.
 *
 * THE VALUES LEAVE THIS DAEMON, so a governed caller proves a passkey for THIS ACT, every time — even an
 * unlocked device, whatever `stepUpOnActions` says, exactly like adding a device (owner decision
 * 2026-10-20: "require the passkey again"). The owner at the machine is asked for nothing: it already has
 * the machine (B4). The governance is the boundary's, never re-derived here; its absence refuses.
 */
async function exportSecrets(exports: SecretExportService, context: RouteContext): Promise<ApiResponse> {
  ownerOnly(context, 'seal secrets for another machine');
  if (context.governance === undefined)
    throw new ApiError(500, 'this daemon cannot say who is asking, so it is refusing', 'internal_error');
  const importId = pathImportId(context);
  const request = await parseBody(context.request, SecretExportRequestSchema);
  if (context.governance.governed && context.presentation?.freshStepUp !== true)
    return jsonResponse(
      {
        error: 'copying secrets to another machine needs a passkey confirmation for it, from this device',
        code: STEP_UP_REQUIRED_CODE,
        demand: { ...SECRETS_CONFIGURE, act: STEP_UP_ACTS.cloneSecrets },
      } satisfies StepUpRequiredBody,
      403,
    );
  try {
    const sealed = SecretExportResponseSchema.parse(await exports.seal(importId, request));
    context.spendFreshStepUp?.();
    return jsonResponse(sealed);
  } catch (error) {
    return reraise(error);
  }
}

const SECRETS_USE: CapabilityDemand = { capability: 'secrets', axis: 'use' };
const SECRETS_CONFIGURE: CapabilityDemand = { capability: 'secrets', axis: 'configure' };

/** Everything this mount needs, already built. */
export interface SecretSubsystem {
  /** Management only. It cannot open a secret, which is why a route may hold one. */
  readonly directory: SecretDirectory;
  /** Saved logins: management only, like `directory`. It seals and never opens. */
  readonly logins?: LoginDirectory;
  /** Accounts and sign-ins: management only, like `logins` (which projects them). Seals and never opens. */
  readonly accounts?: AccountDirectory;
  /** The vault's one look-alike answer (handles only): the only part of it a route holds. */
  readonly lookAlike?: Pick<AccountVault, 'lookAlike'>;
  /** The default account per place: the owner's one-line write of `config/account-defaults.yaml`. */
  readonly accountDefaults?: AccountDefaults;
  /** The calling session's project, folder and the defaults, which order `account_hint`'s "default". */
  readonly signInChoice?: SignInChoicePort;
  /**
   * Staged 2FA seeds, waiting for the passkey bound to each. It holds sealed seeds in memory and never answers one.
   */
  readonly seeds?: TwoFactorSeedStages;
  /** Login recipes: the value check on every recipe text, and the owner's answer to a proposal. */
  readonly loginRecipes?: LoginRecipeService;
  /** Where configuration names secrets, so an unresolvable reference is visible before it fails. */
  readonly references: SecretReferenceSource;
  /** Use-without-read. Holds the vault; returns only a child's scrubbed output. */
  readonly uses: SecretUseService;
  /** The TARGET's half of copying secrets between machines. Write-only, like `directory`. */
  readonly imports: SecretImportService;
  /** The SOURCE's half: holds the vault, answers only ciphertext sealed to another machine. */
  readonly exports: SecretExportService;
}

/**
 * `noStore` on every route: a secret listing is live state an operator acts on, and a cached one
 * shows a credential they already rotated or deleted. The use response is a command's output and is
 * never the same answer twice.
 *
 * `/v1/secrets/use` registers BEFORE the one-segment `:name` pattern. They cannot shadow each other
 * — the verbs differ — but registering the fixed literal first is the habit that keeps that true
 * when a later verb is added.
 *
 * GOVERNED BY `secrets`, the seventh capability (`docs/grants.md`). The list and the use sit on `use` —
 * the use runs a command with a stored value in its environment, which is code on this host, so a
 * governed caller also needs a passkey step-up for it — and set and delete sit on `configure`. Before
 * this, these routes named no demand and any paired device could run a command through them.
 */
export function secretRoutes(subsystem: SecretSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/secrets',
      minimum: 'operator',
      caller: 'any',
      capability: SECRETS_USE,
      noStore: true,
      handle: async () => await list(subsystem.directory, subsystem.references),
    },
    {
      method: 'POST',
      path: '/v1/secrets/use',
      minimum: 'operator',
      caller: 'any',
      capability: SECRETS_USE,
      noStore: true,
      handle: async context => await use(subsystem.uses, context),
    },
    {
      method: 'POST',
      path: '/v1/secrets',
      minimum: 'operator',
      caller: 'person',
      capability: SECRETS_CONFIGURE,
      noStore: true,
      handle: async context => await put(subsystem.directory, context),
    },
    {
      method: 'DELETE',
      path: '/v1/secrets/:name',
      minimum: 'operator',
      caller: 'person',
      capability: SECRETS_CONFIGURE,
      noStore: true,
      handle: async context => await remove(subsystem.directory, context),
    },
    // COPYING TO ANOTHER MACHINE (docs/secrets.md). Three routes over two daemons, all `configure`: the
    // target opens an import and later files a bundle into its store; the source seals chosen values to
    // that import. None of them answers a value — the export answers ciphertext only the target opens.
    {
      method: 'POST',
      path: '/v1/secrets/imports',
      minimum: 'operator',
      caller: 'person',
      capability: SECRETS_CONFIGURE,
      noStore: true,
      handle: async context => await openImport(subsystem.imports, context),
    },
    {
      method: 'POST',
      path: '/v1/secrets/imports/:importId',
      minimum: 'operator',
      caller: 'person',
      capability: SECRETS_CONFIGURE,
      noStore: true,
      handle: async context => await completeImport(subsystem.imports, context),
    },
    {
      method: 'POST',
      path: '/v1/secrets/exports/:importId',
      minimum: 'operator',
      caller: 'person',
      capability: SECRETS_CONFIGURE,
      noStore: true,
      handle: async context => await exportSecrets(subsystem.exports, context),
    },
    ...loginRoutes(subsystem.logins, subsystem.loginRecipes),
    ...accountRoutes(
      subsystem.accounts,
      subsystem.loginRecipes,
      subsystem.lookAlike,
      subsystem.accountDefaults,
      subsystem.signInChoice,
    ),
    ...factorRoutes(subsystem.accounts, subsystem.seeds),
  ];
}
