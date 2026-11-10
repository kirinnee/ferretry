/**
 * THE INPUT CARD, AS DECISIONS (docs/input-requests.md, "The agenda card").
 *
 * Everything the card decides that is not drawing lives here as a pure function: whether Enter is offered and starts
 * ticked, what a Send carries, why Send is off, and which sentence a refusal becomes. The component only draws what
 * these return.
 *
 * NO FUNCTION HERE STORES A VALUE. The typed value comes in as an argument, goes out inside one
 * {@link InputDeliverBodyView} (padded) and is never kept.
 */
import {
  type InputRequestField,
  type InputRequestView,
  type InputDeliverBodyView,
  type InputRisk,
  inputValueProblem,
  padInputValue,
} from './input-wire.ts';

type Sensitivity = InputRequestView['sensitivity'];

/** One value the card asks for: a request has one to four, each with its own sensitivity and its own risk flag. */
export interface InputCardField {
  /** The field's id in the request: the key its own state is kept under and the id a deliver names it by. */
  readonly key: string;
  readonly sensitivity: Sensitivity;
  readonly label: string;
  readonly risk?: InputRisk;
}

/** The fields of a request, in the order the daemon types them. */
export const fieldsOf = (request: InputRequestView): readonly InputCardField[] =>
  request.fields.map((field: InputRequestField) => ({
    key: field.id,
    sensitivity: field.sensitivity,
    label: field.label,
    ...(field.risk === undefined ? {} : { risk: field.risk }),
  }));

const NEEDS: Readonly<Record<Sensitivity, string>> = {
  secret: 'a password',
  private: 'a private value',
  code: 'a code',
  plain: 'an answer',
};

/** A card with a secret AND a plain field is a login; every other card is named by its strongest field. */
const needsWords = (request: InputRequestView): string => {
  const kinds = new Set(request.fields.map(field => field.sensitivity));
  return kinds.has('secret') && kinds.has('plain') ? 'a login' : NEEDS[request.sensitivity];
};

/** `!A7 · Hadi needs a password` — the ask reference first, because it is how the owner names the card. */
export const titleWords = (request: InputRequestView, agentName: string): string =>
  `!${request.agendaItemId} · ${agentName} needs ${needsWords(request)}`;

/** Where a value goes, as the owner writes it: `%terminal:dev`, `%browser:app`, or "the secret NAME". */
export const targetRef = (request: InputRequestView): string =>
  request.target.kind === 'secret'
    ? `the secret ${request.target.key}`
    : `%${request.target.kind === 'page' ? 'browser' : 'terminal'}:${request.target.key}`;

const REOBSERVING = 'Ferretry is looking at the target again';

/** Why Send is off right now, or `undefined`. The RISK never appears here: it flags, it does not refuse. */
export const sendBlock = (request: InputRequestView, now: number): string | undefined => {
  if (request.state !== 'pending') return 'This request is no longer waiting for a value.';
  if (Date.parse(request.expiresAt) <= now) return 'This request has expired.';
  if (request.observed === undefined || request.observedDigest === undefined) return REOBSERVING;
  return undefined;
};

/** Whether "Press Enter for me" is drawn at all: the agent presses it itself for `agent`. */
export const offersPressEnter = (request: InputRequestView): boolean => request.submit !== 'agent';

/**
 * What the Enter tick starts as (I51): on for an owner default and for a terminal secret, off for a browser page and
 * for every other terminal value.
 */
export const defaultSubmit = (request: InputRequestView): boolean =>
  request.submit === 'owner-default' ||
  (request.submit === 'offer-owner' && request.target.kind === 'terminal' && request.sensitivity === 'secret');

const pad2 = (value: number): string => String(value).padStart(2, '0');

/** `8m 05s left`, or `expired`. */
export const expiryWords = (expiresAt: string, now: number): string => {
  const seconds = Math.floor((Date.parse(expiresAt) - now) / 1_000);
  if (!(seconds > 0)) return 'expired';
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (hours > 0) return `${hours}h ${pad2(minutes)}m left`;
  return `${minutes}m ${pad2(seconds % 60)}s left`;
};

/** The value field's HTML attributes, by sensitivity. Every one stops a keyboard "helping". */
export interface FieldAttributes {
  readonly type: 'password' | 'text';
  readonly autoComplete: string;
  readonly inputMode?: 'numeric';
}

export const fieldAttributes = (sensitivity: Sensitivity, revealed: boolean): FieldAttributes => {
  if (sensitivity === 'secret') return { type: revealed ? 'text' : 'password', autoComplete: 'current-password' };
  if (sensitivity === 'private')
    return { type: revealed ? 'text' : 'password', autoComplete: 'one-time-code', inputMode: 'numeric' };
  // A one-time code is not secret: it shows as it is typed, and may hold letters, so no numeric pad.
  if (sensitivity === 'code') return { type: 'text', autoComplete: 'one-time-code' };
  return { type: 'text', autoComplete: 'off' };
};

/** Whether a field hides what is typed behind a Show toggle: not a plain value, and not a one-time code. */
export const revealable = (sensitivity: Sensitivity): boolean => sensitivity === 'secret' || sensitivity === 'private';

const PLAIN_NOTICE = 'Not secret: the ferret can see this value.';

/** The red flag drawn beside a PLAIN field: the daemon's own sentence when it gave one. */
export const plainFlagWords = (field: InputCardField): string => field.risk?.reason ?? PLAIN_NOTICE;

