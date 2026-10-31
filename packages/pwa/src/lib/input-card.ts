/**
 * THE INPUT CARD, AS DECISIONS (docs/input-requests.md, "The agenda card").
 *
 * Everything the card decides that is not drawing lives here as a pure function: which saved login may be the
 * one-tap choice, what a Send carries, whether Save may be ticked, and which sentence a refusal becomes. The
 * component only draws what these return.
 *
 * NO FUNCTION HERE STORES A VALUE. The typed value comes in as an argument, goes out inside one
 * {@link InputDeliverBody} (padded) and is never kept. A saved login is only ever named: the DAEMON resolves
 * its value, so a saved value never passes through the app.
 */

import {
  type InputBrowserFieldFacts,
  type InputDeliverBody,
  type InputDeliverResult,
  type InputRequest,
  type InputRisk,
  type InputSaved,
  type InputSavedOffer,
  type InputSensitivity,
  inputValueProblem,
  LOGIN_LABEL_MAX_LENGTH,
  LOGIN_PASSWORD_MIN_LENGTH,
  LoginEntryIdSchema,
  padInputValue,
} from '@ferretry/protocol';
import { grantRefusalNotice } from './grants.ts';

/**
 * One value the card asks for: a request has one to four (a login's email and password sit on ONE card), each
 * with its own sensitivity and its own risk flag.
 */
export interface InputCardField {
  /** The field's id in the request: the key its own state is kept under and the id a deliver names it by. */
  readonly key: string;
  readonly requestId: string;
  readonly sensitivity: InputSensitivity;
  readonly label: string;
  readonly risk?: InputRisk;
  /** Only a card of ONE field: "Save as" keeps one typed value, and a login's several are never saved together. */
  readonly saved?: InputSaved;
}

/** The fields of a request, in the order the daemon types them. */
export const fieldsOf = (request: InputRequest): readonly InputCardField[] =>
  request.fields.map(field => ({
    key: field.id,
    requestId: request.id,
    sensitivity: field.sensitivity,
    label: field.label,
    ...(field.risk === undefined ? {} : { risk: field.risk }),
    ...(request.fields.length === 1 && request.saved !== undefined ? { saved: request.saved } : {}),
  }));

const NEEDS: Readonly<Record<InputSensitivity, string>> = {
  secret: 'a password',
  private: 'a code',
  plain: 'an answer',
};

/** A card with a secret AND a plain field is a login; every other card is named by its strongest field. */
const needsWords = (request: InputRequest): string => {
  const kinds = new Set(request.fields.map(field => field.sensitivity));
  return kinds.has('secret') && kinds.has('plain') ? 'a login' : NEEDS[request.sensitivity];
};

/** `!A7 · Hadi needs a password` — the agenda reference first, because it is how the owner names the card. */
export const titleWords = (request: InputRequest, agentName: string): string =>
  `!${request.agendaItemId} · ${agentName} needs ${needsWords(request)}`;

/** `Step 2 · after !A7` on a card that follows another of a multi-step login; `undefined` on a lone card. */
export const chainWords = (request: InputRequest): string | undefined =>
  request.chain === undefined ? undefined : `Step ${request.step ?? 2} · after !${request.chain}`;

/** The target as the owner writes a reference to it: `%terminal:dev`. */
export const targetRef = (request: InputRequest): string => `%${request.target.kind}:${request.target.key}`;

export interface SplitOffers {
  /** The one-tap choice: the first offer the DAEMON matched to this target. Never a hinted one by itself. */
  readonly primary: InputSavedOffer | undefined;
  /** Every other offer, in the daemon's order, selectable by hand. */
  readonly others: readonly InputSavedOffer[];
}

/**
 * Only an offer the daemon marked `matched` may be the one-tap primary. `hinted` (the ferret named it) is a tag,
 * never a promotion: a hinted offer that is not matched stays among the others.
 */
export const splitOffers = (saved: InputSaved | undefined): SplitOffers => {
  const offers = saved?.offers ?? [];
  const primary = offers.find(offer => offer.matched);
  return { primary, others: offers.filter(offer => offer !== primary) };
};

/** The button words for a saved login: `Use saved sudo on kirin-box`. */
export const savedButtonWords = (offer: InputSavedOffer): string => `Use saved ${offer.label}`;

/** The username line under it, unless the label already says it. */
export const offerUsername = (offer: InputSavedOffer): string | undefined =>
  offer.username === undefined || offer.label.includes(offer.username) ? undefined : offer.username;

