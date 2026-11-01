import { z } from 'zod';
import { SignInIdSchema, TwoFactorIdSchema } from './account-ids.ts';
import { AccountRefSchema, PushAppSchema, TWO_FACTOR_LABEL_MAX_LENGTH } from './accounts.ts';
import { AgendaPhoneApprovalRefSchema, MAX_AGENDA_SUBJECT_LENGTH } from './agenda.ts';
import { InstantSchema } from './common.ts';
import { InputFieldElementSchema } from './input-request.ts';
import { LOGIN_USERNAME_MAX_LENGTH, LoginEntryIdSchema, oneLine } from './login-entries.ts';
import { AgentNameSchema } from './session.ts';
import { AppOriginSchema } from './step-up.ts';
import { SurfaceKeySchema } from './surface-names.ts';

/**
 * APPROVE ON YOUR PHONE (docs/input-requests.md, "Approve on your phone"): a sign-in that waits for a push the owner
 * approves on their phone, with nothing to type. A card of its own, not an input request: an input request is
 * answered by a value, and this one is answered by the owner's phone, which Ferretry never sees.
 *
 * NOTHING OF THE FERRET'S IS SHOWN. A ferret names where (a page or a terminal), optionally which element it thinks
 * shows the number, which account and which push key; it cannot say anything the owner reads. The account, the site,
 * the time and the number all come from the daemon: the number is read by the browser from the page, only on an exact
 * sign-in or identity-provider origin, in a document no ferret has scripted, from a provider's own challenge view: a
 * daemon never reads the element a ferret names (secrev-1244 H1). A terminal never shows a number, because
 * a ferret can print any text into its own pane. And the card settles only on the daemon's own observation that the
 * sign-in moved on, never on anyone's say-so: there is no "I approved" button and no route that sets it.
 */

/** A phone approval's id: `pa_` and 24 hex digits (the agenda ref owns the shape). */
export const PhoneApprovalIdSchema = AgendaPhoneApprovalRefSchema.shape.id;
export type PhoneApprovalId = z.infer<typeof PhoneApprovalIdSchema>;

/** How long a ferret may wait for a push to be approved, in seconds. */
export const PHONE_APPROVAL_MIN_WAIT_SECONDS = 30;
export const PHONE_APPROVAL_MAX_WAIT_SECONDS = 300;
export const PHONE_APPROVAL_DEFAULT_WAIT_SECONDS = 120;

/**
 * EXACTLY WHAT A FERRET MAY SAY when it asks for a phone approval: where, and hints. There is no prompt, message,
 * label or number field, and the object is strict, so an extra key is refused rather than dropped.
 */
export const PhoneApprovalRaiseSchema = z
  .strictObject({
    target: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('browser'), key: SurfaceKeySchema }),
      z.strictObject({ kind: z.literal('terminal'), key: SurfaceKeySchema }),
    ]),
    /**
     * The element the ferret thinks shows the number. KEPT ONLY FOR THE WIRE, AND IGNORED: the daemon reads a number from
     * a provider's own challenge view and never from where a ferret points, because a page may echo back text the ferret
     * typed (Okta shows the username it was given). The agent tools no longer send it.
     */
    element: InputFieldElementSchema.optional(),
    /** The account it expects (a handle, or a sign-in): orders only among the sign-ins the daemon matched. */
    secretHint: z.union([LoginEntryIdSchema, SignInIdSchema]).optional(),
    /** Which push key, if the account has several. Ignored unless it is a key of the matched account. */
    factor: TwoFactorIdSchema.optional(),
    waitSeconds: z
      .number()
      .int()
      .min(PHONE_APPROVAL_MIN_WAIT_SECONDS)
      .max(PHONE_APPROVAL_MAX_WAIT_SECONDS)
      .default(PHONE_APPROVAL_DEFAULT_WAIT_SECONDS),
  })
  .refine(raise => raise.element === undefined || raise.target.kind === 'browser', {
    path: ['element'],
    message: 'only a page has an element that shows a number',
  });
export type PhoneApprovalRaise = z.infer<typeof PhoneApprovalRaiseSchema>;

/**
 * Where a number the daemon read came from: a provider's own sign-in page. `pointed` (the element a ferret pointed at)
 * stays in the list for the wire only: no daemon produces it any more (secrev-1244 H1), and the words still mark one.
 */
