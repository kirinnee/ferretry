import { describe, it } from 'bun:test';
import should from 'should';
import type { ApplyOutcome } from '../../../../contract/index.ts';
import {
  count,
  indent,
  listOrNone,
  renderChangeOutcome,
  renderChangeView,
} from '../../../../cli/lib/fleet/account-render.ts';
import { changeView } from './account-fakes.ts';

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
            runningSessions: [{ id: 's-1', name: 'Fisher', harness: 'claude-code' }],
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
  const committedResult = {
    accountCount: 1,
    operationCount: 1,
    manifestPath: '/m.json',
    prunedWrappers: [],
    sharedHistory: [],
    skipped: [{ path: '/homes/one/skills', reason: 'not on this platform' }],
  } as unknown as Extract<ApplyOutcome, { outcome: 'committed' }>['result'];
  const committed: ApplyOutcome = { outcome: 'committed', result: committedResult };

  it('should say what a login change did, not just Done', () => {
    should(renderChangeOutcome({ outcome: 'login-changed', result: 'applied', summary: 'Label login work Work' })).eql({
      ok: true,
      text: 'Label login work Work: done.',
    });
  });

  it('should still say Done for an applied login change that carries no summary', () => {
    should(renderChangeOutcome({ outcome: 'login-changed', result: 'applied' })).eql({ ok: true, text: 'Done.' });
  });

  it('should include the move when a login removal moved runtimes first, and what it left as it was', () => {
    const rendered = renderChangeOutcome({
      outcome: 'login-changed',
      result: 'applied',
      summary: 'Remove login claude-you',
      moved: committed,
    });

    should(rendered).eql({
      ok: true,
      text: 'Remove login claude-you: done.\nMoved the runtimes first.\nLeft /homes/one/skills as it was: not on this platform',
    });
  });

  it('should say what was saved and held for the owner, with the summary and the move', () => {
    const rendered = renderChangeOutcome({
      outcome: 'login-changed',
      result: 'held',
      summary: 'Remove login spare',
      sentences: ['login "spare"\'s daily hard limit in dollars is removed (was 5)'],
      moved: committed,
    });

    should(rendered.ok).equal(true);
    should(rendered.text).equal(
      [
        'Remove login spare',
        'Saved, but this loosens something, so the owner has to confirm it before it takes effect. The tighter version stays in effect until then:',
        '  • login "spare"\'s daily hard limit in dollars is removed (was 5)',
        'Moved the runtimes first.',
        'Left /homes/one/skills as it was: not on this platform',
      ].join('\n'),
    );
  });

  it('should not call a login change that moved runtimes badly a success', () => {
    const rendered = renderChangeOutcome({
      outcome: 'login-changed',
      result: 'applied',
      summary: 'Remove login x',
      moved: {
        outcome: 'committed-with-history-failure',
        failedHarness: 'claude-code',
        reason: 'busy',
        committed: committedResult as never,
      },
    });

    should(rendered.ok).equal(false);
  });

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
        failedHarness: 'claude-code',
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

  it('BG-031 should not open a list of paths that is empty after an incomplete rollback that only moved things aside', () => {
    const rendered = renderChangeOutcome({
      outcome: 'applied',
      apply: {
        outcome: 'rollback-incomplete',
        failedOperation: 'link',
        reason: 'denied',
        unrestored: [],
        configurationLanded: ['runtimes/work.yaml'],
      },
    });
    should(rendered.text).not.containEql('could not be put back');
    should(rendered.text).startWith('link failed (denied).');
  });

  it('BG-031 OM7 should name the landed configuration file after an incomplete rollback, and say what to do', () => {
    const rendered = renderChangeOutcome({
      outcome: 'applied',
      apply: {
        outcome: 'rollback-incomplete',
        failedOperation: 'link',
        reason: 'denied',
        unrestored: [{ path: '/p', reason: 'gone' }],
        configurationLanded: ['runtimes/work.yaml'],
      },
    });
    should(rendered.text).containEql('The configuration runtimes/work.yaml was written first and is NOT rolled back');
    should(rendered.text).containEql(
      'Fix the cause and apply again; to undo the change instead, put that file back as it was.',
    );
  });

  it('BG-027 a rolled-back edit or removal never tells the owner to remove the file', () => {
    for (const landed of [['runtimes/work.yaml'], ['runtimes/work.yaml', 'profiles/main.yaml']]) {
      const rendered = renderChangeOutcome({
        outcome: 'applied',
        apply: {
          outcome: 'rolled-back',
          failedOperation: 'directory fleet/bin',
          reason: 'refused',
          configurationLanded: landed,
        },
      } as never);
      should(rendered.text).not.match(/remove (it|them)/u);
      should(rendered.text).match(/put (that file|those files) back as (it was|they were)\./u);
    }
  });

  it('should report a sign-out', () => {
    should(renderChangeOutcome({ outcome: 'signed-out', credential: { id: 'claude-you' } })).eql({
      ok: true,
      text: 'Signed out claude-you.',
    });
  });
});
