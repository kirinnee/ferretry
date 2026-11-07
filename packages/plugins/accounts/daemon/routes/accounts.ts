/**
 * The account store's HTTP surface (today's `runtime/mounts/secrets.ts`, the `/v1/accounts` half, copied; the
 * `/v1/secrets/logins` routes are gone with S84). Nothing here answers a value: the directory a route holds seals and
 * never opens, and the look-alike route holds only the vault's `lookAlike` (handles, never what matched). A damaged
 * store is part of the listing, never an empty one.
 *
 * EVERY WRITE IS THE OWNER'S: a ferret is refused before the body is read (S77, I176).
 */
import {
  CAPABILITIES,
  type CallerGovernance,
  type CapabilityPresentation,
  grantRefusalCode,
  isFerretCall,
  ferretOf,
  OWNER_ONLY_CODE,
  ownerOnlyWords,
  STEP_UP_ACTS,
  STEP_UP_REQUIRED_CODE,
  type StepUpRequiredBody,
} from '@ferretry/core-gate/contract';
import {
  ApiError,
  type ApiResponse,
  type CallContext,
  type CapabilityDemand,
  decodeParameter,
  jsonResponse,
} from '@ferretry/kernel/contract';
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
  loginHintSite,
  PatchTwoFactorKeyRequestSchema,
  PutAccountDefaultRequestSchema,
  type PutAccountDefaultResult,
  PutAccountRequestSchema,
  PutSignInRequestSchema,
  RemovedTwoFactorKeySchema,
  RenameAccountRequestSchema,
  type SignInId,
  SignInIdSchema,
  StageTwoFactorSeedRequestSchema,
  TWO_FACTOR_ERROR_CODES,
  type TwoFactorId,
  TwoFactorIdSchema,
  TwoFactorSeedConfirmingSchema,
  TwoFactorSeedSavedSchema,
  TwoFactorSeedStagedSchema,
  TwoFactorSeedStageViewSchema,
  type TwoFactorStageId,
  TwoFactorStageIdSchema,
} from '../../contract/routes/index.ts';
import { AccountDefaultNotUsable, type AccountDefaults, AccountDefaultsFileBroken } from '../lib/account-defaults.ts';
import { type AccountDirectory, type AccountListing, type AccountVault, LoginEntryError } from '../lib/accounts.ts';
import { parseBody } from '../lib/body.ts';
import { SecretStoreError } from '../lib/seal.ts';
import type { SignInChoicePort } from '../lib/sign-in-context.ts';
import {
  DEVICE_OWNER,
  type SeedSaver,
  type StageCaller,
  TwoFactorSeedError,
  TwoFactorSeedProofMissing,
  type TwoFactorSeedStages,
} from '../lib/two-factor-seeds.ts';

/** A route's call: the request, its params, and Gate's standing. */
type Call = CallContext;
type Handler = (call: Call) => Promise<ApiResponse>;

/**
 * What the recipe half (accounts-b) lends this one: the value check on every recipe text, and the masking of every
 * recipe at READ time. Absent: a recipe is never taken, and none is served (I133).
 */
export interface RecipeMasking {
  assertNoValue(recipe: string): Promise<void>;
  scrubbedAccounts(listing: AccountListing): Promise<AccountListing>;
}

/** Everything these routes need, already built. */
export interface AccountRoutesDeps {
  /** Management only: it seals and never opens. */
  readonly accounts: AccountDirectory;
  readonly recipes?: RecipeMasking;
  /** The vault's one look-alike answer (handles only): the only part of it a route holds. */
  readonly lookAlike?: Pick<AccountVault, 'lookAlike'>;
  readonly defaults?: AccountDefaults;
  readonly choice?: SignInChoicePort;
  /** Staged 2FA seeds, waiting for the passkey bound to each. It never answers a seed. */
  readonly seeds?: TwoFactorSeedStages;
}

const SECRETS_CONFIGURE: CapabilityDemand = { capability: CAPABILITIES.secrets, axis: 'configure' };

const ACCOUNT_DEFAULTS_FILE = 'accounts.yaml';