export const PHONE_APPROVAL_NUMBER_SOURCES = ['okta', 'microsoft', 'google', 'duo', 'pointed'] as const;

/**
 * What the owner does with the number: tap it among the choices the phone shows (Okta, Microsoft, Google), or type it
 * into the app (Duo Verified Push).
 */
export const PhoneApprovalDirectionSchema = z.enum(['tap-on-phone', 'type-on-phone']);
export type PhoneApprovalDirection = z.infer<typeof PhoneApprovalDirectionSchema>;

/** The direction each source's number goes. */
export const PHONE_APPROVAL_DIRECTION: Readonly<
  Record<(typeof PHONE_APPROVAL_NUMBER_SOURCES)[number], PhoneApprovalDirection>
> = {
  okta: 'tap-on-phone',
  microsoft: 'tap-on-phone',
  google: 'tap-on-phone',
  duo: 'type-on-phone',
  pointed: 'tap-on-phone',
};

/**
 * A number the DAEMON read off the page. A number to tap is 1 to 3 digits (Okta, Microsoft and Google show two); a
 * Duo Verified Push code to type is 3 to 6 digits (its length is the organisation's setting).
 */
export const PhoneApprovalNumberSchema = z
  .strictObject({
    value: z.string().regex(/^[0-9]{1,6}$/u),
    from: z.enum(PHONE_APPROVAL_NUMBER_SOURCES),
    direction: PhoneApprovalDirectionSchema,
    readAt: InstantSchema,
  })
  .refine(number => number.direction === PHONE_APPROVAL_DIRECTION[number.from], {
    path: ['direction'],
    message: 'a number goes the way its source sends it',
  })
  .refine(number => (number.direction === 'tap-on-phone' ? number.value.length <= 3 : number.value.length >= 3), {
    path: ['value'],
    message: 'a number to tap is 1 to 3 digits, a code to type is 3 to 6',
  });
export type PhoneApprovalNumber = z.infer<typeof PhoneApprovalNumberSchema>;

/**
 * Why the card shows no number: the page had none Ferretry recognises; a ferret scripted the page this session; the
 * page is not a sign-in or identity-provider origin; the pointed element can be typed into; the page changed while it
 * was read; or it is a terminal, which never shows one.
 */
export const PhoneApprovalNumberMissingSchema = z.enum([
  'none-found',
  'scripted',
  'origin',
  'editable',
  'changed',
  'terminal',
]);
export type PhoneApprovalNumberMissing = z.infer<typeof PhoneApprovalNumberMissingSchema>;

/**
 * Where an approval stands. `moved-on` is the only success, and only the daemon sets it, on seeing the sign-in move
 * on; `refused` is the owner's "Not me — stop"; `gone`, the page or terminal closed.
 */
export const PhoneApprovalStateSchema = z.enum(['waiting', 'moved-on', 'timed-out', 'refused', 'gone']);
export type PhoneApprovalState = z.infer<typeof PhoneApprovalStateSchema>;

/**
 * The origin of a page an approval waits on: https and an origin only (scheme, host, port), so no `javascript:` or
 * `data:` text, and no path a ferret chose, can reach the card. A push number is only ever read on an https page.
 */
export const PhoneApprovalOriginSchema = AppOriginSchema.refine(
  origin => origin.startsWith('https://'),
  'an https origin',
);

/** The push key a card names, as the owner labelled it. */
export const PhoneApprovalFactorSchema = z.strictObject({
  id: TwoFactorIdSchema,
  label: oneLine(TWO_FACTOR_LABEL_MAX_LENGTH),
  app: PushAppSchema.optional(),
});