export const REOBSERVING = 'Ferretry is looking at the target again';

/** Why Send and Use are off right now, or `undefined`. The RISK never appears here: it flags, it does not refuse. */
export const sendBlock = (request: InputRequest, now: number): string | undefined => {
  if (request.state !== 'pending') return 'This request is no longer waiting for a value.';
  if (Date.parse(request.expiresAt) <= now) return 'This request has expired.';
  if (request.observed === undefined || request.observedDigest === undefined) return REOBSERVING;
  return undefined;
};

/** Whether "Press Enter for me" is drawn at all: the agent presses it itself for `agent`. */
export const offersPressEnter = (request: InputRequest): boolean => request.submit !== 'agent';

/** What the Enter tick starts as: on for an owner default and for a terminal secret. */
export const defaultSubmit = (request: InputRequest): boolean =>
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

const ECHO_WORDS = { off: 'typing hidden', on: 'typing shows', unknown: 'echo unknown' } as const;

/** What the daemon found for one field of a page, beside the label the card gives it. */
interface ObservedFieldWords {
  readonly key: string;
  readonly label: string;
  /** `password field`, `email field`, and `in a frame from <host>` when the field is not in the page's own frame. */
  readonly words: string;
}

export interface ObservedWords {
  /** The program, or the page's host. */
  readonly program: string;
  /** Typing hidden or showing for a terminal; https or not for a page. */
  readonly echo: string;
  /** The prompt's own line, as the daemon read it; absent for a page. */
  readonly promptLine?: string;
  readonly recognised: boolean;
  /** A page's fields, one line each; absent for a terminal. */
  readonly fields?: readonly ObservedFieldWords[];
  /** The captcha warning when the page shows one. */
  readonly challenge?: string;
}

export const CAPTCHA_WARNING =
  'This page is showing a captcha. Take over the browser and complete it yourself; Ferretry never solves one.';

const parsedOrigin = (origin: string): URL | undefined => (URL.canParse(origin) ? new URL(origin) : undefined);

const hostOf = (origin: string): string => parsedOrigin(origin)?.host ?? origin;

const schemeWords = (origin: string, secure: boolean): string => {
  if (!secure) return 'not secure (http)';
  return parsedOrigin(origin)?.protocol === 'http:' ? 'http on this machine' : 'https';
};

const fieldWords = (field: InputBrowserFieldFacts, pageOrigin: string): string => {
  const kind = field.field.type === 'password' ? 'password' : (field.field.type ?? field.field.tag);
  const frame = field.frameOrigin === pageOrigin ? '' : ` in a frame from ${hostOf(field.frameOrigin)}`;
  return `${kind} field${frame}`;
};

/** What the daemon saw, in words: drawn large, because the agent's own sentence is not evidence. */
export const observedWords = (request: InputRequest): ObservedWords | undefined => {
  const facts = request.observed;
  if (facts === undefined) return undefined;
  if (facts.kind === 'terminal')
    return {
      program: facts.foreground.comm,
      echo: ECHO_WORDS[facts.echo],
      promptLine: facts.promptLine,
      recognised: facts.recognisedConsumer,
    };
  return {
    program: hostOf(facts.origin),
    echo: schemeWords(facts.origin, facts.secure),
    recognised: true,
    fields: facts.fields.map(found => ({
      key: found.fieldId,
      label: request.fields.find(field => field.id === found.fieldId)?.label ?? found.fieldId,
      words: fieldWords(found, facts.origin),
    })),
    ...(facts.challenge === undefined ? {} : { challenge: CAPTCHA_WARNING }),
  };
};

/** The value field's HTML attributes, by sensitivity. Every one stops a keyboard "helping". */
export interface FieldAttributes {
  readonly type: 'password' | 'text';
  readonly autoComplete: string;
  readonly inputMode?: 'numeric';
}

export const fieldAttributes = (sensitivity: InputSensitivity, revealed: boolean): FieldAttributes => {
  if (sensitivity === 'secret') return { type: revealed ? 'text' : 'password', autoComplete: 'current-password' };
  if (sensitivity === 'private')
    return { type: revealed ? 'text' : 'password', autoComplete: 'one-time-code', inputMode: 'numeric' };
  return { type: 'text', autoComplete: 'off' };
};

export const PLAIN_NOTICE = 'Not secret: the ferret can see this value.';

/** The red flag drawn beside a PLAIN field: the daemon's own sentence when it gave one. */
export const plainFlagWords = (field: InputCardField): string => field.risk?.reason ?? PLAIN_NOTICE;

