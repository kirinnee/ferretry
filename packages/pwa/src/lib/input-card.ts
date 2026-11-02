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
  type AccountList,
  type AccountSummary,
  factorAskWords,
  INPUT_ERROR_CODES,
  type InputBrowserFieldFacts,
  type InputCodeKey,
  type InputDeliverBody,
  type InputDeliverResult,
  type InputRequest,
  type InputRisk,
  type InputSaved,
  type InputSavedOffer,
  type InputSensitivity,
  type InputShot,
  inputValueProblem,
  LOGIN_LABEL_MAX_LENGTH,
  LOGIN_ONE_FACTOR_WARNING,
  LOGIN_PASSWORD_MIN_LENGTH,
  LOGIN_USERNAME_MAX_LENGTH,
  LoginEntryIdSchema,
  loginMethodSentence,
  PlaceKeySchema,
  type PutAccountDefaultRequest,
  padInputValue,
  signInChoiceWords,
  type SignInId,
  type TwoFactorId,
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
  private: 'a private value',
  code: 'a code',
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

/** Where a value goes, as the owner writes it: `%terminal:dev`, `%browser:app`, or "the secret NAME" (no sigil names a secret). */
export const targetRef = (request: InputRequest): string =>
  request.target.kind === 'secret'
    ? `the secret ${request.target.key}`
    : `%${request.target.kind}:${request.target.key}`;

export interface SplitOffers {
  /** The one-tap choice: the offer the DAEMON marked `primary`. Never "the first matched one", never a hinted one. */
  readonly primary: InputSavedOffer | undefined;
  /** Every other offer, in the daemon's order, selectable by hand. */
  readonly others: readonly InputSavedOffer[];
}

/**
 * Only the offer the daemon marked `primary` (and `matched`) is the one-tap choice (docs/input-requests.md). The
 * daemon alone knows the owner's defaults and the ferret's hint, so a card from an older daemon, which sends no
 * `primary`, has no one-tap: the owner picks. `hinted` (the ferret named it) is a tag, never a promotion.
 */
export const splitOffers = (saved: InputSaved | undefined): SplitOffers => {
  const offers = saved?.offers ?? [];
  const primary = offers.find(offer => offer.primary === true && offer.matched);
  return { primary, others: offers.filter(offer => offer !== primary) };
};

/** The few words under the one-tap button: why the daemon put this account first ("Default for ferretry"). */
export const choiceReasonWords = (
  saved: InputSaved | undefined,
  primary: InputSavedOffer | undefined,
): string | undefined => {
  if (primary?.why === undefined) return undefined;
  if (primary.why === 'site' && saved?.match === undefined) return 'Default for this site';
  return signInChoiceWords(
    { why: primary.why, ...(primary.project === undefined ? {} : { project: primary.project }) },
    saved?.match ?? '',
  );
};

/**
 * The matched accounts the owner must choose between: two or more sign in here and the daemon chose none (no
 * `primary`). Empty when one is chosen, when only one matches, or when the daemon sent no `signIn` on its offers
 * (an older daemon, whose card keeps the typed field and the list as they were).
 */
export const pickOneOffers = (saved: InputSaved | undefined): readonly InputSavedOffer[] => {
  const offers = saved?.offers ?? [];
  if (offers.some(offer => offer.primary === true)) return [];
  const matched = offers.filter(offer => offer.matched && offer.signIn !== undefined);
  return matched.length >= 2 ? matched : [];
};

/** What a quiet "Always use for <project>" would write after a hand-tap on `offer`, or `undefined` when it is not offered. */
export interface AlwaysUse {
  readonly project: string;
  /** The tapped account's label and the place the default is for, to say what the button would do. */
  readonly label: string;
  readonly key: string;
  readonly body: PutAccountDefaultRequest;
}

/**
 * "Always use for <project>" is offered after the owner hand-tapped a MATCHED account that is not already the
 * project's default, on a card whose project the DAEMON resolved (`saved.project`, never the ferret's word) and
 * whose key is a place. The line goes through the owner route, where it is in effect at once as the owner's own act.
 * Nothing here chooses an account for anyone: the tap on this button is the permission.
 */