/** THE APPROVAL, as the owner's card reads it. Every field but the ids is something the daemon observed or knows. */
export const PhoneApprovalSchema = z
  .strictObject({
    id: PhoneApprovalIdSchema,
    /** From the asking ferret's session credential, never from a body. */
    sessionId: oneLine(128),
    /** The asking ferret's name, as the daemon knows its session ("Asked 14:02 by lizzette"): a callsign, no more. */
    agentName: AgentNameSchema,
    surface: z.enum(['browser', 'terminal']),
    /** The page's origin, as the browser reports it at the raise and at every read. A page only, and https only. */
    origin: PhoneApprovalOriginSchema.optional(),
    /** The sign-in the daemon matched there, its account, and the provider it goes via. */
    signIn: SignInIdSchema.optional(),
    account: AccountRefSchema.optional(),
    username: oneLine(LOGIN_USERNAME_MAX_LENGTH).optional(),
    via: AccountRefSchema.optional(),
    factor: PhoneApprovalFactorSchema.optional(),
    number: PhoneApprovalNumberSchema.optional(),
    numberMissing: PhoneApprovalNumberMissingSchema.optional(),
    raisedAt: InstantSchema,
    expiresAt: InstantSchema,
    state: PhoneApprovalStateSchema,
  })
  .superRefine((approval, context) => {
    const terminal = approval.surface === 'terminal';
    if (terminal && approval.number !== undefined)
      context.addIssue({ code: 'custom', path: ['number'], message: 'a terminal never shows a number' });
    if (terminal && approval.numberMissing !== undefined && approval.numberMissing !== 'terminal')
      context.addIssue({
        code: 'custom',
        path: ['numberMissing'],
        message: 'a terminal has no number because it is one',
      });
    if (!terminal && approval.numberMissing === 'terminal')
      context.addIssue({ code: 'custom', path: ['numberMissing'], message: 'only a terminal is one' });
    if (terminal && approval.origin !== undefined)
      context.addIssue({ code: 'custom', path: ['origin'], message: 'a terminal has no origin' });
    if (approval.number !== undefined && approval.numberMissing !== undefined)
      context.addIssue({ code: 'custom', path: ['numberMissing'], message: 'a number is read or missing, not both' });
    if (approval.username !== undefined && approval.account === undefined)
      context.addIssue({ code: 'custom', path: ['username'], message: 'a username is an account’s' });
    if (approval.via !== undefined && approval.account === undefined)
      context.addIssue({ code: 'custom', path: ['via'], message: 'a provider is an account’s' });
  });
export type PhoneApproval = z.infer<typeof PhoneApprovalSchema>;

/** `GET /v1/phone-approvals`: the approvals still waiting, oldest first. Owner only. */
export const PhoneApprovalListSchema = z.strictObject({
  approvals: z.array(PhoneApprovalSchema).max(64).readonly(),
});
export type PhoneApprovalList = z.infer<typeof PhoneApprovalListSchema>;

/**
 * WHAT THE FERRET IS TOLD while it waits (`input_wait` with a `pa_` id): where the approval stands and, once the
 * sign-in moved on, that it was a push. NEVER THE NUMBER, the account the daemon matched or anything else on the card.
 */
export const PhoneApprovalAgentViewSchema = z
  .strictObject({
    id: PhoneApprovalIdSchema,
    state: PhoneApprovalStateSchema,
    secondFactor: z.literal('push').optional(),
  })
  .refine(view => view.secondFactor === undefined || view.state === 'moved-on', {
    path: ['secondFactor'],
    message: 'a push is known only once the sign-in moved on',
  });
export type PhoneApprovalAgentView = z.infer<typeof PhoneApprovalAgentViewSchema>;

/** What a card, the agenda subject and the push say: built by {@link phoneApprovalWords}, and by nothing else. */
export interface PhoneApprovalWords {
  /** The card's heading. */
  readonly title: string;
  /** Who: "ClickUp · a@gmail.com", or "a sign-in Ferretry doesn't know, on login.microsoftonline.com". */
  readonly who: string;
  /** Where: "login.company.com", "ClickUp via Okta on company.okta.com", or "in a terminal". */
  readonly where: string;
  /** What to do with the number: "Tap 42 on your phone", "Enter 123 in Duo Mobile". Absent: no number. */
  readonly numberLine?: string;
  /**
   * Where a number from the element the ferret pointed at came from, said on the card under the number: the browser
   * read it on a sign-in page, but the ferret chose which element. Absent for a provider's own page, and with no number.
   */
  readonly numberSource?: string;
  /** Why there is no number, and what to do instead. Absent: there is one. */
  readonly noNumber?: string;
  /** The line every card ends with. */
  readonly warning: string;
  /** The agenda item's subject: what an app that does not know these cards shows. Never the number. */
  readonly subject: string;
  /**
   * The push's body: the number first when there is one (owner decision !A171), else where to look for it. A sign-in
   * Ferretry doesn't know is never named by its host here: the ferret chose that host by navigating, and a lock screen
   * shows it with no card around it.
   */
  readonly push: string;
}

