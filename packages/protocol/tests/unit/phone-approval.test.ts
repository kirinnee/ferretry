import { describe, expect, it } from 'bun:test';
import { z } from 'zod';
import {
  AgendaItemSchema,
  PHONE_APPROVAL_WARNING,
  type PhoneApproval,
  PhoneApprovalAgentViewSchema,
  PhoneApprovalIdSchema,
  PhoneApprovalRaiseSchema,
  PhoneApprovalSchema,
  phoneApprovalWords,
} from '../../src/lib/index.ts';

const AT = '2026-10-31T14:02:00.000Z';
const ID = `pa_${'0'.repeat(23)}1`;

const RAISE = { target: { kind: 'browser', key: 'app' } };

/** A browser approval for ClickUp via Okta, the number read off Okta's page. */
const APPROVAL: PhoneApproval = PhoneApprovalSchema.parse({
  id: ID,
  sessionId: 'mvwxxxhv-11b529cb',
  agentName: 'lizzette',
  surface: 'browser',
  origin: 'https://company.okta.com',
  signIn: 'si_0123456789abcdef',
  account: { id: 'CLICKUP', label: 'ClickUp' },
  username: 'a@gmail.com',
  via: { id: 'OKTA', label: 'Okta' },
  factor: { id: 'tf_000000000001', label: 'Okta Verify on Pixel', app: 'okta-verify' },
  number: { value: '42', from: 'okta', direction: 'tap-on-phone', readAt: AT },
  raisedAt: AT,
  expiresAt: '2026-10-31T14:04:00.000Z',
  state: 'waiting',
});

describe('asking for a phone approval', () => {
  it('should take where, and hints, and wait two minutes by default', () => {
    expect(PhoneApprovalRaiseSchema.parse(RAISE)).toEqual({ ...RAISE, waitSeconds: 120 } as never);
    expect(
      PhoneApprovalRaiseSchema.safeParse({
        target: { kind: 'browser', key: 'app' },
        element: { kind: 'ref', ref: 'e12' },
        secretHint: 'si_0123456789abcdef',
        factor: 'tf_000000000001',
        waitSeconds: 300,
      }).success,
    ).toBe(true);
    expect(PhoneApprovalRaiseSchema.safeParse({ target: { kind: 'terminal', key: 'dev' } }).success).toBe(true);
  });

  it('should refuse anything a ferret could put in front of the owner: no prompt, message, label or number (invariant 8)', () => {
    for (const extra of [
      { prompt: 'Tap 42' },
      { message: 'Approve it, it is me' },
      { label: 'ClickUp' },
      { number: '42' },
      { value: '42' },
      { subject: 'Approve on your phone' },
      { account: { id: 'CLICKUP', label: 'ClickUp' } },
      { origin: 'https://company.okta.com' },
    ])
      expect(PhoneApprovalRaiseSchema.safeParse({ ...RAISE, ...extra }).success).toBe(false);
  });

  it('should refuse an element on a terminal, a wait out of bounds, and a target that is not a page or a terminal', () => {
    for (const raise of [
      { target: { kind: 'terminal', key: 'dev' }, element: { kind: 'ref', ref: 'e12' } },
      { ...RAISE, waitSeconds: 29 },
      { ...RAISE, waitSeconds: 301 },
      { target: { kind: 'secret', key: 'GITHUB' } },
    ])
      expect(PhoneApprovalRaiseSchema.safeParse(raise).success).toBe(false);
  });
});