export const alwaysUseFor = (saved: InputSaved | undefined, tapped: InputSavedOffer): AlwaysUse | undefined => {
  const project = saved?.project;
  if (project === undefined || saved?.match === undefined) return undefined;
  if (!tapped.matched || tapped.signIn === undefined) return undefined;
  if (tapped.primary === true && tapped.why === 'project') return undefined;
  const key = PlaceKeySchema.safeParse(saved.match);
  if (!key.success) return undefined;
  return {
    project: project.name,
    label: tapped.label,
    key: key.data,
    body: { scope: 'projects', within: project.id, key: key.data, account: tapped.id },
  };
};

/** The one line on a card whose saved login signs in through a provider, or `undefined` for a password. */
export const signInWords = (saved: InputSaved | undefined): string | undefined =>
  saved?.signIn === undefined ? undefined : loginMethodSentence(saved.signIn.method, saved.signIn.via?.label);

/** The button words for a saved login: `Use saved sudo on kirin-box`. */
export const savedButtonWords = (offer: InputSavedOffer): string => `Use saved ${offer.label}`;

/** The username line under it, unless the label already says it. */
export const offerUsername = (offer: InputSavedOffer): string | undefined =>
  offer.username === undefined || offer.label.includes(offer.username) ? undefined : offer.username;

export const REOBSERVING = 'Ferretry is looking at the target again';

/** One field's box on a page shot, in percent of the shot, so it scales with the picture. */
export interface ShotBox {
  readonly key: string;
  readonly label: string;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

const clamp = (value: number): number => Math.min(100, Math.max(0, value));

/**
 * Where each field the daemon found sits on the picture of the page: its box, as the BROWSER reported it,
 * relative to the part of the page the picture shows. A field outside the picture, or with no size, gets no box.
 */
export const shotBoxes = (request: InputRequest, fields: readonly InputCardField[], shot: InputShot): ShotBox[] => {
  const facts = request.observed;
  if (facts?.kind !== 'browser' || !(shot.clip.w > 0) || !(shot.clip.h > 0)) return [];
  const boxes: ShotBox[] = [];
  for (const field of fields) {
    const seen = facts.fields.find(each => each.fieldId === field.key);
    if (seen === undefined || seen.box.w <= 0 || seen.box.h <= 0) continue;
    const left = clamp(((seen.box.x - shot.clip.x) / shot.clip.w) * 100);
    const top = clamp(((seen.box.y - shot.clip.y) / shot.clip.h) * 100);
    const right = clamp(((seen.box.x + seen.box.w - shot.clip.x) / shot.clip.w) * 100);
    const bottom = clamp(((seen.box.y + seen.box.h - shot.clip.y) / shot.clip.h) * 100);
    if (right <= left || bottom <= top) continue;
    boxes.push({ key: field.key, label: field.label, left, top, width: right - left, height: bottom - top });
  }
  return boxes;
};

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
  /**
   * `password field`, `email field`, `in a frame from <host>` when the field is not in the page's own frame, and
   * `covered or off screen` when something else is on top of it.
   */
  readonly words: string;
}

export interface ObservedWords {
  /** The program, the page's host, or the secret's name. */
  readonly program: string;
  /** What it is doing: "is asking", or for a secret "in the secret store". */
  readonly verb?: string;
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
  return `${kind} field${frame}${field.covered === true ? ', covered or off screen' : ''}`;
};