/**
 * What a ferret is told when it tries to set a place's default account: only the owner does, and how a ferret asks.
 */
export const ACCOUNT_DEFAULT_OWNER_ONLY = `${ownerOnlyWords('chooses the default account for a place')}: say which account and why on an agenda card, or, where "Ferretry settings" is on, write the line with config_write to ${ACCOUNT_DEFAULTS_FILE}, where it waits for them`;

/** A domain failure's HTTP answer. A damaged store is a 500: the caller did nothing wrong. */
const STORE_STATUS: Readonly<Record<SecretStoreError['failure'], number>> = {
  unreadable: 500,
  key_missing: 500,
  undecipherable: 500,
  full: 409,
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

/** A recipe text that holds a value (accounts-b's `RecipeValueError`), by name so this half needs no import of it. */
const isRecipeValueError = (error: unknown): error is Error =>
  error instanceof Error && error.name === 'RecipeValueError';

/** Re-raises a domain failure as its HTTP answer, and anything else as itself so a bug is still a 500. */
function reraise(error: unknown): never {
  if (error instanceof SecretStoreError) throw new ApiError(STORE_STATUS[error.failure], error.message, error.failure);
  if (error instanceof LoginEntryError) throw new ApiError(LOGIN_STATUS[error.refusal], error.message, error.refusal);
  if (isRecipeValueError(error)) throw new ApiError(400, error.message, 'recipe_holds_value');
  throw error;
}

/**
 * THE ACCOUNT STORE IS THE OWNER'S TO WRITE. Every ferret holds the host admin token, so without this a confused or
 * prompt-injected agent could replace a password with one it controls. Refused here, before a body is read.
 */
function ownerOnly(call: Call, act: string): void {
  if (!isFerretCall(call)) return;
  throw new ApiError(
    403,
    `a ferret cannot ${act}; the owner does. To get a value into the store, ask the owner with an input request (they see a card and type it), or paste a sealed copy into the store (secure copy). Both show the owner a card.`,
    'forbidden',
  );
}

/** The account's handle in the path. */
function pathAccountId(call: Call): AccountId {
  const parsed = AccountIdSchema.safeParse(decodeParameter(call.params.get('id') ?? '') ?? '');
  if (!parsed.success) throw new ApiError(400, 'the account name in the path is not usable', 'invalid_account_id');
  return parsed.data;
}

/** The sign-in id in the path. */
function pathSignInId(call: Call): SignInId {
  const parsed = SignInIdSchema.safeParse(decodeParameter(call.params.get('signIn') ?? '') ?? '');
  if (!parsed.success) throw new ApiError(400, 'the sign-in in the path is not usable', 'invalid_sign_in');
  return parsed.data;
}

/** The 2FA key id in the path. */
function pathFactorId(call: Call): TwoFactorId {
  const parsed = TwoFactorIdSchema.safeParse(decodeParameter(call.params.get('factor') ?? '') ?? '');
  if (!parsed.success) throw new ApiError(400, 'the 2FA key in the path is not usable', 'invalid_factor');
  return parsed.data;
}

/** The staged seed in the path. One this daemon could never have minted is simply not waiting. */
function pathStageId(call: Call): TwoFactorStageId {
  const parsed = TwoFactorStageIdSchema.safeParse(decodeParameter(call.params.get('stage') ?? '') ?? '');
  if (!parsed.success)
    throw new ApiError(404, 'that 2FA key is not waiting to be saved', TWO_FACTOR_ERROR_CODES.stageGone);
  return parsed.data;
}

/** The listing as a route may answer it: every recipe and proposal masked at READ time, or left out (S78, I133). */
async function servedAccounts(accounts: AccountDirectory, recipes: RecipeMasking | undefined): Promise<AccountListing> {
  const listing = await accounts.list();
  if (recipes !== undefined) return await recipes.scrubbedAccounts(listing);
  return {
    accounts: listing.accounts,
    signIns: listing.signIns.map(
      ({ recipe: _recipe, recipeBy: _by, recipeVersion: _version, proposals: _proposals, ...signIn }) => signIn,
    ),
  };
}

async function listAccounts(accounts: AccountDirectory, recipes: RecipeMasking | undefined): Promise<ApiResponse> {
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
 * The session a request is FROM, from the credential, and only for a ferret's call; never from the query or the body,
 * so a ferret cannot ask for another session's project default (I184). The owner's own request has none.
 */
function callingSession(call: Call): string | undefined {
  return isFerretCall(call) ? ferretOf(call) : undefined;
}

/**
 * WHAT A FERRET MAY KNOW ABOUT SIGNING IN TO A SITE, one entry per sign-in (`accountHintsFor`): never a value, which
 * secret fields exist, a seed's existence, seals, "keep apart" pairs, look-alike groups, auto-apply or proposals (S13).
 */
export async function accountHint(
  deps: Pick<AccountRoutesDeps, 'accounts' | 'recipes' | 'choice'>,
  siteText: string,
  session: string | undefined,
): Promise<AccountHintList> {
  const site = loginHintSite(siteText);
  if (site === undefined) throw new ApiError(400, 'name a site: a host like github.com, or a URL', 'invalid_site');
  try {
    const order = await deps.choice?.of(session);
    const hints = accountHintsFor(site, await servedAccounts(deps.accounts, deps.recipes), order);
    return { v: 1, site, hints, passkeys: 'off' };
  } catch (error) {
    return reraise(error);
  }
}

/** A recipe never holds a value: without the checker that proves it, a recipe is not taken at all (I133). */
async function checkedRecipe(recipes: RecipeMasking | undefined, recipe: unknown): Promise<void> {
  if (typeof recipe !== 'string') return;
  if (recipes === undefined) throw new ApiError(503, 'this daemon cannot check recipes for values', 'unavailable');
  await recipes.assertNoValue(recipe);
}

/** A step-up demand body (today's `StepUpRequiredBody`). */
const stepUpRequired = (error: string, demand: StepUpRequiredBody['demand']): ApiResponse =>
  jsonResponse({ error, code: STEP_UP_REQUIRED_CODE, demand } satisfies StepUpRequiredBody, 403);

/**
 * The widen a narrowing route judges inside (`CapabilityDemand.narrowing`): `secrets.configure` as the boundary would
 * have asked it, step-up and all. Answers the refusal, or `undefined` when allowed or ungoverned.
 */
function widenRefusal(governance: CallerGovernance | undefined): ApiResponse | undefined {
  const decision = governance?.decide(SECRETS_CONFIGURE);
  if (decision === undefined || decision.allowed) return undefined;
  return decision.refusal === 'step-up-required'
    ? stepUpRequired('choosing a default account from this device needs a passkey confirmation', {
        capability: 'secrets',
        axis: 'configure',
      })
    : jsonResponse(
        { error: 'this device may not choose default accounts', code: grantRefusalCode(decision.refusal) },
        403,
      );
}

/**
 * Adding or changing a line in a config file a person reads in the owner's name: from a governed device, a passkey
 * proved for `loosen-config` (today's `heldEditRefusal(…, 'confirm')`); at the machine, nothing more (S79).
 */
function heldEditRefusal(
  governance: CallerGovernance | undefined,
  presentation: CapabilityPresentation | undefined,
): ApiResponse | undefined {
  if (governance?.governed === true && presentation?.freshStepUp !== true)
    return stepUpRequired(`putting this change to ${ACCOUNT_DEFAULTS_FILE} into effect needs a passkey confirmation`, {
      capability: 'secrets',
      axis: 'configure',
      act: 'loosen-config',
    });
  return undefined;
}

/**
 * Who is asking about a stage, from the boundary: a paired device by its holder, anything else by its actor (S96).
 * NO FERRET IS EVER ONE OF THEM: every stage route is `caller: 'person'`, and `ownerOnly` refuses again.
 */
function stageCaller(call: Call): StageCaller {
  const principal = call.request.principal;
  return principal?.kind === 'device'
    ? { key: `${DEVICE_OWNER}${principal.holder}`, device: true }
    : { key: call.actor ?? 'unknown', device: false };
}

/** Who saved a seed, as an input card's deliver names the owner ("use it now"): a paired device, or the machine. */
function seedSaver(call: Call): SeedSaver {
  const credential = call.credential;
  return credential?.tokenClass === 'device'
    ? { kind: 'device', deviceId: credential.principal.holder }
    : { kind: 'host' };
}

/** Who asked for a save, in the card's words: the owner's shell, the app at the machine, or a paired device. */
function askedByWords(call: Call): string {
  if (call.request.principal?.kind === 'device') return 'a paired device';
  if ((call.actor ?? '').startsWith('admin-cli')) return 'fy';
  return 'the app on this machine';
}

/**
 * The commit's refusal without a proof: the ordinary step-up demand, naming `add-2fa-key`, so the app runs the
 * ceremony for this stage and sends the commit again. The machine's own token gets it too: it proves nothing (S91).
 */
const seedProofDemand = (): ApiResponse =>
  stepUpRequired('saving a 2FA key needs a passkey confirmation for this one save, from a paired device', {
    capability: 'secrets',
    axis: 'configure',
    act: 'add-2fa-key',
  });

/** An owner-only handler: a ferret is refused before the body is read, and a domain refusal is its HTTP answer. */
const owned =
  (act: string, run: (call: Call) => Promise<unknown>, status = 200): Handler =>
  async call => {
    ownerOnly(call, act);
    try {
      return jsonResponse(await run(call), status);
    } catch (error) {
      if (error instanceof TwoFactorSeedError) throw new ApiError(error.status, error.message, error.code);
      if (error instanceof LoginEntryError && error.refusal === 'unknown_2fa_key')
        throw new ApiError(404, error.message, TWO_FACTOR_ERROR_CODES.unknownFactor);
      return reraise(error);
    }
  };

/** A route this daemon cannot answer because a part it needs is not built (`503 unavailable`). */
const unavailable =
  (what: string): Handler =>
  async () => {
    throw new ApiError(503, `this daemon ${what}`, 'unavailable');
  };

/** The `/v1/accounts` routes of half a, keyed as the manifest declares them. */
export function accountRoutes(deps: AccountRoutesDeps) {
  const { accounts, recipes, lookAlike, defaults, seeds } = deps;
  return {
    // The OWNER's view: which fields each account holds, which 2FA keys Ferretry makes codes for and whether they
    // worked, every username and place. A ferret reads `/v1/accounts/hint` instead.
    'GET /v1/accounts': async (call: Call) => {
      ownerOnly(call, 'list the accounts');
      return await listAccounts(accounts, recipes);
    },
    'GET /v1/accounts/hint': async (call: Call) =>
      jsonResponse(await accountHint(deps, call.request.query.get('site')?.[0] ?? '', callingSession(call))),
    // "THESE LOOK LIKE ONE ACCOUNT" is derived from passwords, so it is the owner's alone even though it only reads:
    // a ferret is refused, and the answer is handles only (S82).
    'GET /v1/accounts/look-alike':
      lookAlike === undefined
        ? unavailable('cannot compare saved values yet')
        : owned(
            'see which accounts look like one',
            async () => ({ v: 1, groups: await lookAlike.lookAlike() }) satisfies AccountLookAlike,
          ),
    'PUT /v1/accounts/sign-ins/:signIn': owned('change a sign-in', async call => {
      const signIn = pathSignInId(call);
      const change = await parseBody(call.request, PutSignInRequestSchema);
      await checkedRecipe(recipes, change.recipe);
      const changed = await accounts.putSignIn(signIn, change);
      return recipes === undefined
        ? changed
        : (await recipes.scrubbedAccounts({ accounts: [], signIns: [changed] })).signIns[0];
    }),
    'DELETE /v1/accounts/sign-ins/:signIn': owned('remove a sign-in', async call => {
      const signIn = pathSignInId(call);
      if (!(await accounts.removeSignIn(signIn)))
        throw new ApiError(404, `there is no sign-in ${signIn}`, 'unknown_sign_in');
      return { id: signIn, removed: true };
    }),
    // THE DEFAULT ACCOUNT FOR A PLACE (S79, S80). A ferret is refused before the body is read. From a paired device,
    // ADDING OR CHANGING a line needs the passkey step-up for loosening a configuration file; REMOVING one
    // (`account: null`) only takes away and asks the grant alone, never a passkey. So the boundary admits the route as
    // a narrowing and the handler judges a widen inside.
    'PUT /v1/accounts/defaults':
      defaults === undefined
        ? unavailable('cannot write account defaults yet')
        : ((async (call: Call) => {
            if (isFerretCall(call)) throw new ApiError(403, ACCOUNT_DEFAULT_OWNER_ONLY, OWNER_ONLY_CODE);
            const change = await parseBody(call.request, PutAccountDefaultRequestSchema);
            const removes = change.account === null;
            const refused = removes
              ? undefined
              : (widenRefusal(call.governance) ?? heldEditRefusal(call.governance, call.presentation));
            if (refused !== undefined) return refused;
            try {
              const written = await defaults.set(change, change.account);
              if (!removes && call.governance?.governed === true) call.spendFreshStepUp?.();
              return jsonResponse({ defaults: written } satisfies PutAccountDefaultResult);
            } catch (error) {
              if (error instanceof AccountDefaultsFileBroken)
                throw new ApiError(409, error.message, 'defaults_file_invalid');
              if (error instanceof AccountDefaultNotUsable) throw new ApiError(409, error.message, 'no_sign_in_here');
              return reraise(error);
            }
          }) satisfies Handler),
    'PUT /v1/accounts/:id': owned('change an account', async call => {
      const id = pathAccountId(call);
      return await accounts.putAccount(id, await parseBody(call.request, PutAccountRequestSchema));
    }),
    'POST /v1/accounts/:id/rename': owned('rename an account', async call => {
      const id = pathAccountId(call);
      const { to } = await parseBody(call.request, RenameAccountRequestSchema);
      return await accounts.renameAccount(id, to);
    }),
    'DELETE /v1/accounts/:id': owned('delete an account', async call => {
      const id = pathAccountId(call);
      if (!(await accounts.removeAccount(id))) throw new ApiError(404, `there is no account ${id}`, 'unknown_login');
      return { id, removed: true };
    }),
    'POST /v1/accounts/:id/sign-ins': owned('add a sign-in', async call => {
      const id = pathAccountId(call);
      const add = await parseBody(call.request, AddSignInRequestSchema);
      await checkedRecipe(recipes, add.recipe);
      const added = await accounts.addSignIn(id, add);
      return recipes === undefined
        ? added
        : (await recipes.scrubbedAccounts({ accounts: [], signIns: [added] })).signIns[0];
    }),
    'POST /v1/accounts/:id/merge': owned('merge accounts', async call => {
      const id = pathAccountId(call);
      const { from } = await parseBody(call.request, AccountPairRequestSchema);
      return await accounts.merge(id, from);
    }),
    'POST /v1/accounts/:id/apart': owned('keep accounts apart', async call => {
      const id = pathAccountId(call);
      const { from } = await parseBody(call.request, AccountPairRequestSchema);
      return await accounts.apart(id, from);
    }),
    ...factorRoutes(accounts, seeds),
  } satisfies Readonly<Record<string, Handler>>;
}

/**
 * The 2FA key routes. Every one is the OWNER's. Adding a key with no value, relabelling and removing never ask for a
 * passkey (S99); saving a SEED is staged here and committed only with a fresh `add-2fa-key` proof bound to that stage —
 * asked of every caller, the machine included: the commit never reads `governance`, an unlock or `stepUpOnActions`
 * (S88, S90, S91).
 */
function factorRoutes(accounts: AccountDirectory, seeds: TwoFactorSeedStages | undefined) {
  const noSeeds = unavailable('cannot save 2FA seeds yet');
  return {
    'POST /v1/accounts/:id/factors/seed':
      seeds === undefined
        ? noSeeds
        : owned(
            'stage a 2FA key',
            async call =>
              TwoFactorSeedStagedSchema.parse(
                await seeds.stage(
                  pathAccountId(call),
                  await parseBody(call.request, StageTwoFactorSeedRequestSchema),
                  stageCaller(call),
                ),
              ),
            201,
          ),
    // The card names no account: the app reads its stage, and the account it is for, by the stage id alone (S101).
    'GET /v1/accounts/seed-stages/:stage':
      seeds === undefined
        ? noSeeds
        : owned('read a staged 2FA key', async call =>
            TwoFactorSeedStageViewSchema.parse(await seeds.viewStage(pathStageId(call), stageCaller(call))),
          ),
    'GET /v1/accounts/:id/factors/seed/:stage':
      seeds === undefined
        ? noSeeds
        : owned('read a staged 2FA key', async call =>
            TwoFactorSeedStageViewSchema.parse(
              await seeds.view(pathAccountId(call), pathStageId(call), stageCaller(call)),
            ),
          ),
    'POST /v1/accounts/:id/factors/seed/:stage/commit':
      seeds === undefined
        ? noSeeds
        : ((async (call: Call) => {
            ownerOnly(call, 'save a 2FA key');
            const id = pathAccountId(call);
            const stage = pathStageId(call);
            try {
              // EVERY CALLER proves it: no `governance` read here, so the machine's token skips nothing. The subject
              // is today's `sha256("ferretry.add-2fa-key.v1\0" + account key + "\0" + stage)` (S90), which binds the
              // proof to the account as well as the stage; Gate's claim is typed by the stage id alone.
              const saved = await seeds.commit(
                id,
                stage,
                subject => call.claimFreshStepUp?.(STEP_UP_ACTS.addTwoFactorKey, subject as `st_${string}`) === true,
                seedSaver(call),
              );
              return jsonResponse(TwoFactorSeedSavedSchema.parse(saved));
            } catch (error) {
              if (error instanceof TwoFactorSeedProofMissing) return seedProofDemand();
              if (error instanceof TwoFactorSeedError) throw new ApiError(error.status, error.message, error.code);
              return reraise(error);
            }
          }) satisfies Handler),
    'POST /v1/accounts/:id/factors/seed/:stage/confirm-in-app':
      seeds === undefined
        ? noSeeds
        : owned(
            'ask the owner to save a 2FA key',
            async call => {
              const id = pathAccountId(call);
              const stage = pathStageId(call);
              const { session } = await parseBody(call.request, ConfirmTwoFactorSeedRequestSchema);
              const { agendaItemId, sessionId } = await seeds.confirmInApp(
                id,
                stage,
                session,
                askedByWords(call),
                stageCaller(call),
              );
              return TwoFactorSeedConfirmingSchema.parse({ stage, session: sessionId, agendaItemId });
            },
            201,
          ),
    'DELETE /v1/accounts/:id/factors/seed/:stage':
      seeds === undefined
        ? noSeeds
        : owned('drop a staged 2FA key', async call => {
            const stage = pathStageId(call);
            await seeds.drop(pathAccountId(call), stage, stageCaller(call));
            return { stage, dropped: true };
          }),
    'POST /v1/accounts/:id/factors': owned(
      'add a 2FA key',
      async call =>
        await accounts.addFactor(pathAccountId(call), await parseBody(call.request, AddTwoFactorKeyRequestSchema)),
      201,
    ),
    'PATCH /v1/accounts/:id/factors/:factor': owned('change a 2FA key', async call => {
      const id = pathAccountId(call);
      const factor = pathFactorId(call);
      return await accounts.patchFactor(id, factor, await parseBody(call.request, PatchTwoFactorKeyRequestSchema));
    }),
    // NEVER a passkey: removing a key only narrows what this machine can do. Its seed is swept with it (S99).
    'DELETE /v1/accounts/:id/factors/:factor': owned('remove a 2FA key', async call => {
      const id = pathAccountId(call);
      const factor = pathFactorId(call);
      if (!(await accounts.removeFactor(id, factor)))
        throw new ApiError(404, `${id} has no 2FA key ${factor}`, TWO_FACTOR_ERROR_CODES.unknownFactor);
      return RemovedTwoFactorKeySchema.parse({ account: id, factor, removed: true });
    }),
  } satisfies Readonly<Record<string, Handler>>;
}
