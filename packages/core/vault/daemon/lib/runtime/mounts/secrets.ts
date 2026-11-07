import { ApiError, type ApiResponse, type CallContext, decodeParameter, jsonResponse } from '@ferretry/kernel/contract';
import { isFerretCall, STEP_UP_REQUIRED_CODE, type StepUpRequiredBody } from '@ferretry/core-gate/contract';
import { type SecretName, SecretNameSchema, type SecretSummary, SecretUseRequestSchema } from '../../../../contract/index.ts';
import { parseBody } from '../../api/body.ts';
import { SecretCloneError, type SecretExportService, type SecretImportService } from '../../secrets/clone.ts';
import { SecretStoreError, type SecretReferenceSource, UnknownSecretError } from '../../secrets/types.ts';
import { SecretUseError, type SecretUseService } from '../../secrets/use.ts';
import type { SecretDirectory } from '../../secrets/vault.ts';
import { secretListView } from '../../secrets/view.ts';
import {
  PutSecretBodySchema,
  type SecretCloneRefusal,
  SecretExportRequestSchema,
  SecretExportResponseSchema,
  SecretImportCompleteRequestSchema,
  type SecretImportId,
  SecretImportIdSchema,
  SecretImportOfferSchema,
  SecretImportResultSchema,
} from '../../secrets/wire.ts';

/**
 * The secret store's HTTP surface (today's `lib/runtime/mounts/secrets.ts`, the vault half: `/v1/secrets*`). The
 * saved-login, account and 2FA routes that shared today's file are Accounts' and Logins' ports.
 *
 * READ THE ROUTE LIST AND NOTICE WHAT IS ABSENT. There is no `GET /v1/secrets/:name`, and there never will be: **no
 * route returns a secret value** (S6). Not to a browser, not to the CLI, not to an agent, not to a debug endpoint.
 * It is enforced by the type this surface is handed — `SecretDirectory` has no method that opens ciphertext, so a
 * value cannot be projected here even by accident. Adding a getter "just for testing" would delete the feature.
 *
 * `POST /v1/secrets/use` is how a value is used instead (S5). The daemon spawns a child with the secret in THAT
 * child's environment, and answers with the child's output, masked. An agent writes the name; the value never
 * enters the agent's own conversation.
 *
 * WHAT THAT DOES AND DOES NOT PROMISE — say it wherever this is described, including on screen:
 * - Protects against: secrets landing in transcripts and shell history, a person reading one off a screen, a value
 *   written into configuration or copied along with it, a tool printing one by accident.
 * - Does NOT protect against: an agent that is actively trying to exfiltrate a secret it may use. It can transform
 *   the value — `echo $KEY | base64` — and masking cannot recognise what it cannot match. The boundary is `sudo`'s.
 *
 * A FERRET HOLDS THE ADMIN TOKEN BUT MAY NOT WRITE THE STORE: set, replace, delete, and filing or sealing a copy are
 * refused to an agent (`ownerOnly`). It lists names and uses a secret by name (S31).
 *
 * The descriptors (minimum, caller, capability, noStore, audit, guard) are the manifest's; this file holds handlers.
 */

/** A damaged store is a 500: the caller did nothing wrong. */
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

/** Re-raises a domain failure as its HTTP answer, and anything else as itself so a genuine bug is still a 500. */
function reraise(error: unknown): never {
  if (error instanceof UnknownSecretError)
    throw new ApiError(404, `this daemon holds no secret named ${error.names.join(', ')}`, 'unknown_secret');
  if (error instanceof SecretCloneError) throw new ApiError(CLONE_STATUS[error.refusal], error.message, error.refusal);
  if (error instanceof SecretUseError) throw new ApiError(USE_STATUS[error.refusal], error.message, error.refusal);
  if (error instanceof SecretStoreError) throw new ApiError(STORE_STATUS[error.failure], error.message, error.failure);
  throw error;
}

/**
 * THE SECRET STORE IS THE OWNER'S TO WRITE. Every ferret holds an admin credential, so without this a confused or
 * prompt-injected agent could replace `GITHUB_TOKEN` with a value it controls, or delete it. Refused here, before a
 * body is read, with the two ways a ferret does reach the store (S32): an input request, or a sealed copy. Both put a
 * card in front of the owner.
 */
function ownerOnly(call: CallContext, act: string): void {
  if (!isFerretCall(call)) return;
  throw new ApiError(
    403,
    `a ferret cannot ${act}; the owner does. To get a value into the store, ask the owner with an input request (they see a card and type it), or paste a sealed copy into the store (secure copy). Both show the owner a card.`,
    'forbidden',
  );
}

/** The name in the path, decoded and validated as a name this store could ever have held. */
function pathSecretName(call: CallContext): SecretName {
  const decoded = decodeParameter(call.params.get('name') ?? '');
  const parsed = SecretNameSchema.safeParse(decoded ?? '');
  if (!parsed.success) throw new ApiError(400, 'the secret name in the path is not usable', 'invalid_secret_name');
  return parsed.data;
}

/** The import id in the path, validated as one this daemon could ever have minted. */
function pathImportId(call: CallContext): SecretImportId {
  const parsed = SecretImportIdSchema.safeParse(decodeParameter(call.params.get('importId') ?? '') ?? '');
  if (!parsed.success) throw new ApiError(404, 'no such secret import', 'import_unknown');
  return parsed.data;
}