/** What the daemon saw, in words: drawn large, because the agent's own sentence is not evidence. */
export const observedWords = (request: InputRequest): ObservedWords | undefined => {
  const facts = request.observed;
  if (facts === undefined) return undefined;
  if (facts.kind === 'secret')
    return {
      program: facts.name,
      verb: 'in the secret store',
      echo: facts.exists ? 'replaces its value' : 'a new secret',
      recognised: true,
    };
  if (facts.kind === 'terminal')
    return {
      // Unproved, the name is only what the process calls itself (a shell can call itself sudo): the card says so.
      program: facts.program ?? facts.foreground.comm,
      ...(facts.program === undefined ? { verb: 'is asking · unverified' } : {}),
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
  // A one-time code is not secret: it shows as it is typed, and may hold letters (a device code), so no numeric pad.
  if (sensitivity === 'code') return { type: 'text', autoComplete: 'one-time-code' };
  return { type: 'text', autoComplete: 'off' };
};

/** Whether a field hides what is typed behind a Show toggle: not a plain value, and not a one-time code. */
export const revealable = (sensitivity: InputSensitivity): boolean =>
  sensitivity === 'secret' || sensitivity === 'private';

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
  /**
   * The owner's choice: keep it in a NEW account (`label`, `id`), or UPDATE the account the card is about
   * (`saved.update`), replacing its password. `undefined`: an older daemon that sends neither choice, so the name in
   * the terminal decides, as it always did.
   */
  readonly mode: 'new' | 'update' | undefined;
  /** The account's name, as the owner reads it ("Google · a@gmail.com"). The protocol calls it the label. */
  readonly label: string;
  /** The name in the terminal (`fy account …`): derived from the name until the owner edits it under "More". */
  readonly id: string;
  /** The account's username: pre-filled from who the page is signing in, editable. An account IS username + password. */
  readonly username: string;
  readonly labelEdited: boolean;
  readonly idEdited: boolean;
}

/** Two usernames name the same person: equal ignoring case and surrounding space, or both absent. */
const sameUsername = (left: string | undefined, right: string | undefined): boolean =>
  (left?.trim().toLowerCase() ?? '') === (right?.trim().toLowerCase() ?? '');

/** Where the new account's name starts: the place ("Google"), from the daemon's suggestion minus who it named. */
const placeOf = (saved: InputSaved): string => {
  const label = saved.newAccount?.label ?? '';
  const typed = saved.typedUsername;
  return typed !== undefined && label.endsWith(` · ${typed}`) ? label.slice(0, -` · ${typed}`.length) : label;
};

/** A name in the terminal from a name: capitals, digits and underscores, starting with a letter; `_2`… when taken. */
const terminalNameOf = (label: string, taken: ReadonlySet<string>): string => {
  const words = label
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]+/gu, '_')
    .replaceAll(/^_+|_+$/gu, '');
  const base = (/^[A-Z]/u.test(words) ? words : `LOGIN_${words}`).slice(0, 64).replace(/_+$/u, '');
  let id = base;
  for (let count = 2; taken.has(id); count += 1) id = `${base.slice(0, 60).replace(/_+$/u, '')}_${String(count)}`;
  return id;
};

/** The names a new account's terminal name must not take: every account the card knows of. */
const takenIds = (saved: InputSaved | undefined): ReadonlySet<string> =>
  new Set([...(saved?.offers ?? []).map(offer => offer.id), ...(saved?.update === undefined ? [] : [saved.update.id])]);

/** A new account's name and terminal name for `username`, unless the owner has edited them. */
const freshNames = (saved: InputSaved, draft: SaveDraft, username: string): Pick<SaveDraft, 'label' | 'id'> => {
  const suggested = saved.newAccount;
  const who = username.trim();
  const label = draft.labelEdited
    ? draft.label
    : sameUsername(who, saved.typedUsername) && suggested !== undefined
      ? suggested.label
      : (who === '' ? placeOf(saved) : `${placeOf(saved)} · ${who}`).slice(0, LOGIN_LABEL_MAX_LENGTH);
  const id = draft.idEdited
    ? draft.id
    : !draft.labelEdited && sameUsername(who, saved.typedUsername) && suggested !== undefined
      ? suggested.id
      : terminalNameOf(label, takenIds(saved));
  return { label, id };
};

/**
 * Where "Save as" starts: off. The Username is who the page is signing in (what the ferret typed in its identifier box)
 * or, failing that, the account the card is about. It starts on UPDATE only when that username IS the account's own
 * (two absent usernames, a sudo password, count as the same); on NEW otherwise, and always after the owner pressed
 * "Type a different one" over a one-tap (`typedInstead`) or when the page is signing in someone else (`differentFrom`).
 * An account with another username is never the start, and never written by a card.
 */
