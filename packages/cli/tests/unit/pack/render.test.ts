import { describe, it } from 'bun:test';
import should from 'should';
import {
  renderAvailable,
  renderGuide,
  renderPackNewOutcome,
  renderPackRecommendation,
  renderRouting,
  routingWords,
} from '../../../src/lib/pack/render.ts';
import { attempt, option, PROMPT, packView, recommendation, refused, started, startedView } from './fixtures.ts';

const SUGGESTED = {
  by: 'gpt-oss-120b',
  via: 'claude-work',
  at: '2026-10-21T09:00:00.000Z',
  acceptedAt: '2026-10-22T10:00:00.000Z',
};

describe('routingWords', () => {
  it('should say where the prompt came from in each of the three cases', () => {
    // Arrange + Act + Assert
    should(routingWords('file', undefined)).equal('your routing prompt');
    should(routingWords('file', SUGGESTED)).equal('cleaned up by gpt-oss-120b on 2026-10-22 and accepted');
    should(routingWords('file', { ...SUGGESTED, mode: 'generate' })).equal(
      'written by gpt-oss-120b on 2026-10-22 and accepted',
    );
    should(routingWords('default', undefined)).equal('the default, rendered from the model catalogs');
  });
});

describe('renderRouting', () => {
  it('should head the prompt with where it came from', () => {
    // Arrange + Act
    const text = renderRouting({ text: PROMPT, source: 'default' });

    // Assert
    should(text.split('\n')).eql(['Routing prompt (the default, rendered from the model catalogs):', PROMPT]);
  });
});

describe('renderPackRecommendation', () => {
  it('should print the prompt and where it came from, then the live list, then the first to start', () => {
    // Arrange + Act
    const text = renderPackRecommendation(recommendation());

    // Assert
    should(text.split('\n')).eql([
      'Routing prompt (your routing prompt):',
      PROMPT,
      '',
      'Models usable here now (1):',
      'ready  Haiku 5.5 (claude-haiku-5-5) at low · claude-work · quota 5h 2% · week 46% · named 2nd in the prompt',
      '       fy new --runtime claude-work --model claude-haiku-5-5 --effort low "<brief>"',
      '',
      'Start the first: fy new --runtime claude-work --model claude-haiku-5-5 --effort low "<brief>"',
    ]);
  });

  it('should keep the daemon order and show a model that cannot run with its refusal and no command', () => {
    // Arrange
    const text = renderPackRecommendation(
      recommendation({
        routing: { text: PROMPT, source: 'file', suggested: SUGGESTED },
        available: [
          option(),
          option({
            model: 'claude-opus-5-5',
            modelLabel: 'Opus 5.5',
            runtime: 'claude-off',
            ready: false,
            refusal: { code: 'not_logged_in', message: 'claude-off needs signing in.' },
            quota: { state: 'unknown', windows: [], summary: 'not measured' },
            named: 1,
            command: undefined,
            effort: 'max',
          }),
        ],
        next: undefined,
      }),
    );

    // Assert
    const lines = text.split('\n');
    should(lines[0]).equal('Routing prompt (cleaned up by gpt-oss-120b on 2026-10-22 and accepted):');
    should(lines[4]).startWith('ready  Haiku 5.5');
    should(lines.slice(6)).eql([
      'cannot Opus 5.5 (claude-opus-5-5) at max · claude-off · named 1st in the prompt',
      '       not_logged_in: claude-off needs signing in.',
    ]);
    should(text).not.containEql('Start the first');
  });

  it('should leave out what a model does not have: a name position, an effort, a measured quota', () => {
    // Arrange + Act
    const text = renderAvailable([
      option({
        named: undefined,
        effort: undefined,
        command: undefined,
        quota: { state: 'unknown', windows: [], summary: 'not measured' },
      }),
    ]);

    // Assert
    should(text.split('\n')).eql(['Models usable here now (1):', 'ready  Haiku 5.5 (claude-haiku-5-5) · claude-work']);
  });

  it('should word positions 3, 4, 11, 12, 13 and 21 as English ordinals', () => {
    // Arrange + Act
    const text = renderAvailable([3, 4, 11, 12, 13, 21].map(named => option({ named })));

    // Assert
    const said = text.split('\n').flatMap(line => line.match(/named (\S+) in/u)?.[1] ?? []);
    should(said).eql(['3rd', '4th', '11th', '12th', '13th', '21st']);
  });

  it('should print an empty list as nothing runnable', () => {
    // Arrange + Act
    const text = renderPackRecommendation(recommendation({ available: [], next: undefined }));

    // Assert
    should(text.split('\n').slice(-1)).eql(['No model can run here now.']);
  });
});

describe('renderGuide', () => {
  it('should print the prompt in effect and where it came from', () => {
    // Arrange + Act
    const text = renderGuide(packView(), 'fy');

    // Assert
    should(text.split('\n')).eql(['Routing prompt (your routing prompt):', PROMPT]);
  });

  it('should say a clean-up can be undone, naming the command', () => {
    // Arrange
    const view = packView({
      routing: { text: PROMPT, source: 'file', suggested: SUGGESTED },
      undo: { savedAt: '2026-10-22T10:00:00.000Z', source: 'file' },
    });

    // Act
    const text = renderGuide(view, 'foo');

    // Assert
    should(text.split('\n').slice(-1)).eql([
      'The prompt before the last accepted clean-up (2026-10-22) is kept: foo guide undo puts it back.',
    ]);
  });
});

