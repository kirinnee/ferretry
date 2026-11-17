/**
 * THE INPUT CARD, AS DECISIONS (docs/input-requests.md, "The agenda card").
 *
 * Everything the card decides that is not drawing lives here as a pure function: whether Enter is offered and starts
 * ticked, what a Send carries, why Send is off, and which sentence a refusal becomes. The component only draws what
 * these return.
 *
 * NO FUNCTION HERE STORES A VALUE. The typed value comes in as an argument, goes out inside one
 * {@link InputDeliverBody} (padded) and is never kept.
 */
import { ASK_REFERENCE_SIGIL } from '@ferretry/core-asks/contract';
import {
  type InputCodeKey,
  type InputDeliverBody,
  type InputRequest,
  type InputRequestField,
  type InputRisk,
  type InputSettledSlotProps,
  type InputSavedOffer,
  inputValueProblem,
  padInputValue,
} from '../../contract/index.ts';

type Sensitivity = InputRequest['sensitivity'];

/** One value the card asks for: a request has one to four, each with its own sensitivity and its own risk flag. */
export interface InputCardField {
  /** The field's id in the request: the key its own state is kept under and the id a deliver names it by. */
  readonly key: string;
  readonly sensitivity: Sensitivity;
  readonly label: string;
  readonly risk?: InputRisk;
}

/** The fields of a request, in the order the daemon types them. */
export const fieldsOf = (request: InputRequest): readonly InputCardField[] =>
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
const needsWords = (request: InputRequest): string => {
  const kinds = new Set(request.fields.map(field => field.sensitivity));
  return kinds.has('secret') && kinds.has('plain') ? 'a login' : NEEDS[request.sensitivity];
};

/** `!A7 · Hadi needs a password` — the ask reference first, because it is how the owner names the card. */
export const titleWords = (request: InputRequest, agentName: string): string =>
  request.source === undefined
    ? `${ASK_REFERENCE_SIGIL}${request.agendaItemId} · ${agentName} needs ${needsWords(request)}`
    : `${ASK_REFERENCE_SIGIL}${request.agendaItemId} · ${agentName} wants to paste a sealed value`;

/** Where a value goes, as the owner writes it: `%terminal:dev`, `%browser:app`, or "the secret NAME". */
export const targetRef = (request: InputRequest): string =>
  request.target.kind === 'secret'
    ? `the secret ${request.target.key}`
    : `%${request.target.kind === 'page' ? 'browser' : 'terminal'}:${request.target.key}`;

const REOBSERVING = 'Ferretry is looking at the target again';

/** Why Send is off right now, or `undefined`. The RISK never appears here: it flags, it does not refuse. */
export const sendBlock = (request: InputRequest, now: number): string | undefined => {
  if (request.state !== 'pending') return 'This request is no longer waiting for a value.';
  if (Date.parse(request.expiresAt) <= now) return 'This request has expired.';
  if (request.observed === undefined || request.observedDigest === undefined) return REOBSERVING;
  return undefined;
};

/** Whether "Press Enter for me" is drawn at all: the agent presses it itself for `agent`. */
export const offersPressEnter = (request: InputRequest): boolean => request.submit !== 'agent';

/**
 * What the Enter tick starts as (I51): on for an owner default and for a terminal secret, off for a browser page and
 * for every other terminal value.
 */
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
const fieldProblem = (field: InputCardField, value: string): string | undefined =>
  value === '' ? undefined : inputValueProblem(value, field.sensitivity);

/**
 * What the card keeps of a typed field: whether it holds anything and what is wrong with it, never the value (the value
 * stays in the field's own node until Send).
 */
export interface FieldState {
  readonly filled: boolean;
  readonly problem: string | undefined;
}

/** The state a field is in after a value was typed; the value itself is not kept. */
export const fieldStateOf = (field: InputCardField, value: string): FieldState => ({
  filled: value !== '',
  problem: fieldProblem(field, value),
});

/** Whether Send may go: one typed value, or EVERY field of a larger card typed and fine. */
export const typedReady = (fields: readonly InputCardField[], states: Readonly<Record<string, FieldState>>): boolean =>
  fields.length > 0 &&
  fields.every(field => states[field.key]?.filled === true) &&
  (fields.length === 1 || fields.every(field => states[field.key]?.problem === undefined));