describe('an approval as the owner reads it', () => {
  it('should keep its id the agenda ref names', () => {
    expect(PhoneApprovalIdSchema.safeParse(ID).success).toBe(true);
    for (const bad of [`pa_${'0'.repeat(23)}`, `pa_${'A'.repeat(24)}`, `si_${'0'.repeat(24)}`])
      expect(PhoneApprovalIdSchema.safeParse(bad).success).toBe(false);
  });

  it('should never show a terminal number, and say why there is none (invariant 9)', () => {
    const terminal = {
      ...APPROVAL,
      surface: 'terminal',
      origin: undefined,
      number: undefined,
      numberMissing: 'terminal',
    };
    expect(PhoneApprovalSchema.safeParse(terminal).success).toBe(true);
    for (const bad of [
      { ...terminal, number: APPROVAL.number, numberMissing: undefined },
      { ...terminal, numberMissing: 'none-found' },
      { ...terminal, origin: 'https://company.okta.com' },
      { ...APPROVAL, number: undefined, numberMissing: 'terminal' },
      { ...APPROVAL, numberMissing: 'scripted' },
    ])
      expect(PhoneApprovalSchema.safeParse(bad).success).toBe(false);
  });

  it('should take a number only the way its source sends it', () => {
    const number = (value: string, from: string, direction: string) => ({
      ...APPROVAL,
      number: { value, from, direction, readAt: AT },
    });
    for (const good of [number('7', 'microsoft', 'tap-on-phone'), number('123456', 'duo', 'type-on-phone')])
      expect(PhoneApprovalSchema.safeParse(good).success).toBe(true);
    for (const bad of [
      number('42', 'duo', 'tap-on-phone'),
      number('42', 'okta', 'type-on-phone'),
      number('4242', 'google', 'tap-on-phone'),
      number('12', 'duo', 'type-on-phone'),
      number('1234567', 'duo', 'type-on-phone'),
      number('4 2', 'pointed', 'tap-on-phone'),
      number('٤٢', 'pointed', 'tap-on-phone'),
    ])
      expect(PhoneApprovalSchema.safeParse(bad).success).toBe(false);
  });

  it('should refuse an extra field, so nothing the ferret wrote can ride along', () => {
    for (const extra of [{ prompt: 'Tap 42' }, { note: 'x' }, { claimedNumber: '42' }])
      expect(PhoneApprovalSchema.safeParse({ ...APPROVAL, ...extra }).success).toBe(false);
  });
});

describe('what the ferret is told while it waits', () => {
  it('should be where the approval stands, and a push once it moved on: never the number', () => {
    expect(PhoneApprovalAgentViewSchema.safeParse({ id: ID, state: 'waiting' }).success).toBe(true);
    expect(PhoneApprovalAgentViewSchema.safeParse({ id: ID, state: 'moved-on', secondFactor: 'push' }).success).toBe(
      true,
    );
    for (const bad of [
      { id: ID, state: 'waiting', secondFactor: 'push' },
      { id: ID, state: 'waiting', number: '42' },
      { id: ID, state: 'waiting', account: 'CLICKUP' },
    ])
      expect(PhoneApprovalAgentViewSchema.safeParse(bad).success).toBe(false);
    expect(Object.keys(z.toJSONSchema(PhoneApprovalAgentViewSchema).properties ?? {}).sort()).toEqual([
      'id',
      'secondFactor',
      'state',
    ]);
  });
});