export const initialSaveDraft = (
  saved: InputSaved | undefined,
  options: { readonly typedInstead?: boolean } = {},
): SaveDraft => {
  const blank = { enabled: false, labelEdited: false, idEdited: false } as const;
  if (saved?.newAccount === undefined)
    return {
      ...blank,
      mode: undefined,
      label: saved?.suggest?.label ?? '',
      id: saved?.suggest?.id ?? '',
      username: saved?.typedUsername ?? '',
    };
  const update = saved.update;
  const typedInstead = options.typedInstead === true;
  // Only who the page said it signs in: a new account is never pre-filled with another account's username.
  const username = saved.typedUsername ?? '';
  // Update is the start ONLY when the page said who it signs in and that is the account's own username: an unknown
  // identity never starts on Update, whatever the account holds.
  const updates =
    update !== undefined &&
    update.username !== undefined &&
    saved.typedUsername !== undefined &&
    !typedInstead &&
    saved.differentFrom === undefined &&
    sameUsername(saved.typedUsername, update.username);
  if (updates) return { ...blank, mode: 'update', label: update.label, id: update.id, username };
  const draft: SaveDraft = { ...blank, mode: 'new', label: '', id: '', username };
  return { ...draft, ...freshNames(saved, draft, username) };
};

/**
 * The owner switched between "Save as a new account" and "Update <account>". Update takes the account's own username
 * when it has one, so an update can never carry another person's; New names the account from the username.
 */
export const switchSaveMode = (saved: InputSaved | undefined, draft: SaveDraft, mode: 'new' | 'update'): SaveDraft => {
  const update = saved?.update;
  if (mode === 'update' && update !== undefined)
    return { ...draft, mode, label: update.label, id: update.id, username: update.username ?? draft.username };
  if (mode === 'new' && saved?.newAccount !== undefined) {
    // Back from an update that took the account's own username: the new account is who the page is signing in again.
    const username = usernameLocked(saved, draft) ? (saved.typedUsername ?? '') : draft.username;
    const next: SaveDraft = { ...draft, mode, username, labelEdited: false, idEdited: false };
    return { ...next, ...freshNames(saved, next, username) };
  }
  return draft;
};

/** The owner typed a username: a new account's name follows it until the owner names the account themselves. */
export const editSaveUsername = (saved: InputSaved | undefined, draft: SaveDraft, username: string): SaveDraft =>
  draft.mode === 'new' && saved !== undefined
    ? { ...draft, username, ...freshNames(saved, draft, username) }
    : { ...draft, username };

/** The owner named the account: its name in the terminal follows until they edit that under "More". */
export const editSaveLabel = (saved: InputSaved | undefined, draft: SaveDraft, label: string): SaveDraft => {
  const next: SaveDraft = { ...draft, label, labelEdited: true };
  return draft.idEdited || draft.mode === undefined ? next : { ...next, id: terminalNameOf(label, takenIds(saved)) };
};

/**
 * Whether Save as shows the Username box: every card that does not type a username itself. On "Update" it is read-only
 * when the account already has one (a card never changes it); `false` for an older daemon's draft.
 */
export const savesUsername = (fields: readonly InputCardField[], draft: SaveDraft): boolean =>
  draft.mode !== undefined && !fields.some(field => field.sensitivity === 'plain');

/** Whether the Username box may be edited: not on "Update" of an account that has its own. */
export const usernameLocked = (saved: InputSaved | undefined, draft: SaveDraft): boolean =>
  draft.mode === 'update' && saved?.update?.username !== undefined;

/** The plain line under "Update <account>": what saving there does, said before the owner sends. */
export const updateWords = (update: NonNullable<InputSaved['update']>): string =>
  `Replaces the saved password of ${named(update)}.`;

/** The "Update" choice's words: the account, and that it is the same person. */
export const updateChoiceWords = (saved: InputSaved | undefined): string | undefined => {
  const update = saved?.update;
  if (update === undefined) return undefined;
  // "(same username)" only when the page said who it signs in and it is that account's: never a sameness nobody saw.
  const same =
    update.username !== undefined &&
    saved?.typedUsername !== undefined &&
    sameUsername(saved.typedUsername, update.username);
  if (!same) return `Update ${named(update)}`;
  return update.label.includes(update.username as string)
    ? `Update ${update.label} (same username)`
    : `Update ${update.label} (same username, ${update.username as string})`;
};

/** An account as a sentence names it: its name, and its username when the name does not already say it. */
const named = (account: { readonly label: string; readonly username?: string | undefined }): string =>
  account.username === undefined || account.label.includes(account.username)
    ? account.label
    : `${account.label} (${account.username})`;