export interface TypedFieldsSend {
  readonly request: InputRequest;
  readonly fields: readonly InputCardField[];
  readonly values: Readonly<Record<string, string>>;
  readonly submit: boolean;
  readonly deliveryId: string;
}

export type BuiltBody =
  | { readonly ok: true; readonly body: InputDeliverBody }
  | { readonly ok: false; readonly problem: string };

const enterFor = (request: InputRequest, submit: boolean): boolean => offersPressEnter(request) && submit;

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

// ─── saved logins (docs/input-requests.md, "Saved logins") ────────────────────────────────────────────────────────────

/**
 * The saved accounts the daemon offers for this card, split the way the card draws them. The daemon decides what may be
 * offered (an account that holds every field, a code only where a code may be typed, nothing by hand on a page a sign-in
 * reaches through a provider) and in what order: this only reads its list. NOTHING HERE HOLDS A VALUE: an offer is an
 * account's handle, its label and the sign-in the tap would use, and the daemon opens the value itself at the write.
 */
export interface SavedChoices {
  /** Accounts the daemon matched to this target, the one-tap choice first. Each is one tap. */
  readonly matched: readonly InputSavedOffer[];
  /** Accounts the owner may pick by hand: behind "Use another account…", never the one-tap choice. */
  readonly other: readonly InputSavedOffer[];
}

/** What the card may offer from saved accounts, or `undefined` when it offers none (and a paste never does). */
export const savedChoices = (request: InputRequest): SavedChoices | undefined => {
  const offers = request.saved?.offers ?? [];
  if (request.source !== undefined || offers.length === 0) return undefined;
  const matched = offers.filter(offer => offer.matched);
  return {
    matched: [...matched.filter(offer => offer.primary === true), ...matched.filter(offer => offer.primary !== true)],
    other: offers.filter(offer => !offer.matched),
  };
};

/** Words for the button that opens the hand-picked accounts. */
export const OTHER_ACCOUNT_WORDS = 'Use another account…';

/** Words for the same button while the hand-picked accounts are drawn below it. */
export const HIDE_OTHER_ACCOUNTS_WORDS = 'Hide other accounts';

/** The account as the owner named it, with the username it holds when it has one ("GitHub · kirinnee"). */
export const offerWords = (offer: InputSavedOffer): string =>
  offer.username === undefined || offer.label.includes(`(${offer.username})`)
    ? offer.label
    : `${offer.label} · ${offer.username}`;

const FILLS_WORDS: Readonly<Record<InputSavedOffer['fills'], string>> = {
  password: 'types its password',
  totp: 'types a one-time code Ferretry makes',
  username: 'types its username',
};

/** What a tap on the offer would type, in words: the field's kind, never a value. */
export const offerFillsWords = (offer: InputSavedOffer): string => FILLS_WORDS[offer.fills];

const WHY_WORDS: Readonly<Record<NonNullable<InputSavedOffer['why']>, string>> = {
  ferret: 'The ferret named this account',
  project: 'The default for this project',
  folder: 'The default for this folder',
  site: 'The default for this site',
  only: 'The only account that signs in here',
};

/** Why the one-tap choice is first, when the daemon said. */
export const offerWhyWords = (offer: InputSavedOffer): string | undefined =>
  offer.why === undefined
    ? undefined
    : offer.why === 'project' && offer.project !== undefined
      ? `The default for ${offer.project}`
      : WHY_WORDS[offer.why];

/** Where a hand-picked account signs in, when that is somewhere else; `undefined` for one the daemon did not place. */
export const offerElsewhereWords = (offer: InputSavedOffer): string | undefined =>
  offer.elsewhere === undefined
    ? undefined
    : offer.elsewhere.length === 0
      ? 'Not linked to a site'
      : `Signs in at ${offer.elsewhere.join(', ')}`;

const PROVIDER_WORDS = { google: 'Google', github: 'GitHub', microsoft: 'Microsoft', apple: 'Apple' } as const;

/**
 * How the account this target is for signs in, when it is not a plain password: the owner reads that the ferret should
 * be on the provider's page ("Sign in with Google via “Google · kirin”"). `undefined` for a password sign-in.
 */
