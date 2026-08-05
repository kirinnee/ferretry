import {
  PutSecretRequestSchema,
  SecretNameSchema,
  SecretUseRequestSchema,
  type SecretName,
  type SecretSummary,
} from '@ferretry/protocol';
import { parseBody } from '../../api/body.ts';
import { ApiError } from '../../api/error.ts';
import { decodeParameter, type ApiResponse } from '../../api/http.ts';
import { jsonResponse } from '../../api/responses.ts';
import type { ApiRoute, RouteContext } from '../../api/route.ts';
import {
  SecretStoreError,
  SecretUseError,
  UnknownSecretError,
  secretListView,
  type SecretDirectory,
  type SecretReferenceSource,
  type SecretUseService,
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

/** Re-raises a domain failure as its HTTP answer, and anything else as itself so a genuine bug is
 *  still a 500 rather than being reported as the caller's fault. */
function reraise(error: unknown): never {
  if (error instanceof UnknownSecretError)
    throw new ApiError(404, `this daemon holds no secret named ${error.names.join(', ')}`, 'unknown_secret');
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

/** Everything this mount needs, already built. */
export interface SecretSubsystem {
  /** Management only. It cannot open a secret, which is why a route may hold one. */
  readonly directory: SecretDirectory;
  /** Where configuration names secrets, so an unresolvable reference is visible before it fails. */
  readonly references: SecretReferenceSource;
  /** Use-without-read. Holds the vault; returns only a child's scrubbed output. */
  readonly uses: SecretUseService;
}

/**
 * `noStore` on every route: a secret listing is live state an operator acts on, and a cached one
 * shows a credential they already rotated or deleted. The use response is a command's output and is
 * never the same answer twice.
 *
 * `/v1/secrets/use` registers BEFORE the one-segment `:name` pattern. They cannot shadow each other
 * — the verbs differ — but registering the fixed literal first is the habit that keeps that true
 * when a later verb is added.
 */
export function secretRoutes(subsystem: SecretSubsystem): readonly ApiRoute[] {
  return [
    {
      method: 'GET',
      path: '/v1/secrets',
      scope: 'admin',
      noStore: true,
      handle: async () => await list(subsystem.directory, subsystem.references),
    },
    {
      method: 'POST',
      path: '/v1/secrets/use',
      scope: 'admin',
      noStore: true,
      handle: async context => await use(subsystem.uses, context),
    },
    {
      method: 'POST',
      path: '/v1/secrets',
      scope: 'admin',
      noStore: true,
      handle: async context => await put(subsystem.directory, context),
    },
    {
      method: 'DELETE',
      path: '/v1/secrets/:name',
      scope: 'admin',
      noStore: true,
      handle: async context => await remove(subsystem.directory, context),
    },
  ];
}