/**
 * The line a card shows when the one-tap was taken away because the page is signing in someone else, or `undefined`.
 * The typed username is the ferret's word: it is said as what the page shows, never as who the owner is.
 */
export const differentAccountWords = (saved: InputSaved | undefined): string | undefined => {
  const other = saved?.differentFrom;
  if (other === undefined) return undefined;
  const typed = saved?.typedUsername;
  const page = typed === undefined ? '' : ` The page is signing in ${typed}`;
  return other.username === undefined
    ? `This looks like a different account.${page}${page === '' ? '' : ','} and ${other.label} has no username saved, so pick it only if it is the same one.`
    : `This looks like a different account.${page}${page === '' ? '' : ','} not ${named(other)}.`;
};

/**
 * The account a card is for, named from the SECRETS-GATED accounts listing (`accounts`, read only by a device with
 * `secrets.use`), never from the card route: the one-tap account, or the one "Update" would write, else who the page
 * is signing in. `undefined` without the listing, so a device that may not read accounts sees the place-only title.
 */
export const cardAccountWords = (
  saved: InputSaved | undefined,
  accounts: AccountList | undefined,
): string | undefined => {
  if (accounts === undefined || saved === undefined || saved.differentFrom !== undefined) return undefined;
  const id = saved.offers.find(offer => offer.primary === true)?.id ?? saved.update?.id;
  const account = id === undefined ? undefined : accounts.accounts.find(each => each.id === id);
  return account === undefined ? undefined : named(account);
};

/**
 * The card's title naming whose sign-in it is, for a device that may read accounts (`accounts`, the secrets-gated
 * listing): `!A7 · Hadi needs a password for Google · a@gmail.com` from the listing, or, when the page said who it signs
 * in and no account is the card's, `… needs a password, signing in b@x.com as typed on the page` — the ferret's word,
 * said as such. `undefined` without the listing: the place-only title.
 */
export const accountTitleWords = (
  request: InputRequest,
  agentName: string,
  accounts: AccountList | undefined,
): string | undefined => {
  if (accounts === undefined) return undefined;
  const account = cardAccountWords(request.saved, accounts);
  if (account !== undefined) return `${titleWords(request, agentName)} for ${account}`;
  const typed = request.saved?.typedUsername;
  return typed === undefined
    ? undefined
    : `${titleWords(request, agentName)}, signing in ${typed} as typed on the page`;
};

/** Save is drawn only when a typed value of this kind is ever kept (a one-time code is not). */
const offersSave = (field: InputCardField): boolean => field.saved?.saves !== undefined;

/** The existing entry a handle would overwrite, if any: the card then says "updates <label>". */
export const updatedEntry = (saved: InputSaved | undefined, id: string): InputSavedOffer | undefined =>
  saved?.offers.find(offer => offer.id === id);

export const SAVE_TOO_SHORT = `Not saved: a saved password is at least ${LOGIN_PASSWORD_MIN_LENGTH} characters. Send types it without saving it.`;

/**
 * Why the typed value cannot be saved, or `undefined`. It can always be SENT: a short value is only refused a
 * place in the vault, because a very short value would mask ordinary words.
 */
export const saveBlock = (field: InputCardField, value: string): string | undefined => {
  if (!offersSave(field)) return undefined;
  if (field.saved?.saves === 'password' && value.length < LOGIN_PASSWORD_MIN_LENGTH) return SAVE_TOO_SHORT;
  return undefined;
};

/**
 * Whether the card offers "Save as": one field of a kind that is kept, or a login card the daemon can keep as ONE
 * saved login (its username and password together; `request.saved.saves` says so).
 */
export const cardOffersSave = (request: InputRequest, fields: readonly InputCardField[]): boolean => {
  const [only] = fields;
  return fields.length === 1 && only !== undefined ? offersSave(only) : request.saved?.saves !== undefined;
};

/** Why the card's typed values cannot be saved, or `undefined`: a password that would be kept is too short. */
export const cardSaveBlock = (
  request: InputRequest,
  fields: readonly InputCardField[],
  values: Readonly<Record<string, string>>,
): string | undefined => {
  const [only] = fields;
  if (fields.length === 1 && only !== undefined) return saveBlock(only, values[only.key] ?? '');
  if (!cardOffersSave(request, fields)) return undefined;
  return fields.some(
    field => field.sensitivity === 'secret' && (values[field.key] ?? '').length < LOGIN_PASSWORD_MIN_LENGTH,
  )
    ? SAVE_TOO_SHORT
    : undefined;
};

