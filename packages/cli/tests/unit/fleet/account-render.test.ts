import { describe, it } from 'bun:test';
import should from 'should';
import {
  count,
  indent,
  listOrNone,
  renderChangeOutcome,
  renderChangeView,
} from '../../../src/lib/fleet/account-render.ts';
import { changeView, credential } from './account-fakes.ts';

const result = { accountCount: 1, operationCount: 1, manifestPath: '/m.json', prunedWrappers: [], sharedHistory: [] };

describe('account-model words', () => {
  it('should count, indent and list in plain words', () => {
    should(count(1, 'runtime')).equal('1 runtime');
    should(count(3, 'runtime')).equal('3 runtimes');
    should(indent(['a'], 2)).eql(['    a']);
    should(listOrNone([])).equal('none');
    should(listOrNone(['a', 'b'])).equal('a, b');
  });

  it('should leave out what a preview does not have', () => {
    const text = renderChangeView(
      changeView(
        { kind: 'runtime.remove', name: 'x' },
        {
          consequences: [],
          preview: { kind: 'apply', operations: [], documents: [], runtimes: [] },
        },
      ),
    );
    should(text).equal('Add runtime claude-work');
  });

  it('should list the sessions still running on a runtime a change removes', () => {
    const text = renderChangeView(
      changeView(
        { kind: 'runtime.remove', name: 'x' },
        {
          consequences: [],
          preview: {
            kind: 'apply',
            operations: [],
            documents: [],
            runtimes: [],
            runningSessions: [{ id: 's-1', name: 'Fisher', harness: 'claude' }],
          },
        },
      ),
    );
    should(text).match(/Running on it now:\n {2}Fisher \(Claude Code\) · s-1/);
  });

  it('should say when a runtime cannot launch, and a sign-out that keeps the terminal signed in', () => {
    const apply = renderChangeView(
      changeView(
        { kind: 'runtime.remove', name: 'x' },
        {
          preview: {
            kind: 'apply',
            operations: [],
            documents: [],
            runtimes: [
              {
                name: 'codex-a',
                harness: 'codex',
                agent: false,
                launch: { available: false, reason: 'Sign in to launch' },
              },
            ],
          },
        },
      ),
    );
    should(apply).match(/codex-a \(Codex\) — Sign in to launch/);
    const signOut = renderChangeView(
      changeView(
        { kind: 'credential.signout', id: 'c' },
        {
          preview: { kind: 'sign-out', credential: 'c', runtimesAffected: 1, signsOutTerminal: false },
        },
      ),
    );
    should(signOut)
      .match(/1 runtime will need/)
      .and.not.match(/terminal/);
  });
});

describe('renderChangeOutcome', () => {
  it('should report a committed apply and the residue it left', () => {
    const rendered = renderChangeOutcome({
      outcome: 'applied',
      apply: { outcome: 'committed', result: { ...result, backupResidue: ['/a.bak'], lockResidue: '/lock' } },
    });
    should(rendered).eql({
      ok: true,
      text: 'Done.\nKept 1 earlier file aside: /a.bak\nRemove /lock before the next change.',
    });
  });

  it('should say which operations a committed apply left as they were', () => {
    const rendered = renderChangeOutcome({
      outcome: 'applied',
      apply: {
        outcome: 'committed',
        result: { ...result, skipped: [{ path: '/homes/one/skills', reason: 'not on this platform' }] },
      },
    });
    should(rendered).eql({ ok: true, text: 'Done.\nLeft /homes/one/skills as it was: not on this platform' });
  });

  it('should say what was left as it was when the shared history failed after the commit', () => {
    const rendered = renderChangeOutcome({
      outcome: 'applied',
      apply: {
        outcome: 'committed-with-history-failure',
        failedHarness: 'claude',
        reason: 'busy',
        committed: {
          ...result,
          manifest: { generatedAt: '2026-10-13T00:00:00.000Z', accounts: [] } as never,
          skipped: [{ path: '/homes/one/skills', reason: 'not on this platform' }],
        },
      },
    });
    should(rendered).match({ ok: false, text: /\nLeft \/homes\/one\/skills as it was: not on this platform$/u });
  });

  it('should not trust a commit whose shared history failed', () => {
    const rendered = renderChangeOutcome({
      outcome: 'applied',
      apply: {
        outcome: 'committed-with-history-failure',
        failedHarness: 'codex',
        reason: 'busy',
        committed: { ...result, manifest: { generatedAt: '2026-10-13T00:00:00.000Z', accounts: [] } as never },
      },
    });
    should(rendered.ok).be.false();
    should(rendered.text).match(/shared codex history/);
  });

  it('should name what an incomplete rollback could not put back', () => {
    const rendered = renderChangeOutcome({
      outcome: 'applied',
      apply: {
        outcome: 'rollback-incomplete',
        failedOperation: 'link',
        reason: 'denied',
        unrestored: [
          { path: '/p', reason: 'gone', backup: '/p.bak' },
          { path: '/q', reason: 'gone' },
        ],
      },
    });
    should(rendered.ok).be.false();
    should(rendered.text)
      .match(/\/p: gone \(the original is at \/p\.bak\)/)
      .and.match(/\/q: gone$/m);
  });

  it('should report a sign-out', () => {
    should(renderChangeOutcome({ outcome: 'signed-out', credential: credential() })).eql({
      ok: true,
      text: 'Signed out claude-you.',
    });
  });
});
