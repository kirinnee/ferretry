import { describe, expect, it } from 'bun:test';
import {
  anyCliUpdate,
  cliHeadline,
  cliJobWords,
  cliStartRefusal,
  installWords,
  latestWords,
  locationWords,
  shouldPollClis,
  unverifiedQuestion,
  updateChoices,
  verificationBadge,
} from '../../../../src/features/settings/agent-clis-model.ts';
import { CHANGELOG, claudeCli, clisView, codexCli } from './agent-clis-support.ts';

const NOW = Date.parse('2026-10-20T12:00:00.000Z');

describe('the Agent CLIs words', () => {
  it('badges every verification', () => {
    expect(verificationBadge('verified')).toEqual({ tone: 'ok', text: 'Verified by Ferretry' });
    expect(verificationBadge('older')).toEqual({ tone: 'pend', text: 'Older than verified' });
    expect(verificationBadge('unverified')).toEqual({ tone: 'warn', text: 'Not yet verified by Ferretry' });
    expect(verificationBadge('unknown')).toEqual({ tone: 'pend', text: 'Version unknown' });
  });

  it('heads a card with the version, or just the name when nothing was found', () => {
    expect(cliHeadline(claudeCli())).toBe('Claude Code 2.1.200');
    expect(cliHeadline(claudeCli({ installed: { state: 'unreadable', reason: 'odd' } }))).toBe(
      'Claude Code (version unreadable)',
    );
    expect(cliHeadline(codexCli({ location: { state: 'absent', searched: [] } }))).toBe('Codex');
  });

  it('says which rule chose the file, or why there is none', () => {
    expect(locationWords(claudeCli().location)).toBe('inherited environment (PATH)');
    expect(locationWords({ state: 'override-absent', path: '/x', declaredBy: 'FY_CODEX_BIN', reason: 'gone' })).toBe(
      'gone',
    );
    expect(locationWords({ state: 'absent', searched: [] })).toBe('Not found on this daemon’s PATH.');
    expect(locationWords({ state: 'absent', searched: ['/opt/bin'] })).toBe(
      'Not found on this daemon’s PATH or in /opt/bin.',
    );
  });

  it('says the install method and its detail', () => {
    expect(installWords(codexCli())).toEqual({ label: 'Homebrew', detail: 'Homebrew cask codex' });
    expect(installWords(codexCli({ method: null }))).toBeUndefined();
  });

  it('says when npm was asked and what it said', () => {
    expect(latestWords({ state: 'never' }, NOW)).toBe('Not checked yet.');
    expect(latestWords(claudeCli().check, NOW)).toBe('2.1.230 on npm, checked 2 minutes ago.');
    expect(
      latestWords({ state: 'failed', checkedAt: '2026-10-20T11:59:00.000Z', reason: 'could not reach npm' }, NOW),
    ).toBe('The check 1 minute ago failed: could not reach npm.');
    expect(
      latestWords(
        {
          state: 'failed',
          checkedAt: '2026-10-20T11:59:00.000Z',
          reason: 'could not reach npm',
          lastKnown: { checkedAt: '2026-10-20T10:00:00.000Z', latest: { version: '2.1.230', url: CHANGELOG } },
        },
        NOW,
      ),
    ).toBe('The check 1 minute ago failed: could not reach npm. The last answer, 2 hours ago, said 2.1.230.');
  });

  it('says a running and a finished update in their tones', () => {
    expect(cliJobWords({ state: 'running', startedAt: '2026-10-20T12:00:00.000Z', command: 'brew update' })).toEqual({
      tone: 'pend',
      text: 'Updating — running brew update',
    });
    const finished = (outcome: 'succeeded' | 'unchanged' | 'rolled-back' | 'failed') =>
      cliJobWords({
        state: 'finished',
        report: { outcome, message: outcome, finishedAt: '2026-10-20T12:00:00.000Z' },
      }).tone;
    expect(['succeeded', 'unchanged', 'rolled-back', 'failed'].map(o => finished(o as never))).toEqual([
      'ok',
      'warn',
      'warn',
      'err',
    ]);
  });
});

