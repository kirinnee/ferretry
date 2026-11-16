import { ApiError, type ApiResponse, type CallContext, jsonResponse } from '@ferretry/kernel/contract';
import type { SessionAttachTarget } from '../../protocol/session-processes.ts';
import { SessionAttachError, type SessionAttachFailure } from '../../session/attach/index.ts';
import { type FerretDirectory, knownFerret, pathFerret } from './ferret-path.ts';

/** The daemon-authoritative attach proof. */
export interface SessionAttachSubsystem {
  resolve(sessionId: string): Promise<SessionAttachTarget>;
}

export const ATTACH_REFUSALS: Readonly<
  Record<SessionAttachFailure, { readonly status: number; readonly code: string }>
> = {
  missing_registration: { status: 409, code: 'attach_registration_missing' },
  pane_unavailable: { status: 409, code: 'attach_pane_unavailable' },
  identity_mismatch: { status: 409, code: 'attach_identity_mismatch' },
  // Multiple or malformed durable records are damaged state, not a transiently absent pane.
  ambiguous_registration: { status: 500, code: 'attach_registration_ambiguous' },
  invalid_registration: { status: 500, code: 'attach_registration_invalid' },
};

function refuse(error: unknown): never {
  if (error instanceof SessionAttachError) {
    const refusal = ATTACH_REFUSALS[error.failure];
    throw new ApiError(refusal.status, error.message, refusal.code);
  }
  throw error;
}

/**
 * `GET /v1/ferrets/:ferretId/attach` — the only route that reveals a host tmux address.
 *
 * An operator credential and privileged arrival are both required (the manifest's descriptor): this hands a human
 * an interactive terminal, and the path is meaningful only on the machine whose daemon proved the process identity.
 * `noStore` because the proof is short-lived — a resume replaces the pane and invalidates it immediately.
 */
export function attachHandler(
  attach: SessionAttachSubsystem,
  ferrets: FerretDirectory,
): (call: CallContext) => Promise<ApiResponse> {
  return async call => {
    const id = pathFerret(call);
    await knownFerret(ferrets, id);
    try {
      return jsonResponse(await attach.resolve(id));
    } catch (error) {
      return refuse(error);
    }
  };
}