/** Everything these routes need, already built. */
export interface SecretSubsystem {
  /** Management only. It cannot open a secret, which is why a route may hold one. */
  readonly directory: SecretDirectory;
  /** Where configuration names secrets, so an unresolvable reference is visible before it fails (S65). */
  readonly references: SecretReferenceSource;
  /** Use-without-read. Holds the vault; returns only a child's masked output. */
  readonly uses: SecretUseService;
  /** The TARGET's half of copying secrets between machines. Write-only, like `directory`. */
  readonly imports: SecretImportService;
  /** The SOURCE's half: holds the vault, answers only ciphertext sealed to another machine. */
  readonly exports: SecretExportService;
  /** Called after a change to the set of names (the `vault.secrets-changed` wake-up). */
  readonly changed: () => void;
}

/**
 * Sealing secrets for another machine (S159). THE VALUES LEAVE THIS DAEMON, so a governed caller proves a passkey
 * for THIS ACT, every time — even an unlocked device, exactly like adding a device (owner decision 2026-10-20). The
 * owner at the machine is asked for nothing. The governance is the boundary's, never re-derived here; its absence
 * refuses.
 */
async function exportSecrets(exports: SecretExportService, call: CallContext): Promise<ApiResponse> {
  ownerOnly(call, 'seal secrets for another machine');
  if (call.governance === undefined)
    throw new ApiError(500, 'this daemon cannot say who is asking, so it is refusing', 'internal_error');
  const importId = pathImportId(call);
  const request = await parseBody(call.request, SecretExportRequestSchema);
  if (call.governance.governed && call.presentation?.freshStepUp !== true)
    return jsonResponse(
      {
        error: 'copying secrets to another machine needs a passkey confirmation for it, from this device',
        code: STEP_UP_REQUIRED_CODE,
        demand: { capability: 'secrets', axis: 'configure', act: 'clone-secrets' },
      } satisfies StepUpRequiredBody,
      403,
    );
  try {
    const sealed = SecretExportResponseSchema.parse(await exports.seal(importId, request));
    call.spendFreshStepUp?.();
    return jsonResponse(sealed);
  } catch (error) {
    return reraise(error);
  }
}

/**
 * The handlers by route key. `noStore` on every route (the manifest's): a secret listing is live state an operator
 * acts on, and a use response is a command's output. GOVERNED BY `secrets` (S38): the list and the use sit on `use`,
 * set, delete and the three copy routes on `configure`.
 */
export function secretRouteHandlers(subsystem: SecretSubsystem) {
  const { directory, references, uses, imports, exports, changed } = subsystem;
  return {
    // Deliberately NOT wrapped in `reraise`: a damaged store is part of this answer (S141), reported as
    // `health: 'damaged'` with a diagnosis. A person shown an empty list would recreate every secret on top of it.
    'GET /v1/secrets': async (): Promise<ApiResponse> => jsonResponse(await secretListView(directory, references)),

    'POST /v1/secrets/use': async (call: CallContext): Promise<ApiResponse> => {
      const request = await parseBody(call.request, SecretUseRequestSchema);
      try {
        return jsonResponse(await uses.run(request));
      } catch (error) {
        return reraise(error);
      }
    },

    'POST /v1/secrets': async (call: CallContext): Promise<ApiResponse> => {
      ownerOnly(call, 'set or replace a secret');
      const request = await parseBody(call.request, PutSecretBodySchema);
      try {
        const summary: SecretSummary = await directory.put(request.name, request.value);
        changed();
        return jsonResponse(summary);
      } catch (error) {
        return reraise(error);
      }
    },

    'DELETE /v1/secrets/:name': async (call: CallContext): Promise<ApiResponse> => {
      ownerOnly(call, 'delete a secret');
      const name = pathSecretName(call);
      try {
        if (!(await directory.remove(name))) throw new ApiError(404, `no secret named ${name}`, 'unknown_secret');
        changed();
        return jsonResponse({ name, removed: true });
      } catch (error) {
        return reraise(error);
      }
    },

    // COPYING TO ANOTHER MACHINE (docs/secrets.md). Three routes over two daemons, all `configure`: the target opens
    // an import and later files a bundle into its store; the source seals chosen values to that import. None of them
    // answers a value — the export answers ciphertext only the target opens.
    'POST /v1/secrets/imports': async (call: CallContext): Promise<ApiResponse> => {
      ownerOnly(call, 'open a secret import');
      try {
        return jsonResponse(SecretImportOfferSchema.parse(await imports.open()), 201);
      } catch (error) {
        return reraise(error);
      }
    },

    'POST /v1/secrets/imports/:importId': async (call: CallContext): Promise<ApiResponse> => {
      ownerOnly(call, 'file secrets into the store');
      const importId = pathImportId(call);
      const { bundle } = await parseBody(call.request, SecretImportCompleteRequestSchema);
      try {
        const result = SecretImportResultSchema.parse(await imports.complete(importId, bundle));
        if (result.imported.length > 0) changed();
        return jsonResponse(result);
      } catch (error) {
        return reraise(error);
      }
    },

    'POST /v1/secrets/exports/:importId': async (call: CallContext): Promise<ApiResponse> =>
      await exportSecrets(exports, call),
  } as const;
}
