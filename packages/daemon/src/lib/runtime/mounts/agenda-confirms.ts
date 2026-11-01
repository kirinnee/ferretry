/**
 * The agenda's half of confirming a held configuration change (docs/agenda.md § Confirming a configuration
 * change): raising an item that names one, and acting on the owner's answer to it.
 *
 * ## Raising
 *
 * `fy agenda add --confirms warden.yaml` names a FILE. The daemon looks up that file's held edit and records
 * its digest (the etag) and its words on the item; the caller never supplies either, so a card can only ever
 * show a change that is really held. A file with no held change is refused.
 *
 * ## Answering
 *
 * Only the owner answers: a ferret's answer is refused before anything is touched, here and again in the
 * state machine. Allow and Discard change then pass the config files' own rule for a held edit
 * (`heldEditRefusal`): the file's capability on `configure`, never an agent's credential, and for Allow from a
 * governed device a passkey proved for this act. Allow confirms the held edit ONLY if it still has the digest
 * the card recorded; when it moved on, nothing is confirmed, the card is restated with the change as it now
 * is, and the answer is refused `409 config_changed` so the owner reads it again. Deny touches nothing.
 *
 * ## Recorded
 *
 * Allow and Discard change are written to the security log as `fleet.configured` (`config-confirm` /
 * `config-discard`, `via: agenda`) with the caller the boundary proved — a paired device by its id — exactly as
 * `POST /v1/config/confirm` is, so a loosening confirmed from a card is as visible as one confirmed in Settings.
 * The route serves every agenda answer, so the handler records the act rather than a rule on the route. Deny is
 * not recorded: it changes nothing.
 */
import {
  AGENDA_CONFIG_CHANGED_CODE,
  type AgendaActionRequest,
  type AgendaId,
  type AgendaResponse,
  type ConfigPending,
} from '@ferretry/protocol';
import { ApiError } from '../../api/error.ts';
import type { ApiResponse } from '../../api/http.ts';
import type { RouteContext } from '../../api/route.ts';
import {
  type AgendaActor,
  type AgendaService,
  type ConfirmationDecision,
  confirmationCard,
  confirmationDecision,
  confirmationNote,
  confirmationPremise,
  confirmsChange,
  type RaiseAgendaRequest,
} from '../../agenda/index.ts';
import { type AuditedRoutesSubsystem, recordHandlerAct } from '../../audit/index.ts';
import type { ConfigFilesService } from '../../config-files/index.ts';
import { heldEditRefusal, spendHeldEditProof } from './config-files.ts';

/** The held configuration edits, as a confirmation needs them. */
export interface AgendaConfigPort {
  /** The edit to `path` waiting for the owner, or `undefined` when none is. */
  held(path: string): Promise<ConfigPending | undefined>;
  /** Put the held edit with this digest into effect; `false` when there is no such held edit any more. */
  confirm(path: string, etag: string): Promise<boolean>;
  /** Drop the held edit with this digest; `false` when there is no such held edit any more. */
  discard(path: string, etag: string): Promise<boolean>;
  /** Writes one act on a held edit to the security log. Absent on a daemon that keeps none. Never throws. */
  record?(context: RouteContext, act: HeldEditAct, outcome: 'succeeded' | 'refused'): Promise<void>;
}

/** What the security log calls an act on a held edit, as the Settings door's rule names it. */
type HeldEditAct = 'config-confirm' | 'config-discard';

/** The port over this daemon's configuration files. */
export function configFilesConfirmations(
  service: Pick<ConfigFilesService, 'status' | 'confirm' | 'discard'>,
  audit?: AuditedRoutesSubsystem,
): AgendaConfigPort {
  return {
    held: async path => (await service.status()).pending.find(pending => pending.path === path),
    confirm: async (path, etag) => await service.confirm(path, etag),
    discard: async (path, etag) => await service.discard(path, etag),
    ...(audit === undefined
      ? {}
      : {
          record: async (context, act, outcome) =>
            await recordHandlerAct(audit, context, {
              event: 'fleet.configured',
              outcome,
              detail: { action: act, via: 'agenda' },
            }),
        }),
  };
}

type AddRequest = Extract<AgendaActionRequest, { action: 'add' }>;

/**
 * The raise an add request is: as sent, or — when it names a file to confirm — with that file's held edit
 * recorded on it and the confirmation's card and premise written by the daemon.
 */