/**
 * A secret or private field's own risk line, only when it says something the header's flag does not. A plain
 * field has its red flag beside it instead.
 */
export const fieldRiskLine = (request: InputRequest, field: InputCardField): InputRisk | undefined => {
  if (field.sensitivity === 'plain' || field.risk === undefined) return undefined;
  if (!showsHeaderRisk(request)) return field.risk;
  const header = request.risk;
  return header !== undefined && header.level === field.risk.level && header.reason === field.risk.reason
    ? undefined
    : field.risk;
};

/**
 * Whether the card's own risk line is drawn above the fields. A card of several fields flags each field where it
 * is instead, so the worst of them is not said twice (once on top and again beside the field it came from).
 */
export const showsHeaderRisk = (request: InputRequest): boolean => request.fields.length === 1;

/** What is wrong with a typed value of this field, shown under it; nothing for an empty one. */
export const fieldProblem = (field: InputCardField, value: string): string | undefined =>
  value === '' ? undefined : inputValueProblem(value, field.sensitivity);

/** Whether Send may go: one typed value, or EVERY field of a larger card typed and fine. */
export const typedReady = (fields: readonly InputCardField[], values: Readonly<Record<string, string>>): boolean =>
  fields.length > 0 &&
  fields.every(field => (values[field.key] ?? '') !== '') &&
  (fields.length === 1 || fields.every(field => fieldProblem(field, values[field.key] ?? '') === undefined));

/** The handle as it is typed: uppercase letters, digits and underscores only. */
export const normalizeHandle = (text: string): string =>
  text
    .toUpperCase()
    .replaceAll(/[^A-Z0-9_]/gu, '_')
    .slice(0, 64);

export interface SaveDraft {
  readonly enabled: boolean;
  readonly label: string;
  readonly id: string;
}

/** Where "Save as" starts: off, with the daemon's suggestion. */
export const initialSaveDraft = (saved: InputSaved | undefined): SaveDraft => ({
  enabled: false,
  label: saved?.suggest?.label ?? '',
  id: saved?.suggest?.id ?? '',
});

/** Save is drawn only when a typed value of this kind is ever kept (a one-time code is not). */
export const offersSave = (field: InputCardField): boolean => field.saved?.saves !== undefined;

/** The existing entry a handle would overwrite, if any: the card then says "updates <label>". */
export const updatedEntry = (saved: InputSaved | undefined, id: string): InputSavedOffer | undefined =>
  saved?.offers.find(offer => offer.id === id);

export const SAVE_TOO_SHORT = `Too short to save: at least ${LOGIN_PASSWORD_MIN_LENGTH} characters. You can still send it.`;

/**
 * Why the typed value cannot be saved, or `undefined`. It can always be SENT: a short value is only refused a
 * place in the vault, because a very short value would mask ordinary words.
 */
export const saveBlock = (field: InputCardField, value: string): string | undefined => {
  if (!offersSave(field)) return undefined;
  if (field.saved?.saves === 'password' && value.length < LOGIN_PASSWORD_MIN_LENGTH) return SAVE_TOO_SHORT;
  return undefined;
};

/** The sentence under the Save fields when what is typed in them will not do, or `undefined`. */
export const saveDraftProblem = (draft: SaveDraft): string | undefined => {
  if (!draft.enabled) return undefined;
  if (draft.label.trim() === '') return 'Give it a label.';
  if (draft.label.trim().length > LOGIN_LABEL_MAX_LENGTH)
    return `A label is at most ${LOGIN_LABEL_MAX_LENGTH} characters.`;
  if (!LoginEntryIdSchema.safeParse(draft.id).success)
    return 'A handle is uppercase letters, digits and underscores, starting with a letter.';
  return undefined;
};

/** Whether the typed value will be kept: ticked, long enough, and the label and handle are fine. */
const savesTypedValue = (field: InputCardField, value: string, draft: SaveDraft): boolean =>
  offersSave(field) && draft.enabled && saveBlock(field, value) === undefined && saveDraftProblem(draft) === undefined;

export interface TypedSend {
  readonly request: InputRequest;
  readonly field: InputCardField;
  readonly value: string;
  readonly submit: boolean;
  readonly save: SaveDraft;
  readonly deliveryId: string;
}

export type BuiltBody =
  | { readonly ok: true; readonly body: InputDeliverBody }
  | { readonly ok: false; readonly problem: string };