export const signInNote = (request: InputRequest): string | undefined => {
  const signIn = request.saved?.signIn;
  if (signIn === undefined || signIn.method.kind === 'password') return undefined;
  const provider = signIn.method.kind === 'sso' ? (signIn.method.name ?? 'SSO') : PROVIDER_WORDS[signIn.method.kind];
  return `Sign in with ${provider}${signIn.via === undefined ? '' : ` via “${signIn.via.label}”`}`;
};

/** The daemon's demotion of the one-tap: the page is signing in someone else than the account it would have used. */
export const differentFromWords = (request: InputRequest): string | undefined => {
  const other = request.saved?.differentFrom;
  return other === undefined ? undefined : `This looks like a different account from ${other.label}.`;
};

/**
 * What tapping a saved account sends: the account's handle and the sign-in it would use, never a value. The DAEMON opens
 * the value inside its use boundary and checks the offer again at the write, so a stale card cannot type from an account
 * that is no longer offered.
 */
export const offerBody = (
  request: InputRequest,
  offer: InputSavedOffer,
  submit: boolean,
  deliveryId: string,
  factor?: string,
): BuiltBody =>
  request.observedDigest === undefined
    ? { ok: false, problem: REOBSERVING }
    : {
        ok: true,
        body: {
          deliveryId,
          observedDigest: request.observedDigest,
          entry: offer.id,
          ...(offer.signIn === undefined ? {} : { signIn: offer.signIn }),
          // The id of one of the offer's own 2FA keys: the code is made inside the daemon and typed, never sent here.
          ...(factor === undefined ? {} : { factor }),
          submit: enterFor(request, submit),
        },
      };

/** What the card says once a saved account was used: the account and the target, never the value. */
export const offerSentWords = (request: InputRequest, offer: InputSavedOffer, factor?: string): string => {
  const key = factor === undefined ? undefined : offer.codes?.find(each => each.factor === factor);
  return key === undefined
    ? `Used ${offerWords(offer)} for ${targetRef(request)}.`
    : `Used a code from Ferretry (${key.label}) for ${offerWords(offer)} at ${targetRef(request)}.`;
};

// ─── codes Ferretry makes (docs/input-requests.md, "Codes Ferretry makes") ─────────────────────────────────────────────

/** Said once under the code buttons: the password and the code now come from one place. */
export const LOGIN_ONE_FACTOR_WARNING = 'Password and code both come from this machine: together they are one factor.';

/**
 * Whether this card asks for a one-time code and nothing stronger. The FIELDS decide, not the offer: a field the daemon
 * upgraded to a secret or a private value is not a place a code Ferretry made may go, so such a card draws no code
 * button and offers no seed setup.
 */
export const asksCode = (request: InputRequest): boolean => {
  if (request.source !== undefined) return false;
  const fields = request.fields;
  return (
    fields.some(field => field.sensitivity === 'code') &&
    fields.every(field => field.sensitivity === 'code' || field.sensitivity === 'plain')
  );
};

/** The keys an offer makes codes from, as the card may draw them: none on a card that asks for more than a code. */
export const offerCodes = (request: InputRequest, offer: InputSavedOffer): readonly InputCodeKey[] =>
  asksCode(request) && offer.matched ? (offer.codes ?? []) : [];

/** "Use code from Ferretry · Authy backup": the owner's own label of the key, never a code. */
export const codeButtonWords = (key: InputCodeKey): string => `Use code from Ferretry · ${key.label}`;

/** What the last code made from this key came to, or `undefined` when it was never tried. */
export const codeCheckedWords = (key: InputCodeKey): string | undefined =>
  key.checked === 'worked' ? 'worked last time' : key.checked === 'failed' ? 'did not work last time' : undefined;

/** The one-factor line, drawn once under the buttons when the card draws any code button at all. */
export const oneFactorLine = (request: InputRequest, offers: readonly InputSavedOffer[]): string | undefined =>
  offers.some(offer => offerCodes(request, offer).length > 0) ? LOGIN_ONE_FACTOR_WARNING : undefined;

/** Whether the card offers the codes slot: only while it waits and asks a code, with the daemon's saved facts. */
export const offersCodesSlot = (request: InputRequest): boolean =>
  request.state === 'pending' && request.saved !== undefined && asksCode(request);