export async function raiseRequestOf(
  request: AddRequest,
  config: AgendaConfigPort | undefined,
): Promise<RaiseAgendaRequest> {
  const { action: _action, confirms: path, ...raise } = request;
  if (path === undefined) return raise;
  if (config === undefined) {
    throw new ApiError(400, 'this daemon cannot confirm configuration changes from the agenda', 'invalid');
  }
  const held = await config.held(path);
  if (held === undefined) {
    throw new ApiError(
      400,
      `${path} has no change waiting for the owner's confirmation (fy config status lists them); nothing was raised`,
      'invalid',
    );
  }
  return {
    ...raise,
    ...confirmationCard(path),
    premise: confirmationPremise(path, held.changes, raise.premise),
    confirms: { path: held.path, etag: held.etag, changes: [...held.changes] },
  };
}

/** What answering a confirmation came to: go on and record the answer with this note, or this response. */
export type ConfirmationOutcome =
  | { readonly proceed: true; readonly note: string }
  | { readonly proceed: false; readonly response: ApiResponse };

export interface ConfirmationAnswer {
  readonly sessionId: string;
  readonly id: AgendaId;
  readonly response: AgendaResponse;
  readonly note?: string | undefined;
  readonly actor: AgendaActor;
}

const VERB: Readonly<Record<Exclude<ConfirmationDecision, 'deny'>, string>> = {
  allow: 'confirmed',
  discard: 'discarded',
};

/**
 * Act on the owner's answer to an item that confirms a held change. `undefined` when the item is not one
 * (or is not open), or when the answer decides nothing about the change: the answer is then recorded as any
 * other. Throws the refusals.
 */
export async function answerConfirmation(
  agenda: Pick<AgendaService, 'list' | 'restateConfirms' | 'resolve'>,
  config: AgendaConfigPort,
  context: RouteContext,
  answer: ConfirmationAnswer,
): Promise<ConfirmationOutcome | undefined> {
  const board = await agenda.list(answer.sessionId);
  const item = board.ok ? board.value.items.find(each => each.id === answer.id) : undefined;
  if (item === undefined || !confirmsChange(item)) return undefined;
  const { path, etag } = item.confirms;
  if (answer.actor.kind !== 'human') {
    throw new ApiError(
      403,
      `only the owner answers ${answer.id}: it decides a change to ${path}, and a ferret never confirms one`,
      'forbidden',
    );
  }
  const decision = confirmationDecision(answer.response);
  if (decision === undefined) return undefined;
  if (decision === 'deny') return { proceed: true, note: confirmationNote(decision, path, answer.note) };
  const act: HeldEditAct = decision === 'allow' ? 'config-confirm' : 'config-discard';
  const refused = heldEditRefusal(context, path, decision === 'allow' ? 'confirm' : 'discard');
  if (refused !== undefined) {
    await config.record?.(context, act, 'refused');
    return { proceed: false, response: refused };
  }
  const done = decision === 'allow' ? await config.confirm(path, etag) : await config.discard(path, etag);
  // Recorded as the act's own outcome: a held edit that moved on changed nothing, so it is a refusal.
  await config.record?.(context, act, done ? 'succeeded' : 'refused');
  if (done) {
    if (decision === 'allow') spendHeldEditProof(context);
    return { proceed: true, note: confirmationNote(decision, path, answer.note) };
  }
  // The held edit moved on since the card was raised: never act on a change the owner did not see.
  const now = await config.held(path);
  if (now !== undefined) {
    await agenda.restateConfirms(
      answer.sessionId,
      answer.id,
      { path, etag: now.etag, changes: [...now.changes] },
      confirmationPremise(path, now.changes),
    );
    throw new ApiError(
      409,
      `${path} was edited after ${answer.id} was raised, so nothing was ${VERB[decision]}: the card now shows the change as it is — read it and answer again`,
      AGENDA_CONFIG_CHANGED_CODE,
    );
  }
  await agenda.resolve(
    answer.sessionId,
    answer.id,
    answer.actor,
    `nothing was ${VERB[decision]}: ${path} has no change waiting any more`,
  );
  throw new ApiError(
    409,
    `${path} has no change waiting any more (it was confirmed, reverted or no longer loosens anything), so nothing was ${VERB[decision]}; ${answer.id} is closed`,
    AGENDA_CONFIG_CHANGED_CODE,
  );
}