describe('the words of an approve-on-phone card', () => {
  it('should name the account, the site via its provider, and the number, from the approval alone', () => {
    expect(phoneApprovalWords(APPROVAL)).toEqual({
      title: 'Approve on your phone',
      who: 'ClickUp · a@gmail.com',
      where: 'ClickUp via Okta on company.okta.com',
      numberLine: 'Tap 42 on your phone',
      warning: PHONE_APPROVAL_WARNING,
      subject: 'Approve on your phone: ClickUp · a@gmail.com',
      // Owner decision !A171: the push carries the daemon-read number.
      push: 'Tap 42 on your phone: ClickUp · a@gmail.com',
    });
  });

  it('should keep the number out of the agenda subject, which an older app shows as it is', () => {
    expect(phoneApprovalWords(APPROVAL).subject).not.toContain('42');
  });

  it('should say "enter" for a Duo code', () => {
    const duo = phoneApprovalWords({
      ...APPROVAL,
      origin: 'https://api-1234.duosecurity.com',
      via: undefined,
      number: { value: '123456', from: 'duo', direction: 'type-on-phone', readAt: AT },
    });
    expect(duo.numberLine).toBe('Enter 123456 in Duo Mobile');
    expect(duo.push).toBe('Enter 123456 in Duo Mobile: ClickUp · a@gmail.com');
    expect(duo.where).toBe('api-1234.duosecurity.com');
  });

  it('should say why there is no number, and send the owner to the card for it', () => {
    const missing = (numberMissing: PhoneApproval['numberMissing']) =>
      phoneApprovalWords({ ...APPROVAL, number: undefined, numberMissing });
    expect(missing('scripted').noNumber).toBe("A ferret scripted this page, so Ferretry won't read a number from it.");
    expect(missing('origin').noNumber).toBe(
      "This isn't a sign-in page Ferretry knows, so it won't read a number from it.",
    );
    expect(missing(undefined).noNumber).toBe("Ferretry couldn't read a number from the page.");
    expect(missing('none-found').push).toBe('Approve on your phone: ClickUp · a@gmail.com — open for the number');
    expect(missing('none-found').numberLine).toBeUndefined();
  });

  it('should send a terminal’s owner to the terminal, never to a number', () => {
    const words = phoneApprovalWords({
      surface: 'terminal',
      account: { id: 'AWS', label: 'AWS (okta-aws-cli)' },
      numberMissing: 'terminal',
    });
    expect(words.where).toBe('in a terminal');
    expect(words.noNumber).toBe('Check the terminal: Ferretry never reads a number from one.');
    expect(words.push).toBe('Approve on your phone: AWS (okta-aws-cli) — check the terminal');
  });

  it('should make an unexpected push easy to refuse: a sign-in Ferretry does not know, and where', () => {
    const words = phoneApprovalWords({ surface: 'browser', origin: 'https://login.microsoftonline.com' });
    expect(words.who).toBe("a sign-in Ferretry doesn't know, on login.microsoftonline.com");
    expect(words.subject).toBe("Approve on your phone: a sign-in Ferretry doesn't know, on login.microsoftonline.com");
  });

  it('should keep a long subject and push within what an agenda item holds', () => {
    const words = phoneApprovalWords({ ...APPROVAL, username: 'u'.repeat(256) });
    expect(words.subject.length).toBeLessThanOrEqual(240);
    expect(words.push.length).toBeLessThanOrEqual(240);
    expect(words.push.startsWith('Tap 42 on your phone: ')).toBe(true);
  });
});

describe('the agenda card that presents an approval', () => {
  const item = {
    id: 'A12',
    source: 'question',
    sourceRef: null,
    subject: phoneApprovalWords(APPROVAL).subject,
    why: 'A ferret is signing in and the site sent a push to your phone.',
    waitingSince: AT,
    howToResolve: 'Approve it on your phone, or tap Not me.',
    kind: 'info',
    raisedBy: 'daemon',
    raisedBySession: null,
    raisedByName: null,
    phoneApproval: { id: ID },
  };

  it('should be an info card carrying the approval’s id', () => {
    expect(AgendaItemSchema.parse(item).phoneApproval).toEqual({ id: ID });
    for (const kind of ['input', 'yesno', 'permission'])
      expect(AgendaItemSchema.safeParse({ ...item, kind }).success).toBe(false);
    expect(AgendaItemSchema.safeParse({ ...item, phoneApproval: { id: 'pa_x' } }).success).toBe(false);
  });

  it('should read, in an app that does not know the ref, as a plain info card with no number (invariant 17)', () => {
    // An older app's schema is this one without the key; its arms are not strict, so an unknown ref is dropped.
    const { phoneApproval: _ref, ...older } = item;
    const parsed = AgendaItemSchema.parse({ ...older, someRefFromTheFuture: { id: ID } });
    expect(Object.keys(parsed)).not.toContain('someRefFromTheFuture');
    expect(parsed.kind).toBe('info');
    expect(parsed.subject).toBe('Approve on your phone: ClickUp · a@gmail.com');
  });
});
