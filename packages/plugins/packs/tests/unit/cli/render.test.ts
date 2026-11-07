import { describe, it } from 'bun:test';
import should from 'should';
import {
  renderAvailable,
  renderGuide,
  renderPackRecommendation,
  renderRouting,
  routingWords,
} from '../../../cli/lib/render.ts';
import { option, PROMPT, packView, recommendation, at } from './fixtures.ts';

const SUGGESTED = {
  by: 'gpt-oss-120b',
  via: 'claude-work',
  at: at('2026-10-21T09:00:00.000Z'),
  acceptedAt: at('2026-10-22T10:00:00.000Z'),
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
      undo: { savedAt: at('2026-10-22T10:00:00.000Z'), source: 'file' },
    });

    // Act
    const text = renderGuide(view, 'foo');

    // Assert
    should(text.split('\n').slice(-1)).eql([
      'The prompt before the last accepted clean-up (2026-10-22) is kept: foo guide undo puts it back.',
    ]);
  });
});