/** What a card says under a number read from the element the ferret pointed at. */
export const PHONE_APPROVAL_POINTED_SOURCE = 'Read from the element the ferret pointed at, on this sign-in page.';

/** The heading of every approve-on-phone card and push: no ferret's push may read as it (`agendaNotificationTitle`). */
export const PHONE_APPROVAL_TITLE = 'Approve on your phone';

/** The line every approve-on-phone card carries. */
export const PHONE_APPROVAL_WARNING = 'Never use a number a ferret tells you.';

const cut = (text: string, maximum: number): string =>
  text.length <= maximum ? text : `${text.slice(0, maximum - 1).trimEnd()}…`;

const hostOf = (origin: string | undefined): string | undefined => {
  if (origin === undefined) return undefined;
  try {
    return new URL(origin).host;
  } catch {
    return undefined;
  }
};

/** Why a card shows no number, in the owner's words. */
const NO_NUMBER_WORDS: Readonly<Record<PhoneApprovalNumberMissing, string>> = {
  'none-found': "Ferretry couldn't read a number from the page.",
  scripted: "A ferret scripted this page, so Ferretry won't read a number from it.",
  origin: "This isn't a sign-in page Ferretry knows, so it won't read a number from it.",
  editable: "The number the ferret pointed at can be typed into, so Ferretry won't read it.",
  changed: 'The page changed while Ferretry read it: it will look again.',
  terminal: 'Check the terminal: Ferretry never reads a number from one.',
};

/**
 * THE WORDS OF AN APPROVE-ON-PHONE CARD, from the approval's own fields: the daemon-matched account and username,
 * the observed host, the provider it goes via, and the number the daemon read. It takes nothing else, so nothing a
 * ferret wrote can reach the card, the agenda subject or the push.
 */
export function phoneApprovalWords(
  approval: Pick<PhoneApproval, 'surface' | 'origin' | 'account' | 'username' | 'via' | 'number' | 'numberMissing'>,
): PhoneApprovalWords {
  const host = hostOf(approval.origin);
  const terminal = approval.surface === 'terminal';
  const place = terminal ? 'in a terminal' : host === undefined ? 'on a page' : `on ${host}`;
  const account = approval.account;
  const known =
    account === undefined
      ? undefined
      : approval.username === undefined
        ? account.label
        : `${account.label} · ${approval.username}`;
  const who = known ?? `a sign-in Ferretry doesn't know, ${place}`;
  const where = terminal
    ? 'in a terminal'
    : approval.via !== undefined && account !== undefined
      ? `${account.label} via ${approval.via.label} ${place}`
      : (host ?? 'a page');
  const number = approval.number;
  const numberLine =
    number === undefined
      ? undefined
      : number.direction === 'type-on-phone'
        ? `Enter ${number.value} in Duo Mobile`
        : `Tap ${number.value} on your phone`;
  const noNumber =
    number !== undefined
      ? undefined
      : NO_NUMBER_WORDS[terminal ? 'terminal' : (approval.numberMissing ?? 'none-found')];
  const pointed = number?.from === 'pointed';
  const subject = cut(`Approve on your phone: ${who}`, MAX_AGENDA_SUBJECT_LENGTH);
  // The push names a sign-in it doesn't know without its host (see `push`), and says when the ferret chose the element.
  const pushWho = known ?? "a sign-in Ferretry doesn't know";
  const push =
    numberLine !== undefined
      ? `${numberLine}${pointed ? ' (read where the ferret pointed)' : ''}: ${pushWho}`
      : `Approve on your phone: ${pushWho} — ${terminal ? 'check the terminal' : 'open for the number'}`;
  return {
    title: PHONE_APPROVAL_TITLE,
    who,
    where,
    ...(numberLine === undefined ? {} : { numberLine }),
    ...(pointed ? { numberSource: PHONE_APPROVAL_POINTED_SOURCE } : {}),
    ...(noNumber === undefined ? {} : { noNumber }),
    warning: PHONE_APPROVAL_WARNING,
    subject,
    push: cut(push, MAX_AGENDA_SUBJECT_LENGTH),
  };
}