/** The sentence under the Save fields when what is typed in them will not do, or `undefined`. */
export const saveDraftProblem = (draft: SaveDraft, saved?: InputSaved): string | undefined => {
  if (!draft.enabled) return undefined;
  if (draft.label.trim() === '') return 'Give the account a name.';
  if (draft.label.trim().length > LOGIN_LABEL_MAX_LENGTH)
    return `A name is at most ${LOGIN_LABEL_MAX_LENGTH} characters.`;
  if (!LoginEntryIdSchema.safeParse(draft.id).success)
    return 'The name in the terminal (under More) is capital letters, digits and underscores, starting with a letter.';
  const username = draft.username.trim();
  if (username.length > LOGIN_USERNAME_MAX_LENGTH || /[\p{Cc}\p{Cf}]/u.test(username))
    return 'That username cannot be kept: one line, at most 256 characters.';
  if (draft.mode === 'new' && saved?.offers.some(offer => offer.id === draft.id) === true)
    return `Another account is already called ${draft.id} in the terminal: change it under More.`;
  return undefined;
};

/** What `save` a Send carries for a draft that is kept: the owner's choice, and the username only where it is asked. */
const saveOf = (
  draft: SaveDraft,
  saved: InputSaved | undefined,
  fields: readonly InputCardField[],
): NonNullable<InputDeliverBody['save']> => {
  const username = draft.username.trim();
  return {
    entry: draft.id,
    label: draft.label.trim(),
    ...(draft.mode === undefined ? {} : { mode: draft.mode }),
    // An update never carries another username: one the account has stays, and the daemon refuses any other.
    ...(username !== '' && savesUsername(fields, draft) && !usernameLocked(saved, draft) ? { username } : {}),
  };
};

/** Whether the typed value will be kept: ticked, long enough, and its names are fine. */
const savesTypedValue = (field: InputCardField, value: string, draft: SaveDraft, saved?: InputSaved): boolean =>
  offersSave(field) &&
  draft.enabled &&
  saveBlock(field, value) === undefined &&
  saveDraftProblem(draft, saved) === undefined;

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
  const keeps = savesTypedValue(field, value, save, request.saved);
  return {
    ok: true,
    body: {
      deliveryId,
      observedDigest: request.observedDigest,
      padded: padInputValue(value),
      submit: enterFor(request, submit),
      ...(keeps ? { save: saveOf(save, request.saved, [field]) } : {}),
    },
  };
};

export interface TypedFieldsSend {
  readonly request: InputRequest;
  readonly fields: readonly InputCardField[];
  readonly values: Readonly<Record<string, string>>;
  readonly submit: boolean;
  readonly deliveryId: string;
  /** "Save as": the card's username and password kept together, when ticked and fine. */
  readonly save?: SaveDraft;
}

/**
 * What typing the values of a card of several fields sends: each value padded on its own, named by its field.
 * Never `save`: that only goes with the one-field form. A field left empty or refused is a sentence, not a throw.
 */
export const typedFieldsBody = ({ request, fields, values, submit, deliveryId, save }: TypedFieldsSend): BuiltBody => {
  const typed: { field: string; padded: string }[] = [];
  for (const field of fields) {
    const value = values[field.key] ?? '';
    if (value === '') return { ok: false, problem: `Type ${field.label} too.` };
    const problem = inputValueProblem(value, field.sensitivity);
    if (problem !== undefined) return { ok: false, problem: `${field.label}: ${problem}` };
    typed.push({ field: field.key, padded: padInputValue(value) });
  }
  if (request.observedDigest === undefined) return { ok: false, problem: REOBSERVING };
  const keeps =
    save !== undefined &&
    save.enabled &&
    cardOffersSave(request, fields) &&
    cardSaveBlock(request, fields, values) === undefined &&
    saveDraftProblem(save, request.saved) === undefined;
  return {
    ok: true,
    body: {
      deliveryId,
      observedDigest: request.observedDigest,
      fields: typed,
      submit: enterFor(request, submit),
      ...(keeps ? { save: saveOf(save, request.saved, fields) } : {}),
    },
  };
};

