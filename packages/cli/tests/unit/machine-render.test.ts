import { describe, it } from 'bun:test';
import should from 'should';
import type { ApplyOutcome } from '@ferretry/plugin-runtimes/contract';
import { renderChangeOutcome, renderChangeView } from '../../src/lib/machine/render.ts';

describe('the machine renderer says what a login change did', () => {
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
});

describe('the machine renderer says what a staged change would do', () => {
  const view = (preview: object, consequences: string[] = []) =>
    ({ summary: 'Do the thing', consequences, preview }) as never;

  it('should list the files saved, the folders prepared, the runtimes after and the ferrets running on them', () => {
    const text = renderChangeView(
      view(
        {
          kind: 'apply',
          documents: [{ path: 'config/runtimes/work.yaml' }, { path: 'config/profiles/work.yaml' }],
          operations: [{}, {}, {}],
          runtimes: [
            { name: 'work', harness: 'claude-code', agent: true, launch: { available: true } },
            { name: 'spare', harness: 'codex', agent: false, launch: { available: false, reason: 'not signed in' } },
          ],
          runningSessions: [{ id: 'ada-1', name: 'ada', harness: 'codex' }],
        },
        ['Moves nothing'],
      ),
    );

    should(text.split('\n')).deepEqual([
      'Do the thing',
      '  • Moves nothing',
      'Saves:',
      '  config/runtimes/work.yaml',
      '  config/profiles/work.yaml',
      'Prepares 3 files and folders for the runtimes.',
      'Runtimes after this change:',
      '  work (Claude Code, agent) — ready to launch',
      '  spare (Codex) — not signed in',
      'Running on it now:',
      '  ada (Codex) · ada-1',
    ]);
  });

  it('should say a single prepared item in the singular, and list nothing when the change touches nothing', () => {
    should(
      renderChangeView(view({ kind: 'apply', documents: [], operations: [{}], runtimes: [] })).split('\n'),
    ).deepEqual(['Do the thing', 'Prepares 1 file or folder for the runtimes.']);
    should(renderChangeView(view({ kind: 'apply', documents: [], operations: [], runtimes: [] }))).equal(
      'Do the thing',
    );
  });

  it('should say a sign-out signs the person out of their own terminal too, when it does', () => {
    const preview = { kind: 'sign-out', credential: 'work', runtimesAffected: 1, signsOutTerminal: true };
    should(renderChangeView(view(preview)).split('\n')).deepEqual([
      'Do the thing',
      'Signs out work: 1 runtime will need sign-in afterwards.',
      'This also signs out the same tool in your own terminal on this machine.',
    ]);
    should(renderChangeView(view({ ...preview, runtimesAffected: 2, signsOutTerminal: false }))).equal(
      'Do the thing\nSigns out work: 2 runtimes will need sign-in afterwards.',
    );
  });

  it('should print an executor’s own description', () => {
    should(renderChangeView(view({ kind: 'executor', executor: 'clone', description: 'copies the setup' }))).equal(
      'Do the thing\ncopies the setup',
    );
  });
});

describe('the machine renderer says how an applied change ended', () => {
  const result = (extra: object) => ({ accountCount: 1, operationCount: 1, ...extra }) as never;

  it('should say a commit left earlier files aside and a lock behind, and what it left as it was', () => {
    const rendered = renderChangeOutcome({
      outcome: 'applied',
      apply: {
        outcome: 'committed',
        result: result({
          backupResidue: ['a.bak', 'b.bak'],
          lockResidue: '/home/.lock',
          skipped: [{ path: '/homes/one/skills', reason: 'kept' }],
        }),
      },
    } as never);

    should(rendered).eql({
      ok: true,
      text: [
        'Done.',
        'Kept 2 earlier files aside: a.bak, b.bak',
        'Remove /home/.lock before the next change.',
        'Left /homes/one/skills as it was: kept',
      ].join('\n'),
    });
  });

  it('should say a commit with a single earlier file in the singular', () => {
    const rendered = renderChangeOutcome({
      outcome: 'applied',
      apply: { outcome: 'committed', result: result({ backupResidue: ['a.bak'] }) },
    } as never);
    should(rendered.text).equal('Done.\nKept 1 earlier file aside: a.bak');
  });

  it('should not call a change that saved but could not set up the shared history a success', () => {
    const rendered = renderChangeOutcome({
      outcome: 'applied',
      apply: {
        outcome: 'committed-with-history-failure',
        failedHarness: 'codex',
        reason: 'read-only',
        committed: result({ skipped: [{ path: '/h', reason: 'busy' }] }),
      },
    } as never);
    should(rendered).eql({
      ok: false,
      text: 'Saved, but the shared codex history could not be set up: read-only\nLeft /h as it was: busy',
    });
  });

  it('should say a rolled-back change changed nothing and why', () => {
    const rendered = renderChangeOutcome({
      outcome: 'applied',
      apply: { outcome: 'rolled-back', failedOperation: 'write runtimes/work.yaml', reason: 'disk full' },
    } as never);
    should(rendered).eql({ ok: false, text: 'Nothing changed. write runtimes/work.yaml failed: disk full' });
  });

  it('C2 should name a configuration file that landed before a rollback instead of saying nothing changed', () => {
    const rendered = renderChangeOutcome({
      outcome: 'applied',
      apply: {
        outcome: 'rolled-back',
        failedOperation: 'directory fleet/bin',
        reason: 'root refused: changed',
        configurationLanded: ['runtimes/work.yaml'],
      },
    } as never);
    should(rendered.ok).equal(false);
    should(rendered.text).not.containEql('Nothing changed');
    should(rendered.text).containEql('runtimes/work.yaml');
    should(rendered.text).containEql('NOT rolled back');
    should(rendered.text).containEql('Fix the cause and apply again, or remove it to undo the change.');
  });

  it('C2 should name a landed configuration file after a rollback that could not put everything back', () => {
    const rendered = renderChangeOutcome({
      outcome: 'applied',
      apply: {
        outcome: 'rollback-incomplete',
        failedOperation: 'directory fleet/bin',
        reason: 'root refused: changed',
        unrestored: [{ path: 'fleet/bin', reason: 'busy' }],
        configurationLanded: ['runtimes/a.yaml', 'runtimes/b.yaml'],
      },
    } as never);
    should(rendered.text).containEql('runtimes/a.yaml, runtimes/b.yaml');
    should(rendered.text).containEql('NOT rolled back');
  });

  it('should name every path a failed rollback could not put back, and where its original is', () => {
    const rendered = renderChangeOutcome({
      outcome: 'applied',
      apply: {
        outcome: 'rollback-incomplete',
        failedOperation: 'write a',
        reason: 'disk full',
        unrestored: [
          { path: '/a', reason: 'gone', backup: '/a.orig' },
          { path: '/b', reason: 'busy' },
        ],
      },
    } as never);
    should(rendered).eql({
      ok: false,
      text: 'write a failed (disk full) and these could not be put back:\n  /a: gone (the original is at /a.orig)\n  /b: busy',
    });
  });

  it('should say a sign-out, and a sign-out that failed', () => {
    should(renderChangeOutcome({ outcome: 'signed-out', credential: { id: 'work' } } as never)).eql({
      ok: true,
      text: 'Signed out work.',
    });
    should(
      renderChangeOutcome({ outcome: 'sign-out-failed', credential: { id: 'work' }, reason: 'no network' } as never),
    ).eql({ ok: false, text: 'Could not sign out work: no network' });
  });
});
