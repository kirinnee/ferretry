import { describe, expect, it } from 'bun:test';
import {
  finishSignInLabel,
  hasSharedEmails,
  loginEmail,
  loginExplanation,
  loginGroups,
  loginName,
  loginUse,
  signedInSentence,
  signInCoverage,
  slotBadge,
  terminalBadge,
  usageBars,
  usageBarText,
} from '../../../app/lib/logins-view.ts';
import { login, loginList } from '../cli/fakes.ts';

const NOW = Date.parse('2026-11-01T10:00:00.000Z');

describe('how a login is worded', () => {
  it('names a login by its email and label, or by its harness before the email is known', () => {
    expect(loginName(login({ label: 'work' }))).toBe('you@example.com (work)');
    expect(loginEmail(login({ email: undefined }))).toBe('Claude Code login');
    expect(loginEmail(login({ email: undefined, harnesses: ['claude-code', 'codex'] }))).toBe(
      'Claude Code + Codex login',
    );
  });

  it('says who uses a login and what one sign-in covers', () => {
    expect(loginUse(login({ usedBy: [] }))).toBe('Not used yet');
    expect(loginUse(login({ usedBy: ['a', 'b'] }))).toBe('Used by 2 runtimes');
    expect(signInCoverage(login({ usedBy: [] }), 'studio')).toBe('The login is kept on studio. Nothing uses it yet.');
    expect(signInCoverage(login({ usedBy: ['a', 'b'] }), 'studio')).toContain('(2 runtimes)');
    expect(finishSignInLabel(login({ usedBy: ['a', 'b', 'c'] }))).toBe('Finish sign-in for 3 runtimes');
    expect(finishSignInLabel(login({ usedBy: ['a'] }))).toBe('Finish sign-in');
    expect(signedInSentence(0)).toBe('Signed in.');
    expect(signedInSentence(3)).toBe('Signed in. 3 runtimes can launch now.');
  });

  it('badges a login shared with the terminal or copied as an empty slot, and explains a copied slot', () => {
    expect(terminalBadge(login({ sharedWithTerminal: true }))).toBe('Shared with claude in your terminal');
    expect(terminalBadge(login())).toBeNull();
    expect(slotBadge(login({ clonedFrom: 'mac' }))).toBe('Copied slot from mac');
    expect(
      loginExplanation(
        login({
          clonedFrom: 'mac',
          status: {
            word: 'needs_sign_in',
            label: 'Needs sign-in',
            reason: 'not_signed_in',
            explanation: 'x',
            lastCheckInconclusive: false,
          },
        }),
      ),
    ).toContain('Empty slot');
  });

  it('never draws an unmeasured window as zero', () => {
    expect(usageBars(login({ usage: { fiveHour: {}, weekly: {} } }), NOW)).toBeNull();
    const bars = usageBars(
      login({ usage: { fiveHour: { usedPercent: 85, resetsAt: '2026-11-01T12:00:00.000Z' }, weekly: {} } }),
      NOW,
    );
    expect(bars?.map(usageBarText)).toEqual(['5h: 85% used · resets in 2h', 'Week: not measured yet']);
    expect(bars?.[0]?.high).toBe(true);
  });

  it('lists each login once, grouped by the CLI it drives, and explains shared emails', () => {
    const list = loginList(
      login({ id: 'a' }),
      login({ id: 'b', harness: 'codex', harnesses: ['codex'], email: 'x@y.z' }),
      login({ id: 'c', harnesses: ['claude-code', 'codex'], email: 'c@y.z' }),
    );
    expect(loginGroups(list).map(group => [group.title, group.logins.map(entry => String(entry.id))])).toEqual([
      ['Claude Code', ['a']],
      ['Codex', ['b']],
      ['Claude Code + Codex', ['c']],
    ]);
    expect(hasSharedEmails(list)).toBe(false);
    expect(hasSharedEmails(loginList(login({ id: 'a' }), login({ id: 'b' })))).toBe(true);
  });
});
