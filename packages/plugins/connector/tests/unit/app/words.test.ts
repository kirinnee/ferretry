import { describe, expect, it } from 'bun:test';
import { instantFromEpochMs } from '@ferretry/std';
import {
  actFailureSentence,
  addressSourceWords,
  agoWords,
  approvedByWords,
  isOutdatedMachine,
  orderedGrants,
  requestFromSearch,
  revokeConsequence,
  scopeSentence,
} from '../../../app/lib/words.ts';
import { grantView, NOW, refusal } from './fixtures.ts';

const at = (iso: string) => instantFromEpochMs(Date.parse(iso));

describe('the connector tab’s words', () => {
  it('says what a grant may do in the words a person decides by', () => {
    expect(scopeSentence(['fleet:read'])).toBe('read your fleet');
    expect(scopeSentence(['fleet:read', 'fleet:write'])).toBe('read your fleet and control your ferrets');
    expect(scopeSentence([])).toBe('do nothing');
  });

  it('says who approved: a paired device, or somebody at the machine', () => {
    expect(approvedByWords('admin-cli')).toBe('Approved at the machine');
    expect(approvedByWords('device:dev_fixture')).toBe('Approved by a paired device');
  });

  it('says how long ago in plain words, and never negative', () => {
    const at = (minutes: number): string => new Date(NOW - minutes * 60_000).toISOString();
    expect(agoWords(at(0), NOW)).toBe('just now');
    expect(agoWords(at(-5), NOW)).toBe('just now');
    expect(agoWords(at(1), NOW)).toBe('1 minute ago');
    expect(agoWords(at(5), NOW)).toBe('5 minutes ago');
    expect(agoWords(at(180), NOW)).toBe('3 hours ago');
    expect(agoWords(at(60 * 24), NOW)).toBe('yesterday');
    expect(agoWords(at(60 * 24 * 4), NOW)).toBe('4 days ago');
    expect(agoWords('not a time', NOW)).toBe('at an unknown time');
  });

  it('lists live grants first, newest first, and keeps the revoked after them', () => {
    const grants = [
      grantView({ id: 'cg_revokedaaa', revokedAt: instantFromEpochMs(NOW), createdAt: at('2026-11-25T19:00:00.000Z') }),
      grantView({ id: 'cg_olderaaaaa', createdAt: at('2026-11-24T10:00:00.000Z') }),
      grantView({ id: 'cg_newerbbbbb', createdAt: at('2026-11-25T10:00:00.000Z') }),
    ];
    expect(orderedGrants(grants).map(grant => grant.id)).toEqual(['cg_newerbbbbb', 'cg_olderaaaaa', 'cg_revokedaaa']);
  });

  it('says what a revoke stops, in the same breath as the button', () => {
    expect(revokeConsequence(grantView({ clientName: 'Claude' }))).toBe(
      'Claude stops working on its very next call. To use it again it has to sign in and be approved again.',
    );
  });

  it('names where the address comes from, and says nothing when it is not known', () => {
    expect(addressSourceWords('tunnel')).toContain('built-in tunnel');
    expect(addressSourceWords('configured')).toContain('config/connector.yaml');
    expect(addressSourceWords(undefined)).toBeNull();
  });

  it('reads the sign-in a link names only when it is a public request id', () => {
    expect(requestFromSearch('?request=cr_abcde23456')).toBe('cr_abcde23456');
    expect(requestFromSearch('?request=cg_abcde23456')).toBeNull();
    expect(requestFromSearch('?request=cr_abcde23456&x=1')).toBe('cr_abcde23456');
    expect(requestFromSearch('?request=<script>')).toBeNull();
    expect(requestFromSearch('')).toBeNull();
  });

  it('gives one sentence for a refused act: the daemon’s code first, then its own words, never a status', () => {
    expect(actFailureSentence(refusal(410, 'connector_expired', 'whatever'))).toBe(
      'That sign-in ran out of time. Ask Claude to connect again.',
    );
    expect(actFailureSentence(refusal(404, 'connector_not_found', 'x'))).toContain('not waiting any more');
    expect(actFailureSentence(refusal(409, 'connector_already_decided', 'x'))).toBe(
      'That sign-in was already answered.',
    );
    expect(actFailureSentence(refusal(409, 'connector_disabled', 'x'))).toBe(
      'The connector is off. Switch it on first.',
    );
    expect(actFailureSentence(refusal(403, 'grant_step_up_required', 'x'))).toContain('passkey wasn’t confirmed');
    expect(actFailureSentence(refusal(409, 'connector_cannot_switch', 'Port 7461 is taken by another program.'))).toBe(
      'Port 7461 is taken by another program.',
    );
    expect(actFailureSentence(refusal(403, 'grant_refused', ''))).toBe(
      'This machine did not allow that from this device.',
    );
    expect(actFailureSentence(new Error('socket closed'))).toBe(
      'This machine did not answer. Check it is awake and try again.',
    );
  });

  it('knows a machine that has no connector yet by its unrouted 404', () => {
    expect(isOutdatedMachine(refusal(404, 'unknown_route', 'no route'))).toBe(true);
    expect(isOutdatedMachine(refusal(404, 'connector_not_found', 'x'))).toBe(false);
    expect(isOutdatedMachine(new Error('down'))).toBe(false);
  });
});