/** What the settled card hands a panel in the slot after it: ids and names the owner saw on the card. */
export const settledSlotProps = (request: InputRequest, offer: InputSavedOffer): InputSettledSlotProps => ({
  ferret: request.sessionId,
  request: request.id,
  entry: offer.id,
  ...(offer.signIn === undefined ? {} : { signIn: offer.signIn }),
  ...(request.saved?.match === undefined ? {} : { place: request.saved.match }),
  ...(request.saved?.project === undefined ? {} : { project: request.saved.project }),
  ...(offer.primary === true && offer.why === 'project' ? { projectDefault: true as const } : {}),
});

// ─── a paste of a secure copy (docs/secure-copy.md) ───────────────────────────────────────────────────────────────────

/** What allowing a paste sends: no value, only that the owner allows the copy the REQUEST names. */
export const sealedBody = (request: InputRequest, submit: boolean, deliveryId: string): BuiltBody =>
  request.observedDigest === undefined
    ? { ok: false, problem: REOBSERVING }
    : {
        ok: true,
        body: { deliveryId, observedDigest: request.observedDigest, sealed: true, submit: enterFor(request, submit) },
      };

/** "sealed:vercel_token": the handle a paste card pastes (where it came from is a row of its own). */
export const pastedWords = (request: InputRequest): string | undefined =>
  request.source === undefined ? undefined : `sealed:${request.source.name}`;

const SOURCE_KIND_WORDS: Readonly<Record<'browser' | 'clipboard' | 'command', string>> = {
  command: 'what a command printed',
  browser: 'text read from a page',
  clipboard: 'what a page copied to its clipboard',
};

/**
 * How much was copied and what kind of place it came from: "40 characters · what a command printed". A count and a kind
 * only, both the daemon's: never a prefix, a digest or a class of the value (a handle is all the owner is shown of it).
 */
export const pasteSize = (request: InputRequest): string | undefined => {
  const source = request.source;
  if (source === undefined) return undefined;
  const kind = SOURCE_KIND_WORDS[source.from.kind];
  return source.length === undefined
    ? kind
    : `${source.length} ${source.length === 1 ? 'character' : 'characters'} · ${kind}`;
};

/**
 * The page field a paste goes into, as the DAEMON saw it (its type and name), with the ferret's own label kept apart as
 * the claim it is. Nothing for a terminal or the secret store.
 */
export const pasteField = (request: InputRequest): string | undefined => {
  const facts = request.observed;
  if (request.source === undefined || facts?.kind !== 'page') return undefined;
  const asked = request.fields[0];
  const seen = facts.fields.find(each => each.fieldId === asked?.id) ?? facts.fields[0];
  if (seen === undefined) return undefined;
  const name = seen.field.name ?? seen.field.id;
  return [
    `${seen.field.type ?? seen.field.tag} field`,
    ...(name === undefined ? [] : [`name “${name}”`]),
    ...(asked === undefined || asked.label === '' ? [] : [`The ferret calls it “${asked.label}”`]),
  ].join(' · ');
};

/** Whether allowing this paste overwrites a secret the store holds now: the old value is gone for good. */
export const replacesSecret = (request: InputRequest): boolean =>
  request.source !== undefined && request.observed?.kind === 'secret' && request.observed.exists;

/** The approval's own words: replacing a secret says so. */
export const allowWords = (request: InputRequest): string =>
  replacesSecret(request) ? 'Replace secret' : 'Allow paste';

/** The two ends of a paste card: where its copy came from, and what the daemon saw reading the destination. */
export function pasteRoute(request: InputRequest): { readonly from: string; readonly to: string } | undefined {
  const source = request.source;
  if (source === undefined) return undefined;
  const from =
    source.from.kind === 'command'
      ? `${source.from.path ?? source.from.program ?? 'a command'} (what it printed)`
      : `${source.from.origin ?? 'a page'}${source.from.kind === 'clipboard' ? ' (its clipboard)' : ''}`;
  const facts = request.observed;
  const to =
    facts === undefined
      ? targetRef(request)
      : facts.kind === 'terminal'
        ? `${facts.foreground.comm} in %terminal:${request.target.key}`
        : facts.kind === 'secret'
          ? `the secret ${facts.name}${facts.exists ? ' (replacing its value)' : ' (new)'}`
          : `a field on ${facts.origin}`;
  return { from, to };
}

// ─── a failed Send, in words ──────────────────────────────────────────────────────────────────────────────────────────

