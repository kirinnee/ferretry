import { describe, it } from 'bun:test';
import should from 'should';
import type { ApplyOutcome } from '@ferretry/plugin-runtimes/contract';
import { renderChangeOutcome } from '../../src/lib/machine/render.ts';

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
