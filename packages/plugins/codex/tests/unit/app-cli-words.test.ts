/**
 * Every sentence Settings › Codex and `fy harness codex status` can say, one view at a time: where Codex is, how it was
 * installed, what was checked, and which buttons an update offers. The words are decided from the daemon's view alone.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import {
  headline,
  installWords,
  jobWords,
  knownLatest,
  latestWords,
  locationWords,
  shouldPoll,
  startRefusal,
  unverifiedQuestion,
  updateChoices,
  verificationBadge,
} from '../../app/lib/model.ts';
import { renderStatus } from '../../cli/lib/render.ts';
import type { HarnessCliView } from '../../contract/index.ts';
import { ABSENT_VIEW } from '../../contract/testing/index.ts';

const AT = '2026-10-20T09:00:00.000Z';
const NOW = Date.parse(AT);
const ago = (milliseconds: number): never => new Date(NOW - milliseconds).toISOString() as never;
const MINUTE = 60_000;

const located = {
  state: 'located',
  path: '/opt/bin/codex',
  rule: 'inherited environment',
  declaredBy: 'PATH',
} as const;
const selfPlan = (pinsVersion: boolean): HarnessCliView['plan'] => ({
  kind: 'self',
  steps: [{ command: 'npm install -g @openai/codex@latest' }, { command: 'codex --version' }],
  rollback: pinsVersion ? 'automatic' : 'none',
  pinsVersion,
});
const view = (extra: Partial<HarnessCliView> = {}): HarnessCliView => ({
  ...ABSENT_VIEW,
  location: located,
  installed: { state: 'ok', version: '0.145.0' },
  method: { kind: 'npm-global', tool: 'npm', package: '@openai/codex' },
  plan: selfPlan(true),
  check: { state: 'ok', checkedAt: AT as never, latest: { version: '0.145.0', url: 'https://example.test' } },
  verification: 'verified',
  available: true,
  ...extra,
});
const withVersions = (installed: string, latest: string, extra: Partial<HarnessCliView> = {}) =>
  view({
    installed: { state: 'ok', version: installed },
    check: { state: 'ok', checkedAt: AT as never, latest: { version: latest, url: 'https://example.test' } },
    ...extra,
  });
const keys = (choices: ReturnType<typeof updateChoices>) => choices.map(choice => choice.key);

describe('the card’s heading, place and badge', () => {
  it('names Codex alone when it is not usable, and with its version when it is', () => {
    should(headline(ABSENT_VIEW)).equal('Codex');
    should(headline(view())).equal('Codex 0.145.0');
    should(headline(view({ installed: { state: 'unreadable', reason: 'x' } }))).equal('Codex (version unreadable)');
    should(headline(view({ installed: null }))).equal('Codex (version unreadable)');
  });

  it('says which file runs and why, why a named path is no good, and where it looked when it found nothing', () => {
    should(locationWords(located)).equal('inherited environment (PATH)');
    should(
      locationWords({ state: 'override-absent', path: '/x', declaredBy: 'FY_CODEX_BIN', reason: 'no such file' }),
    ).equal('no such file');
    should(locationWords({ state: 'absent', searched: [] })).equal('Not found on this daemon’s PATH.');
    should(locationWords({ state: 'absent', searched: ['/a', '/b'] })).equal(
      'Not found on this daemon’s PATH or in /a, /b.',
    );
  });

  it('badges each standing against what Ferretry verified', () => {
    should((['verified', 'older', 'unverified', 'unknown'] as const).map(each => verificationBadge(each).text)).eql([
      'Verified by Ferretry',
      'Older than verified',
      'Not yet verified by Ferretry',
      'Version unknown',
    ]);
  });
});

describe('how it was installed, in words', () => {
  it('describes every method with the detail that lets a person recognise their own install', () => {
    should(installWords(null)).be.undefined();
    should(
      installWords({
        kind: 'npm-global',
        tool: 'npm',
        package: '@openai/codex',
        prefix: '/p',
        nodeManager: 'nvm',
      }),
    ).equal('npm global package @openai/codex in /p (node from nvm)');
    should(installWords({ kind: 'npm-global', tool: 'bun', package: '@openai/codex' })).equal(
      'bun global package @openai/codex',
    );
    should(installWords({ kind: 'nix-profile', element: 'codex' })).equal('nix profile element codex');
    should(installWords({ kind: 'nix-shell', storePath: '/nix/store/x' })).equal('nix shell store path /nix/store/x');
    should(installWords({ kind: 'nix-module', manager: 'nixos' })).equal('nixos module');
    should(installWords({ kind: 'nix-module', manager: 'home-manager', via: 'nix-darwin' })).equal(
      'home-manager (via nix-darwin) module',
    );
    should(installWords({ kind: 'standalone', directory: '/opt/x' })).equal('standalone binary in /opt/x');
    should(installWords({ kind: 'unknown', reason: 'odd' })).equal('unrecognised install (odd)');
  });
});

describe('when it was checked, and what happened since', () => {
  it('says how long ago in the largest unit that fits, and “just now” inside a minute', () => {
    const ok = (milliseconds: number) =>
      latestWords({ state: 'ok', checkedAt: ago(milliseconds), latest: { version: '0.150.0', url: 'u' } }, NOW);
    should(ok(10_000)).equal('0.150.0 on npm, checked just now.');
    should(ok(MINUTE)).equal('0.150.0 on npm, checked 1 minute ago.');
    should(ok(5 * MINUTE)).equal('0.150.0 on npm, checked 5 minutes ago.');
    should(ok(60 * MINUTE)).equal('0.150.0 on npm, checked 1 hour ago.');
    should(ok(3 * 60 * MINUTE)).equal('0.150.0 on npm, checked 3 hours ago.');
    should(ok(24 * 60 * MINUTE)).equal('0.150.0 on npm, checked 1 day ago.');
    should(ok(48 * 60 * MINUTE)).equal('0.150.0 on npm, checked 2 days ago.');
    should(ok(-5 * MINUTE)).equal('0.150.0 on npm, checked just now.');
  });

  it('says a failed check with the answer before it when there was one, and plainly when there was not', () => {
    should(latestWords({ state: 'failed', checkedAt: ago(2 * MINUTE), reason: 'offline' }, NOW)).equal(
      'The check 2 minutes ago failed: offline.',
    );
    should(
      latestWords(
        {
          state: 'failed',
          checkedAt: ago(2 * MINUTE),
          reason: 'offline',
          lastKnown: { checkedAt: ago(3 * 60 * MINUTE), latest: { version: '0.150.0', url: 'u' } },
        },
        NOW,
      ),
    ).equal('The check 2 minutes ago failed: offline. The last answer, 3 hours ago, said 0.150.0.');
  });

  it('knows the newest release from this check or the last good one, and none from a check never made', () => {
    should(knownLatest({ state: 'never' })).be.undefined();
    should(knownLatest({ state: 'failed', checkedAt: AT as never, reason: 'x' })).be.undefined();
    should(
      knownLatest({
        state: 'failed',
        checkedAt: AT as never,
        reason: 'x',
        lastKnown: { checkedAt: AT as never, latest: { version: '0.150.0', url: 'u' } },
      }),
    ).equal('0.150.0');
  });

  it('puts a running update in the pending tone and a finished one in the tone of how it ended', () => {
    const finished = (outcome: 'succeeded' | 'failed' | 'rolled-back' | 'unchanged') =>
      jobWords({
        state: 'finished',
        report: { outcome, message: `it ${outcome}`, finishedAt: AT as never },
      });
    should(jobWords({ state: 'running', command: 'npm install', startedAt: AT as never })).eql({
      tone: 'pend',
      text: 'Updating — running npm install',
    });
    should(finished('succeeded')).eql({ tone: 'ok', text: 'it succeeded' });
    should(finished('failed')).eql({ tone: 'err', text: 'it failed' });
    should(finished('rolled-back').tone).equal('warn');
    should(finished('unchanged').tone).equal('warn');
    should(shouldPoll(view({ job: { state: 'running', command: 'x', startedAt: AT as never } }))).be.true();
    should(shouldPoll(view())).be.false();
  });
});

describe('which buttons an update offers', () => {
  it('offers none unless Ferretry can run the update and there is something newer', () => {
    should(updateChoices(ABSENT_VIEW)).eql([]);
    should(updateChoices(view({ available: false }))).eql([]);
    const manual: HarnessCliView['plan'] = { kind: 'manual', explanation: 'x', steps: [] };
    should(updateChoices(view({ plan: manual }))).eql([]);
  });

  it('offers a single Update for a method that takes what it has, unverified when the newest or an unknown is past what was verified', () => {
    const takes = selfPlan(false);
    const one = (latest: string | undefined) =>
      updateChoices(
        latest === undefined
          ? view({ plan: takes, check: { state: 'never' } })
          : withVersions('0.140.0', latest, { plan: takes }),
      ).map(choice => [choice.key, choice.unverified, choice.primary]);
    should(one('0.145.0')).eql([['newest', false, true]]);
    should(one('0.160.0')).eql([['newest', true, false]]);
    should(one(undefined)).eql([['newest', true, false]]);
  });

  it('offers the verified version first and the newest after it, for a method that installs a chosen one', () => {
    should(
      updateChoices(withVersions('0.140.0', '0.160.0')).map(choice => [
        choice.target,
        choice.unverified,
        choice.primary,
      ]),
    ).eql([
      ['0.145.0', false, true],
      ['0.160.0', true, false],
    ]);
    should(updateChoices(withVersions('0.140.0', '0.145.0')).map(choice => [choice.target, choice.primary])).eql([
      ['0.145.0', true],
    ]);
    should(updateChoices(withVersions('0.150.0', '0.160.0')).map(choice => choice.target)).eql(['0.160.0']);
    should(updateChoices(withVersions('0.160.0', '0.160.0'))).eql([]);
  });

  it('offers the newest when the installed version cannot be read, since any version is newer than none', () => {
    should(keys(updateChoices(view({ installed: { state: 'unreadable', reason: 'x' } })))).eql(['latest']);
    should(
      updateChoices(withVersions('0.140.0', '0.160.0', { installed: { state: 'unreadable', reason: 'x' } })).map(
        choice => choice.target,
      ),
    ).eql(['0.145.0', '0.160.0']);
  });

  it('orders prereleases of one release, and does not order what is not a version', () => {
    should(updateChoices(withVersions('0.145.0-alpha', '0.145.0-beta')).map(choice => choice.target)).eql([
      '0.145.0-beta',
    ]);
    should(updateChoices(withVersions('0.145.0-beta', '0.145.0-alpha'))).eql([]);
    should(updateChoices(withVersions('0.145.0-rc.1', '0.145.0-rc.1'))).eql([]);
    should(updateChoices(withVersions('0.145.0-rc.1', '0.145.0')).map(choice => choice.target)).eql(['0.145.0']);
    should(updateChoices(withVersions('0.145.0', '0.145.0-rc.1'))).eql([]);
    should(updateChoices(withVersions('nightly', '0.160.0')).map(choice => choice.target)).eql([]);
  });

  it('asks the question the confirm box asks, with or without a named version', () => {
    should(unverifiedQuestion(view(), undefined)).containEql('cannot tell which Codex version this installs');
    should(unverifiedQuestion(view(), '0.160.0')).containEql('Codex 0.160.0 has not been verified');
  });
});

describe('what a refused update turns into', () => {
  it('is the confirm it needs, with or without a version, or the daemon’s own sentence', () => {
    const refused = (body: unknown) => startRefusal({ code: 'harness_update_unverified', body });
    should(refused({ error: 'x', code: 'harness_update_unverified', verified: '0.145.0' })).eql({
      kind: 'unverified',
      verified: '0.145.0',
    });
    should(refused({ nonsense: true })).eql({ kind: 'message', text: '[object Object]' });
    should(startRefusal('plain words')).eql({ kind: 'message', text: 'plain words' });
    should(startRefusal(null)).eql({ kind: 'message', text: 'null' });
    should(startRefusal({ message: 7 })).eql({ kind: 'message', text: '[object Object]' });
  });
});

describe('fy harness codex status, in every state', () => {
  it('says where it searched when Codex is nowhere, and why a named path is not usable', () => {
    should(renderStatus({ ...ABSENT_VIEW, location: { state: 'absent', searched: ['/a', '/b'] } }, 'fy')).equal(
      'Codex: not found on this machine\n  Searched PATH and /a, /b.',
    );
    should(
      renderStatus(
        view({
          location: { state: 'override-absent', path: '/x', declaredBy: 'FY_CODEX_BIN', reason: 'no such file' },
        }),
        'fy',
      ),
    ).equal('Codex: not usable - no such file');
  });

  it('says where each standing against the verified version is, in its own words', () => {
    const text = (extra: Partial<HarnessCliView>) => renderStatus(view(extra), 'fy');
    should(text({ verification: 'verified' })).containEql('Verified:   0.145.0 is the version Ferretry verified');
    should(text({ verification: 'verified', installed: null })).containEql(
      'Verified:   is the version Ferretry verified',
    );
    should(text({ verification: 'older' })).containEql('older than 0.145.0, the version Ferretry verified');
    should(text({ verification: 'unverified' })).containEql(
      'not yet verified by Ferretry (verified: 0.145.0) - https://example.invalid/codex',
    );
    should(text({ verification: 'unknown' })).containEql('Verified:   Ferretry verified 0.145.0');
  });

  it('says whether it is up to date, behind, or unchecked, and flags a newest one nobody verified', () => {
    should(renderStatus(withVersions('0.145.0', '0.145.0', { available: false }), 'fy')).containEql(
      'Codex 0.145.0 - up to date',
    );
    should(renderStatus(withVersions('0.140.0', '0.160.0', { verification: 'unverified' }), 'fy')).containEql(
      'Codex 0.140.0 - update available: 0.160.0 (not yet verified by Ferretry)',
    );
    const unchecked = renderStatus(view({ check: { state: 'never' }, installed: null }), 'fy');
    should(unchecked).containEql('Codex (version unreadable)\n');
    should(unchecked).containEql('Latest:     not checked');
  });

  it('says an unreadable version, a failed check with the last answer, and what installed it', () => {
    const text = renderStatus(
      view({
        installed: { state: 'unreadable', reason: 'timed out' },
        check: {
          state: 'failed',
          checkedAt: AT as never,
          reason: 'offline',
          lastKnown: { checkedAt: AT as never, latest: { version: '0.150.0', url: 'u' } },
        },
      }),
      'fy',
    );
    should(text).containEql('Version:    unreadable - timed out');
    should(text).containEql(`Latest:     the check at ${AT} failed: offline (last known 0.150.0)`);
    should(text).containEql('Installed:  npm-global');
    should(
      renderStatus(view({ check: { state: 'failed', checkedAt: AT as never, reason: 'offline' } }), 'fy'),
    ).containEql(`failed: offline\n`);
  });

  it('shows the manual steps with their notes, a running update, and the last update’s message', () => {
    const manual = renderStatus(
      view({
        plan: {
          kind: 'manual',
          explanation: 'Do it yourself.',
          steps: [{ command: 'nix flake update nixpkgs', note: 'in your flake' }, { command: 'switch' }],
        },
        method: null,
        job: { state: 'running', command: 'brew update', startedAt: AT as never },
      }),
      'fy',
    );
    should(manual).containEql('Update:     Do it yourself.');
    should(manual).containEql('    nix flake update nixpkgs   # in your flake');
    should(manual).containEql('\n    switch\n');
    should(manual).containEql('Updating:   running brew update');
    should(manual).not.containEql('Installed:');
    should(
      renderStatus(
        view({
          job: { state: 'finished', report: { outcome: 'succeeded', message: 'Updated.', finishedAt: AT as never } },
        }),
        'fy',
      ),
    ).containEql('Last update: Updated.');
  });
});
