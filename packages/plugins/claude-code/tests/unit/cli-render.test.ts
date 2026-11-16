import { describe, expect, test } from 'bun:test';
import { type HarnessCliView, HarnessCliViewSchema } from '../../contract/index.ts';
import { renderStatus } from '../../cli/lib/render.ts';

const AT = '2026-11-09T09:00:00.000Z';

/** A located Claude Code at 2.1.220, up to date and verified; each test changes only what it is about. */
const view = (changes: Record<string, unknown> = {}): HarnessCliView =>
  HarnessCliViewSchema.parse({
    harness: 'claude-code',
    location: { state: 'located', path: '/opt/claude/bin/claude', rule: 'PATH', declaredBy: 'the environment' },
    installed: { state: 'ok', version: '2.1.220' },
    method: null,
    plan: null,
    check: { state: 'ok', checkedAt: AT, latest: { version: '2.1.220', url: 'https://example.invalid/r' } },
    verified: { version: '2.1.220', url: 'https://example.invalid/verified' },
    verification: 'verified',
    available: false,
    job: null,
    ...changes,
  });

const lines = (changes: Record<string, unknown> = {}): string[] => renderStatus(view(changes), 'fy').split('\n');

describe('fy harness claude-code status', () => {
  test('says where claude was looked for when it is not found, with and without declared search directories', () => {
    expect(renderStatus(view({ location: { state: 'absent', searched: [] } }), 'fy').split('\n')).toEqual([
      'Claude Code: not found on this machine',
      '  Searched PATH.',
    ]);
    expect(
      renderStatus(view({ location: { state: 'absent', searched: ['/opt/a', '/opt/b'] } }), 'fy').split('\n'),
    ).toEqual(['Claude Code: not found on this machine', '  Searched PATH and /opt/a, /opt/b.']);
  });

  test('says why a named path is not usable, and stops there', () => {
    expect(
      renderStatus(
        view({
          location: {
            state: 'override-absent',
            path: '/nope/claude',
            declaredBy: 'FY_CLAUDE_BIN',
            reason: 'no such file',
          },
        }),
        'fy',
      ),
    ).toBe('Claude Code: not usable - no such file');
  });

  test('an up-to-date, verified install says what runs, where from, and that the running ferrets keep their version', () => {
    const text = lines();
    expect(text[0]).toBe('Claude Code 2.1.220 - up to date');
    expect(text).toContain('  Runs:       /opt/claude/bin/claude  (PATH - the environment)');
    expect(text).toContain('  Verified:   2.1.220 is the version Ferretry verified');
    expect(text).toContain('  Latest:     2.1.220 on npm, checked 2026-11-09T09:00:00.000Z');
    expect(text.at(-1)).toBe('Running ferrets keep the version they started with until they are restarted.');
  });

  test('a newer release is an available update, flagged when Ferretry has not verified it', () => {
    const newer = {
      check: { state: 'ok', checkedAt: AT, latest: { version: '2.2.0', url: 'https://example.invalid/r' } },
      available: true,
    };
    expect(lines(newer)[0]).toBe('Claude Code 2.1.220 - update available: 2.2.0');
    const unverified = lines({ ...newer, verification: 'unverified' });
    expect(unverified[0]).toBe('Claude Code 2.1.220 - update available: 2.2.0 (not yet verified by Ferretry)');
    expect(unverified).toContain(
      '  Verified:   not yet verified by Ferretry (verified: 2.1.220) - https://example.invalid/verified',
    );
  });

  test('each way a version can stand against the verified one has its own words', () => {
    expect(lines({ verification: 'older' })).toContain(
      '  Verified:   older than 2.1.220, the version Ferretry verified',
    );
    expect(lines({ verification: 'unknown' })).toContain('  Verified:   Ferretry verified 2.1.220');
    expect(lines({ verification: 'verified', installed: null })).toContain(
      '  Verified:   is the version Ferretry verified',
    );
  });

  test('a version that cannot be read is said, and the latest release is still reported', () => {
    const text = lines({ installed: { state: 'unreadable', reason: 'claude --version failed' } });
    expect(text[0]).toBe('Claude Code (version unreadable) - up to date');
    expect(text).toContain('  Version:    unreadable - claude --version failed');
  });

  test('a release check that never ran, or failed, is said as such, with the last known release when there is one', () => {
    const never = lines({ check: { state: 'never' } });
    expect(never[0]).toBe('Claude Code 2.1.220');
    expect(never).toContain('  Latest:     not checked');
    const failed = lines({ check: { state: 'failed', checkedAt: AT, reason: 'offline' } });
    expect(failed).toContain('  Latest:     the check at 2026-11-09T09:00:00.000Z failed: offline');
    const remembered = lines({
      check: {
        state: 'failed',
        checkedAt: AT,
        reason: 'offline',
        lastKnown: { checkedAt: AT, latest: { version: '2.1.219', url: 'https://example.invalid/r' } },
      },
    });
    expect(remembered).toContain(
      '  Latest:     the check at 2026-11-09T09:00:00.000Z failed: offline (last known 2.1.219)',
    );
    expect(remembered[0]).toBe('Claude Code 2.1.220 - up to date');
  });

  test('says how it was installed, and what updating takes: Ferretry’s own steps, or the manual ones', () => {
    const self = lines({
      method: { kind: 'native-installer', directory: '/home/me/.claude' },
      plan: {
        kind: 'self',
        steps: [{ command: 'claude update' }, { command: 'claude --version' }],
        rollback: 'none',
        pinsVersion: false,
      },
    });
    expect(self).toContain('  Installed:  native-installer');
    expect(self).toContain('  Update:     fy harness claude-code update - runs claude update, then claude --version');
    const manual = lines({
      plan: {
        kind: 'manual',
        explanation: 'This install is managed by Nix; update it there.',
        steps: [{ command: 'nix flake update claude-code', note: 'then rebuild' }, { command: 'home-manager switch' }],
      },
    });
    expect(manual).toContain('  Update:     This install is managed by Nix; update it there.');
    expect(manual).toContain('    nix flake update claude-code   # then rebuild');
    expect(manual).toContain('    home-manager switch');
  });

  test('says an update that is running, or the last one that finished', () => {
    expect(lines({ job: { state: 'running', startedAt: AT, command: 'claude update' } })).toContain(
      '  Updating:   running claude update',
    );
    expect(
      lines({
        job: {
          state: 'finished',
          report: { outcome: 'succeeded', message: 'Updated 2.1.219 to 2.1.220.', finishedAt: AT },
        },
      }),
    ).toContain('  Last update: Updated 2.1.219 to 2.1.220.');
  });
});