/** What tapping a saved login sends: its handle, and nothing else about it. */
export const savedBody = (
  request: InputRequest,
  entry: string,
  submit: boolean,
  deliveryId: string,
  use: { readonly signIn?: SignInId; readonly factor?: TwoFactorId } = {},
): BuiltBody =>
  request.observedDigest === undefined
    ? { ok: false, problem: REOBSERVING }
    : {
        ok: true,
        body: {
          deliveryId,
          observedDigest: request.observedDigest,
          entry,
          ...(use.signIn === undefined ? {} : { signIn: use.signIn }),
          ...(use.factor === undefined ? {} : { factor: use.factor }),
          submit: enterFor(request, submit),
        },
      };

/** One "Use code from Ferretry" button: the key is the OWNER's label for it, and a past result is a plain badge. */
export const codeButtonWords = (key: InputCodeKey): string => `Use code from Ferretry · ${key.label}`;

/** What the last code made from a key came to, as the daemon saw it; `undefined` when it was never tried. */
export const codeCheckedWords = (key: InputCodeKey): string | undefined =>
  key.checked === 'worked' ? 'worked last time' : key.checked === 'failed' ? 'did not work last time' : undefined;

/**
 * A code card's title, from the account's keys (`factorAskWords`): the OWNER's words about where the code goes, never
 * a ferret's. With no account to read (an older daemon, an unreadable list) the plain title stands.
 */
export const codeTitleWords = (request: InputRequest, agentName: string, account: AccountSummary): string =>
  `!${request.agendaItemId} · ${agentName} · ${factorAskWords(account.factors, account)}`;

/** The line under every "Use code from Ferretry" button: the password and the code both come from this machine. */
export const oneFactorLine = (offer: InputSavedOffer | undefined): string | undefined =>
  offer?.codes === undefined ? undefined : LOGIN_ONE_FACTOR_WARNING;

/** What allowing a paste sends: no value, only that the owner allows the copy the REQUEST names (docs/secure-copy.md). */
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

/** What the card calls the surface a value goes into, in the sentences a failed Send is told in. */
const SURFACE_WORDS: Readonly<Record<InputRequest['target']['kind'], string>> = {
  browser: 'page',
  terminal: 'terminal',
  secret: 'secret store',
};

/**
 * The words for a card the daemon REDREW: the target changed under it but is still the same field or prompt, so the
 * daemon looked again, took a new picture and asks the owner to check it. Nothing was typed and nothing counted.
 */
const reboundWords = (kind: InputRequest['target']['kind'] | undefined): string =>
  kind === 'terminal'
    ? 'The terminal redrew its prompt. Check it and send again.'
    : kind === 'browser' || kind === undefined
      ? 'The page changed. Check the picture and send again.'
      : 'The secret store changed. Check the card and send again.';

/**
 * A failed Send as a sentence, and what kind it is: each needs a different next step from the owner. `kind` is the
 * card's target, so a sentence names the page or the terminal it is about.
 */
export const inputFailure = (error: unknown, kind?: InputRequest['target']['kind']): InputFailure => {
  const failure = (error !== null && typeof error === 'object' ? error : {}) as HttpFailure;
  const message = typeof failure.message === 'string' && failure.message !== '' ? failure.message : undefined;
  const surface = kind === undefined ? 'target' : SURFACE_WORDS[kind];
  if (failure.status === 409 && failure.code === INPUT_ERROR_CODES.targetRebound)
    return { kind: 'changed', definitive: true, text: reboundWords(kind) };
  if (failure.status === 409 && failure.code === INPUT_ERROR_CODES.targetChanged)
    return {
      kind: 'changed',
      definitive: true,
      text: `The ${surface} is no longer what this card showed, so nothing was typed. Check the card before you send again.`,
    };
  if (failure.status === 410 && failure.code === INPUT_ERROR_CODES.targetUnsettled)
    return {
      kind: 'gone',
      definitive: true,
      text: `The ${surface} kept changing, so nothing was typed and this request ended. Ask the ferret to request again.`,
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