/** The error codes the input routes answer a deliver with (the daemon's `INPUT_ERROR_CODES`, the ones a Send reads). */
const CODES = {
  targetRebound: 'target_rebound',
  targetChanged: 'target_changed',
  targetUnsettled: 'target_unsettled',
  alreadyDelivered: 'already_delivered',
  takenOver: 'taken_over',
} as const;

type InputFailureKind = 'changed' | 'already' | 'gone' | 'ended' | 'refused' | 'unknown';

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

const SURFACE_WORDS: Readonly<Record<InputRequest['target']['kind'], string>> = {
  page: 'page',
  terminal: 'terminal',
  secret: 'secret store',
};

const reboundWords = (kind: InputRequest['target']['kind'] | undefined): string =>
  kind === 'terminal'
    ? 'The terminal redrew its prompt. Check it and send again.'
    : kind === 'secret'
      ? 'The secret store changed. Check the input and send again.'
      : 'The page changed. Check the input and send again.';

const REFUSED_WORDS = 'The daemon refused this.';

/** A typed value shorter than this is not compared with a message: a one-letter value would blank every sentence. */
const MIN_GUARDED_VALUE_LENGTH = 8;

/**
 * Whether a message holds a value the owner typed, compared in memory only (the values are never logged, stored or
 * sent): any typed value of {@link MIN_GUARDED_VALUE_LENGTH} characters or more that appears in it, however it is
 * surrounded.
 */
const carriesTypedValue = (message: string, typed: readonly string[]): boolean =>
  typed.some(value => value.length >= MIN_GUARDED_VALUE_LENGTH && message.includes(value));

/**
 * A failed Send as a sentence, and what kind it is: each needs a different next step from the owner. `kind` is the
 * card's target, so a sentence names the page or the terminal it is about. The message of a refusal that carries a
 * status is shown as it came, unless it holds a value the owner typed (`typed`, values of 8+ characters): then the
 * card says the fixed sentence instead, never the message cut or masked. The daemon's own message never carries a
 * value; the guard is for an answer that is not the daemon's (a proxy, an intermediary) and echoes the body.
 */
export const inputFailure = (
  error: unknown,
  kind?: InputRequest['target']['kind'],
  typed: readonly string[] = [],
): InputFailure => {
  const failure = (error !== null && typeof error === 'object' ? error : {}) as HttpFailure;
  const said = typeof failure.message === 'string' && failure.message !== '' ? failure.message : undefined;
  const message = said !== undefined && carriesTypedValue(said, typed) ? undefined : said;
  const surface = kind === undefined ? 'target' : SURFACE_WORDS[kind];
  if (failure.status === 409 && failure.code === CODES.targetRebound)
    return { kind: 'changed', definitive: true, text: reboundWords(kind) };
  if (failure.status === 409 && failure.code === CODES.targetChanged)
    return {
      kind: 'changed',
      definitive: true,
      text: `The ${surface} is no longer what this input showed, so nothing was typed. Check the input before you send again.`,
    };
  if (failure.status === 410 && failure.code === CODES.targetUnsettled)
    return {
      kind: 'gone',
      definitive: true,
      text: `The ${surface} kept changing, so nothing was typed and this request ended. Ask the ferret to request again.`,
    };
  // The daemon closed the request as refused (a person took the page over): nothing was pasted and it can never be, so
  // the card settles instead of offering another try. Its own sentence says why.
  if (failure.status === 409 && failure.code === CODES.takenOver)
    return {
      kind: 'ended',
      definitive: true,
      text: message ?? 'A person has taken over that page, so nothing was pasted into it.',
    };
  if (failure.status === 409 && failure.code === CODES.alreadyDelivered)
    return { kind: 'already', definitive: true, text: 'This was already sent.' };
  if (failure.status === 410)
    return { kind: 'gone', definitive: true, text: 'This request expired or was cancelled. Nothing was typed.' };
  if (typeof failure.status === 'number') return { kind: 'refused', definitive: true, text: message ?? REFUSED_WORDS };
  return {
    kind: 'unknown',
    definitive: false,
    text: 'Could not reach the machine. If you press Send again it will not type twice.',
  };
};

/** What the card says once a Send was answered. */
export const sentWords = (request: InputRequest): string => `Sent to ${targetRef(request)}.`;
