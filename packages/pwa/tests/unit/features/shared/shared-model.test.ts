/**
 * What a catalog member reads: the countdown, the publisher line, and which failure says what.
 */

import { describe, it } from 'bun:test';
import { FyHttpError } from '@ferretry/protocol/client';
import should from 'should';
import {
  formatCountdown,
  isKeyRefused,
  JOIN_REFUSED_SENTENCE,
  NOT_SHOWN_SENTENCE,
  passkeyHeading,
  passkeyWindow,
  problemFor,
  publisherLine,
  REDEEM_NEW_MEMBER,
  REDEEM_OTHER_MEMBER,
  redeemedSentence,
  redeemRefusal,
  secondsLeft,
  WINDOW_CLOSED_SENTENCE,
} from '../../../../src/features/shared/shared-model.ts';
import { MemberRefusedError, MemberUnreachableError } from '../../../../src/lib/member-client.ts';
import { PasskeyCeremonyError } from '../../../../src/lib/passkeys.ts';
import { testSubscription } from '../../../support/member-keys.ts';

const ORIGIN = 'https://app.ferretry.test';
const ENDS = '2026-10-31T10:10:00.000Z';
const at = (iso: string) => new Date(iso);
const http = (code: string | undefined, status = 409) => new FyHttpError('refused', status, code);
const redeemed = (names: readonly string[]) => ({
  added: names.map((name, index) => ({ catalogId: `cat_${String(index).repeat(22)}`, name })),
});

describe('secondsLeft and formatCountdown', () => {
  it('should round a part-second up and never go below zero', () => {
    should(secondsLeft(ENDS, at('2026-10-31T10:09:59.500Z'))).equal(1);
    should(secondsLeft(ENDS, at('2026-10-31T10:10:00.000Z'))).equal(0);
    should(secondsLeft(ENDS, at('2026-10-31T10:30:00.000Z'))).equal(0);
  });

  it('should write minutes and two-digit seconds', () => {
    should(formatCountdown(600)).equal('10:00');
    should(formatCountdown(65)).equal('1:05');
    should(formatCountdown(9.9)).equal('0:09');
    should(formatCountdown(-3)).equal('0:00');
  });
});

describe('passkeyWindow', () => {
  it('should say the time left, in words, while the window is open', () => {
    const window = passkeyWindow(ENDS, at('2026-10-31T10:05:00.000Z'));
    should(window).match({ open: true, seconds: 300, urgent: false });
    should(window.sentence).equal('Add a passkey in the next 5:00 or this link stops working.');
  });

  it('should get urgent in the last minute', () => {
    should(passkeyWindow(ENDS, at('2026-10-31T10:09:00.000Z')).urgent).be.true();
    should(passkeyWindow(ENDS, at('2026-10-31T10:08:59.000Z')).urgent).be.false();
  });

  it('should say the link stopped working once the window is over', () => {
    should(passkeyWindow(ENDS, at('2026-10-31T10:10:01.000Z'))).match({
      open: false,
      seconds: 0,
      urgent: false,
      sentence: WINDOW_CLOSED_SENTENCE,
    });
  });
});

describe('passkeyHeading and publisherLine', () => {
  it('should name the member and the publisher', () => {
    should(passkeyHeading('Alice', 'Studio')).equal('Add a passkey for Alice on Studio');
  });

  it('should show the person’s own label, the publisher’s name and the head of the fingerprint', async () => {
    const daemonId = `fy_daemon_${'abcdefghij'.repeat(4)}`;
    const line = publisherLine(await testSubscription(daemonId, { ownLabel: 'Work box', daemonName: 'kirin-box' }));
    should(line).match({
      label: 'Work box',
      publisherName: 'kirin-box',
      fingerprint: 'abcdefghijabcdefghij',
      fingerprintFull: daemonId,
      refused: false,
    });
  });

  it('should mark hidden characters in a name the publisher chose, in the heading and the line', async () => {
    const hidden = 'Stu\u202Edio';
    should(passkeyHeading(hidden, hidden)).not.containEql('\u202E');
    const line = publisherLine(await testSubscription('fy_daemon_x', { ownLabel: hidden, daemonName: hidden }));
    should(line.label).not.containEql('\u202E');
    should(line.publisherName).not.containEql('\u202E');
  });

  it('should say a refused subscription is refused', async () => {
    const line = publisherLine(await testSubscription('fy_daemon_x', { status: 'refused' }));
    should(line.refused).be.true();
  });
});

describe('problemFor', () => {
  it('should say a publisher nobody reached is unreachable', () => {
    should(problemFor(new MemberUnreachableError(2), ORIGIN).kind).equal('unreachable');
  });

  it('should turn a failed ceremony into the passkey sentence', () => {
    const problem = problemFor(new PasskeyCeremonyError('cancelled'), ORIGIN);
    should(problem.kind).equal('ceremony');
    should(problem.sentence.length).be.above(0);
  });

  it('should know each code a member route answers with', () => {
    const kinds: Record<string, string> = {
      member_locked: 'locked',
      member_registration_closed: 'window-closed',
      member_not_verified: 'ceremony',
      'too-many-passkeys': 'ceremony',
      'no-passkey': 'ceremony',
      catalog_unknown: 'gone',
      item_unknown: 'gone',
      item_withdrawn: 'gone',
      members_full: 'full',
    };
    for (const [code, kind] of Object.entries(kinds)) should(problemFor(http(code), ORIGIN).kind).equal(kind);
  });

  it('should fall back to a plain retry for an unknown code, no code, or any other error', () => {
    should(problemFor(http('something_new'), ORIGIN).kind).equal('other');
    should(problemFor(http(undefined, 500), ORIGIN).kind).equal('other');
    should(problemFor(new Error('boom'), ORIGIN).kind).equal('other');
  });
});

describe('isKeyRefused', () => {
  it('should be true only for a refusal of the key', () => {
    should(isKeyRefused(new MemberRefusedError())).be.true();
    should(isKeyRefused(http('unauthorized', 401))).be.false();
  });
});

describe('redeemRefusal', () => {
  it('should give each share refusal its own sentence', () => {
    should(redeemRefusal(http('share_refused'), ORIGIN)).equal(JOIN_REFUSED_SENTENCE);
    should(redeemRefusal(http('share_other_member'), ORIGIN)).equal(REDEEM_OTHER_MEMBER);
    should(redeemRefusal(http('share_new_member'), ORIGIN)).equal(REDEEM_NEW_MEMBER);
    should(redeemRefusal(http('members_full'), ORIGIN)).match(/no room/u);
    should(redeemRefusal(http('member_locked'), ORIGIN)).match(/Unlock/u);
  });

  it('should use the general sentences for anything else', () => {
    should(redeemRefusal(http('item_withdrawn'), ORIGIN)).match(/took this item out/u);
    should(redeemRefusal(http(undefined, 500), ORIGIN)).match(/Try again/u);
  });
});

describe('redeemedSentence', () => {
  it('should say what was added', () => {
    should(redeemedSentence(redeemed([]))).equal('You already had everything in this link.');
    should(redeemedSentence(redeemed(['Tools']))).equal('Added Tools.');
    should(redeemedSentence(redeemed(['Tools', 'Docs']))).equal('Added 2 catalogs: Tools, Docs.');
  });
});

describe('sentences', () => {
  it('should keep the not-shown sentence about the publisher', () => {
    should(NOT_SHOWN_SENTENCE).match(/publisher/u);
  });
});