describe('the Update buttons', () => {
  it('offers a pinning method the verified version first and the newest flagged unverified', () => {
    expect(updateChoices(claudeCli())).toEqual([
      { key: 'verified', target: '2.1.220', label: 'Update to 2.1.220 (verified)', unverified: false, primary: true },
      { key: 'latest', target: '2.1.230', label: 'Update to 2.1.230', unverified: true, primary: false },
    ]);
  });

  it('makes the newest primary when it is not past the verified version', () => {
    const behind = claudeCli({
      installed: { state: 'ok', version: '2.1.100' },
      check: { state: 'ok', checkedAt: '2026-10-20T11:58:00.000Z', latest: { version: '2.1.220', url: CHANGELOG } },
    });
    expect(updateChoices(behind)).toEqual([
      { key: 'latest', target: '2.1.220', label: 'Update to 2.1.220', unverified: false, primary: true },
    ]);
  });

  it('offers a method that takes what it has one Update, flagged when the newest is unverified or unknown', () => {
    expect(updateChoices(codexCli())).toEqual([{ key: 'newest', label: 'Update', unverified: true, primary: false }]);
    expect(
      updateChoices(
        codexCli({
          installed: { state: 'ok', version: '0.140.0' },
          check: { state: 'ok', checkedAt: '2026-10-20T11:58:00.000Z', latest: { version: '0.145.0', url: CHANGELOG } },
        }),
      ),
    ).toEqual([{ key: 'newest', label: 'Update', unverified: false, primary: true }]);
    expect(updateChoices(codexCli({ check: { state: 'never' } }))).toEqual([
      { key: 'newest', label: 'Update', unverified: true, primary: false },
    ]);
  });

  it('offers nothing when nothing is newer, or the method cannot update itself', () => {
    expect(updateChoices(claudeCli({ available: false }))).toEqual([]);
    expect(updateChoices(claudeCli({ plan: { kind: 'manual', explanation: 'x', steps: [] } }))).toEqual([]);
    expect(updateChoices(claudeCli({ plan: null }))).toEqual([]);
    expect(updateChoices(claudeCli({ installed: { state: 'ok', version: '2.1.230' } }))).toEqual([]);
  });

  it('asks the second question in words that name both versions', () => {
    expect(unverifiedQuestion(codexCli(), '0.163.0')).toBe(
      'Codex 0.163.0 has not been verified by Ferretry yet. Ferretry verified 0.145.0; a newer version can change how Ferretry drives it.',
    );
    expect(unverifiedQuestion(codexCli(), undefined)).toMatch(/cannot tell which Codex version this installs/u);
  });
});

describe('the panel’s view-level answers', () => {
  it('polls only while an update runs, and dots only a machine with something newer', () => {
    expect(shouldPollClis(clisView())).toBe(false);
    expect(
      shouldPollClis(
        clisView(claudeCli({ job: { state: 'running', startedAt: '2026-10-20T12:00:00.000Z', command: 'npm' } })),
      ),
    ).toBe(true);
    expect(anyCliUpdate(clisView())).toBe(true);
    expect(anyCliUpdate(clisView(claudeCli({ available: false })))).toBe(false);
  });

  it('turns an unverified refusal into the confirm, and anything else into its sentence', () => {
    expect(
      cliStartRefusal({
        code: 'harness_update_unverified',
        body: { error: 'x', code: 'harness_update_unverified', target: '0.163.0', verified: '0.145.0' },
      }),
    ).toEqual({ kind: 'unverified', target: '0.163.0', verified: '0.145.0' });
    expect(
      cliStartRefusal({
        code: 'harness_update_unverified',
        body: { error: 'x', code: 'harness_update_unverified', verified: '0.145.0' },
      }),
    ).toEqual({ kind: 'unverified', verified: '0.145.0' });
    expect(cliStartRefusal({ code: 'harness_update_unverified', body: 'garbled', message: 'no' })).toEqual({
      kind: 'message',
      text: 'no',
    });
    expect(cliStartRefusal(new Error('already running'))).toEqual({ kind: 'message', text: 'already running' });
    expect(cliStartRefusal('odd')).toEqual({ kind: 'message', text: 'odd' });
  });
});
