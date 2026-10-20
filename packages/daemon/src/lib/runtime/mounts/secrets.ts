import {
  PutSecretRequestSchema,
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
  STEP_UP_ACTS,
  STEP_UP_REQUIRED_CODE,
  type StepUpRequiredBody,
} from '@ferretry/protocol';
import { parseBody } from '../../api/body.ts';
import type { CapabilityDemand } from '../../api/capability.ts';
import { ApiError } from '../../api/error.ts';
import { type ApiResponse, decodeParameter } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import {
  SecretCloneError,
  type SecretDirectory,
  type SecretExportService,
  type SecretImportService,
  type SecretReferenceSource,
  SecretStoreError,
  SecretUseError,
  type SecretUseService,
  secretListView,
  UnknownSecretError,
} from '../../secrets/index.ts';

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

/** Re-raises a domain failure as its HTTP answer, and anything else as itself so a genuine bug is
 *  still a 500 rather than being reported as the caller's fault. */
function reraise(error: unknown): never {
  if (error instanceof UnknownSecretError)
    throw new ApiError(404, `this daemon holds no secret named ${error.names.join(', ')}`, 'unknown_secret');
  if (error instanceof SecretCloneError) throw new ApiError(CLONE_STATUS[error.refusal], error.message, error.refusal);
  if (error instanceof SecretUseError) throw new ApiError(USE_STATUS[error.refusal], error.message, error.refusal);
  if (error instanceof SecretStoreError) throw new ApiError(STORE_STATUS[error.failure], error.message, error.failure);
  throw error;
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
  const request = await parseBody(context.request, PutSecretRequestSchema);
  try {
    const summary: SecretSummary = await directory.put(request.name, request.value);
    return jsonResponse(summary);
  } catch (error) {
    return reraise(error);
  }
}

async function remove(directory: SecretDirectory, context: RouteContext): Promise<ApiResponse> {
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

async function openImport(imports: SecretImportService): Promise<ApiResponse> {
  try {
    return jsonResponse(SecretImportOfferSchema.parse(await imports.open()), 201);
  } catch (error) {
    return reraise(error);
  }
}

async function completeImport(imports: SecretImportService, context: RouteContext): Promise<ApiResponse> {
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
      capability: SECRETS_USE,
      noStore: true,
      handle: async () => await list(subsystem.directory, subsystem.references),
    },
    {
      method: 'POST',
      path: '/v1/secrets/use',
      minimum: 'operator',
      capability: SECRETS_USE,
      noStore: true,
      handle: async context => await use(subsystem.uses, context),
    },
    {
      method: 'POST',
      path: '/v1/secrets',
      minimum: 'operator',
      capability: SECRETS_CONFIGURE,
      noStore: true,
      handle: async context => await put(subsystem.directory, context),
    },
    {
      method: 'DELETE',
      path: '/v1/secrets/:name',
      minimum: 'operator',
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
      capability: SECRETS_CONFIGURE,
      noStore: true,
      handle: async () => await openImport(subsystem.imports),
    },
    {
      method: 'POST',
      path: '/v1/secrets/imports/:importId',
      minimum: 'operator',
      capability: SECRETS_CONFIGURE,
      noStore: true,
      handle: async context => await completeImport(subsystem.imports, context),
    },
    {
      method: 'POST',
      path: '/v1/secrets/exports/:importId',
      minimum: 'operator',
      capability: SECRETS_CONFIGURE,
      noStore: true,
      handle: async context => await exportSecrets(subsystem.exports, context),
    },
  ];
}