const enterFor = (request: InputRequest, submit: boolean): boolean => offersPressEnter(request) && submit;

/**
 * What typing a value sends. The value is padded here and nowhere else; `save` rides only when the field is
 * one that is ever saved and the value may be. A refusal is a sentence, never a throw.
 */
export const typedBody = ({ request, field, value, submit, save, deliveryId }: TypedSend): BuiltBody => {
  const problem = inputValueProblem(value, field.sensitivity);
  if (problem !== undefined) return { ok: false, problem };
  if (request.observedDigest === undefined) return { ok: false, problem: REOBSERVING };
  const keeps = savesTypedValue(field, value, save);
  return {
    ok: true,
    body: {
      deliveryId,
      observedDigest: request.observedDigest,
      padded: padInputValue(value),
      submit: enterFor(request, submit),
      ...(keeps ? { save: { entry: save.id, label: save.label.trim() } } : {}),
    },
  };
};

export interface TypedFieldsSend {
  readonly request: InputRequest;
  readonly fields: readonly InputCardField[];
  readonly values: Readonly<Record<string, string>>;
  readonly submit: boolean;
  readonly deliveryId: string;
}

/**
 * What typing the values of a card of several fields sends: each value padded on its own, named by its field.
 * Never `save`: that only goes with the one-field form. A field left empty or refused is a sentence, not a throw.
 */
export const typedFieldsBody = ({ request, fields, values, submit, deliveryId }: TypedFieldsSend): BuiltBody => {
  const typed: { field: string; padded: string }[] = [];
  for (const field of fields) {
    const value = values[field.key] ?? '';
    if (value === '') return { ok: false, problem: `Type ${field.label} too.` };
    const problem = inputValueProblem(value, field.sensitivity);
    if (problem !== undefined) return { ok: false, problem: `${field.label}: ${problem}` };
    typed.push({ field: field.key, padded: padInputValue(value) });
  }
  if (request.observedDigest === undefined) return { ok: false, problem: REOBSERVING };
  return {
    ok: true,
    body: {
      deliveryId,
      observedDigest: request.observedDigest,
      fields: typed,
      submit: enterFor(request, submit),
    },
  };
};

/** What tapping a saved login sends: its handle, and nothing else about it. */
export const savedBody = (request: InputRequest, entry: string, submit: boolean, deliveryId: string): BuiltBody =>
  request.observedDigest === undefined
    ? { ok: false, problem: REOBSERVING }
    : {
        ok: true,
        body: { deliveryId, observedDigest: request.observedDigest, entry, submit: enterFor(request, submit) },
      };

type InputFailureKind = 'changed' | 'already' | 'gone' | 'refused' | 'step-up' | 'unknown';

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

/** A failed Send as a sentence, and what kind it is: each needs a different next step from the owner. */
export const inputFailure = (error: unknown): InputFailure => {
  const failure = (error !== null && typeof error === 'object' ? error : {}) as HttpFailure;
  const message = typeof failure.message === 'string' && failure.message !== '' ? failure.message : undefined;
  if (failure.status === 409 && failure.code === 'target_changed')
    return {
      kind: 'changed',
      definitive: true,
      text: 'The target changed since this card was drawn, so nothing was typed. Ferretry is looking at it again.',
    };
  if (failure.status === 409 && failure.code === 'already_delivered')
    return { kind: 'already', definitive: true, text: 'This was already sent.' };
  if (failure.status === 410)
    return { kind: 'gone', definitive: true, text: 'This request expired or was cancelled. Nothing was typed.' };
  const grant = grantRefusalNotice(error);
  if (grant !== null)
    return {
      kind: 'refused',
      definitive: true,
      text: grant.detail === '' ? grant.guidance.explanation : `${grant.guidance.explanation} ${grant.detail}`,
    };
  if (typeof failure.status === 'number')
    return { kind: 'refused', definitive: true, text: message ?? 'The daemon refused this.' };
  return {
    kind: 'unknown',
    definitive: false,
    text: 'Could not reach the machine. If you press Send again it will not type twice.',
  };
};

/** What Save came to, in the daemon's words, or `undefined` when none was asked for. */
export const savedOutcomeWords = (result: InputDeliverResult, label: string): string | undefined =>
  result.saved === undefined
    ? undefined
    : result.saved.ok
      ? `Saved as ${label}.`
      : `It was typed, but not saved: ${result.saved.problem ?? 'the daemon could not save it'}. Save it from Settings instead.`;