describe('renderPackNewOutcome', () => {
  it("should name the sub-ferret's card and its board, and say what the board could not do", () => {
    // Act
    const named = renderPackNewOutcome(
      started({
        card: { id: 'F413', project: 'Ferretry', leadCard: 'F412', note: 'You had no card, so &F412 was made.' },
      }),
      'fy',
    );
    const bare = renderPackNewOutcome(started({ card: { id: 'F413' } }), 'fy');
    const unmade = renderPackNewOutcome(started({ card: { note: 'No card was made: the board is down' } }), 'fy');
    const none = renderPackNewOutcome(started(), 'fy');

    // Assert
    should(named).containEql('Its card is &F413 on the Ferretry board.\nYou had no card, so &F412 was made.');
    should(bare).containEql('Its card is &F413.');
    should(unmade).containEql('No card was made: the board is down');
    should(unmade).not.containEql('Its card is');
    should(none).not.containEql('card');
  });

  it('should time a probe that passed and one that failed, and name a failed probe another start shared', () => {
    // Arrange
    const outcome = refused({
      refusal: { code: 'out_of_quota', message: 'quota' },
      attempts: [
        attempt({
          runtime: 'a',
          outcome: 'refused',
          probe: 'cached',
          probeMs: 10,
          refusal: { code: 'out_of_quota', message: 'q' },
        }),
      ],
    });

    // Act
    const passed = renderPackNewOutcome(started({ attempts: [attempt({ probe: 'ran', probeMs: 640 })] }), 'fy');

    // Assert
    should(passed).containEql('  started claude-work (probe OK 640 ms)');
    should(renderPackNewOutcome(outcome, 'fy')).containEql('  refused a (probe failed, shared) — out_of_quota: q');
  });

  it('should say who started, on what, decided by whom, then how to wait', () => {
    // Arrange
    const outcome = started({ view: startedView({ model: 'claude-haiku-4-5' }), decidedBy: 'routing' });

    // Act
    const text = renderPackNewOutcome(outcome, 'fy');

    // Assert
    should(text.split('\n')).eql([
      'Started child-1 on claude-work, claude-haiku-4-5 — decided by the routing prompt.',
      'Wait for its result: fy wait child-1',
    ]);
  });

  it('should name the teammate and credit the asking ferret when it decided', () => {
    // Arrange
    const outcome = started({ view: startedView({ teammate: 'Fix Scrolling' }), decidedBy: 'agent' });

    // Act
    const text = renderPackNewOutcome(outcome, 'foo');

    // Assert
    should(text.split('\n')).eql([
      'Started Fix Scrolling (child-1) on claude-work — decided by you.',
      'Wait for its result: foo wait child-1',
    ]);
  });

  it('should include the note and every attempt: started, probed, cached, refused', () => {
    // Arrange
    const outcome = started({
      decidedBy: 'jev',
      note: 'Jev could not decide, so the routing order was used.',
      attempts: [
        attempt({
          runtime: 'codex-work',
          model: 'gpt-x',
          outcome: 'refused',
          probe: 'ran',
          probeMs: 1200,
          refusal: { code: 'probe_failed', message: 'no answer' },
        }),
        attempt({ runtime: 'claude-work', model: 'opus', probe: 'cached' }),
        attempt({ runtime: 'claude-work', probe: 'ran' }),
        attempt({ runtime: 'claude-work', outcome: 'refused' }),
      ],
    });

    // Act
    const text = renderPackNewOutcome(outcome, 'fy');

    // Assert
    should(text.split('\n')).eql([
      'Started child-1 on claude-work — decided by jev.',
      'Jev could not decide, so the routing order was used.',
      '  refused codex-work gpt-x (probe failed 1200 ms) — probe_failed: no answer',
      '  started claude-work opus (probe OK, cached)',
      '  started claude-work (probe OK)',
      '  refused claude-work — refused: ',
      'Wait for its result: fy wait child-1',
    ]);
  });

  it('should render a refusal with its remedy and the attempts that led to it', () => {
    // Arrange
    const outcome = refused({
      refusal: { code: 'no_candidate', message: 'nothing can run it', remedy: 'check the routing prompt' },
      attempts: [attempt({ outcome: 'refused', refusal: { code: 'cli_missing', message: 'not installed' } })],
    });

    // Act
    const text = renderPackNewOutcome(outcome, 'fy');

    // Assert
    should(text.split('\n')).eql([
      'refused (no_candidate): nothing can run it',
      'check the routing prompt',
      '',
      'Tried:',
      '  refused claude-work — cli_missing: not installed',
    ]);
  });

  it('should render a bare refusal with no remedy and no attempts', () => {
    // Arrange + Act
    const text = renderPackNewOutcome(refused(), 'fy');

    // Assert
    should(text).equal('refused (limit_reached): you have 4 running sub-ferrets');
  });
});