/** What is wrong with a typed value of this field, shown under it; nothing for an empty one. */
export const fieldProblem = (field: InputCardField, value: string): string | undefined =>
  value === '' ? undefined : inputValueProblem(value, field.sensitivity);

/** Whether Send may go: one typed value, or EVERY field of a larger card typed and fine. */
export const typedReady = (fields: readonly InputCardField[], values: Readonly<Record<string, string>>): boolean =>
  fields.length > 0 &&
  fields.every(field => (values[field.key] ?? '') !== '') &&
  (fields.length === 1 || fields.every(field => fieldProblem(field, values[field.key] ?? '') === undefined));

export interface TypedFieldsSend {
  readonly request: InputRequestView;
  readonly fields: readonly InputCardField[];
  readonly values: Readonly<Record<string, string>>;
  readonly submit: boolean;
  readonly deliveryId: string;
}

export type BuiltBody =
  | { readonly ok: true; readonly body: InputDeliverBodyView }
  | { readonly ok: false; readonly problem: string };

const enterFor = (request: InputRequestView, submit: boolean): boolean => offersPressEnter(request) && submit;

/**
 * What typing the values of a card sends: a card of one field sends `padded`, a card of several sends each value padded
 * on its own, named by its field. The value is padded here and nowhere else. A field left empty or refused is a
 * sentence, not a throw.
 */
export const typedBody = ({ request, fields, values, submit, deliveryId }: TypedFieldsSend): BuiltBody => {
  const typed: { field: string; padded: string }[] = [];
  for (const field of fields) {
    const value = values[field.key] ?? '';
    if (value === '') return { ok: false, problem: `Type ${field.label} too.` };
    const problem = inputValueProblem(value, field.sensitivity);
    if (problem !== undefined)
      return { ok: false, problem: fields.length === 1 ? problem : `${field.label}: ${problem}` };
    typed.push({ field: field.key, padded: padInputValue(value) });
  }
  if (request.observedDigest === undefined) return { ok: false, problem: REOBSERVING };
  const only = typed.length === 1 ? typed[0] : undefined;
  return {
    ok: true,
    body: {
      deliveryId,
      observedDigest: request.observedDigest,
      submit: enterFor(request, submit),
      ...(only === undefined ? { fields: typed } : { padded: only.padded }),
    },
  };
};

// ─── a failed Send, in words ──────────────────────────────────────────────────────────────────────────────────────────

/** The error codes the input routes answer a deliver with (the daemon's `INPUT_ERROR_CODES`, the ones a Send reads). */
const CODES = {
  targetRebound: 'target_rebound',
  targetChanged: 'target_changed',
  targetUnsettled: 'target_unsettled',
  alreadyDelivered: 'already_delivered',
} as const;

type InputFailureKind = 'changed' | 'already' | 'gone' | 'refused' | 'unknown';

export interface InputFailure {
  readonly kind: InputFailureKind;
  readonly text: string;
  /** The daemon answered: nothing was typed twice, so a retry takes a new delivery id. */
  readonly definitive: boolean;
}

interface HttpFailure {
  readonly status?: unknown;
  readonly code?: unknown;
  readonly message?: unknown;
}

const SURFACE_WORDS: Readonly<Record<InputRequestView['target']['kind'], string>> = {
  page: 'page',
  terminal: 'terminal',
  secret: 'secret store',
};

const reboundWords = (kind: InputRequestView['target']['kind'] | undefined): string =>
  kind === 'terminal'
    ? 'The terminal redrew its prompt. Check it and send again.'
    : kind === 'secret'
      ? 'The secret store changed. Check the card and send again.'
      : 'The page changed. Check the card and send again.';

/**
 * A failed Send as a sentence, and what kind it is: each needs a different next step from the owner. `kind` is the
 * card's target, so a sentence names the page or the terminal it is about. The daemon's own message is shown only for a
 * refusal it answered, and it never carries a value.
 */
export const inputFailure = (error: unknown, kind?: InputRequestView['target']['kind']): InputFailure => {
  const failure = (error !== null && typeof error === 'object' ? error : {}) as HttpFailure;
  const message = typeof failure.message === 'string' && failure.message !== '' ? failure.message : undefined;
  const surface = kind === undefined ? 'target' : SURFACE_WORDS[kind];
  if (failure.status === 409 && failure.code === CODES.targetRebound)
    return { kind: 'changed', definitive: true, text: reboundWords(kind) };
  if (failure.status === 409 && failure.code === CODES.targetChanged)
    return {
      kind: 'changed',
      definitive: true,
      text: `The ${surface} is no longer what this card showed, so nothing was typed. Check the card before you send again.`,
    };
  if (failure.status === 410 && failure.code === CODES.targetUnsettled)
    return {
      kind: 'gone',
      definitive: true,
      text: `The ${surface} kept changing, so nothing was typed and this request ended. Ask the ferret to request again.`,
    };
  if (failure.status === 409 && failure.code === CODES.alreadyDelivered)
    return { kind: 'already', definitive: true, text: 'This was already sent.' };
  if (failure.status === 410)
    return { kind: 'gone', definitive: true, text: 'This request expired or was cancelled. Nothing was typed.' };
  if (typeof failure.status === 'number')
    return { kind: 'refused', definitive: true, text: message ?? 'The daemon refused this.' };
  return {
    kind: 'unknown',
    definitive: false,
    text: 'Could not reach the machine. If you press Send again it will not type twice.',
  };
};

/** What the card says once a Send was answered. */
export const sentWords = (request: InputRequestView): string => `Sent to ${targetRef(request)}.`;
