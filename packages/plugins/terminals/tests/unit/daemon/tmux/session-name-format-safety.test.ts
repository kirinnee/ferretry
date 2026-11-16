import { describe, it } from 'bun:test';
import should from 'should';
import { ferretTmuxSession } from '../../../../daemon/adapters/tmux/tmux-runner.ts';
import { sessionTarget, windowTarget } from '../../../../daemon/lib/tmux/address.ts';
import { newSessionArguments } from '../../../../daemon/lib/tmux/commands.ts';
import { terminalTmuxSessionName } from '../../../../daemon/lib/terminal/runtime-policy.ts';

/**
 * tmux DOES expand formats in `new-session -s <name>` (verified on tmux 3.8), so every `-s` site is safe only
 * because the name is validated or sanitised first. These tests pin that: a later change that loosens an allowlist
 * and lets `#` (or any other format-significant character) through fails here, before it reaches tmux.
 */

/** Every character tmux's format expander, or its command parser, gives a meaning to. */
const FORMAT_SIGNIFICANT = ['#', '{', '}', '(', ')', '[', ']', ',', '%', '$', '\\', "'", '"', ';', ' ', ':', '=', '~'];

const HOSTILE_NAMES = [
  '#{session_name}',
  '##{session_name}',
  '#(touch pwned)',
  '#()',
  '##(',
  '###',
  'last#',
  'a#b',
  '雪🦦##',
  "q'uote",
  'q"uote',
  'per%cent',
  'with space',
];

/** The only characters a tmux session or window name may hold: the single allowlist in `address.ts`. */
const ALLOWED = /^[a-z0-9_.-]$/u;

describe('every character the tmux name allowlist lets through', () => {
  it('should be one of [a-z0-9_.-] and never a format-significant character', () => {
    // Arrange
    const accepted: string[] = [];
    // Act: probe every UTF-16 code unit as the tail of an otherwise valid name.
    for (let code = 0; code < 0x1_0000; code++) {
      const character = String.fromCharCode(code);
      try {
        sessionTarget(`a${character}`);
        accepted.push(character);
      } catch {
        // refused, as intended
      }
    }
    // Assert
    should(accepted.filter(character => !ALLOWED.test(character))).deepEqual([]);
    for (const significant of FORMAT_SIGNIFICANT) should(accepted).not.containEql(significant);
  });
});

describe('sessionTarget (the -s allowlist for lib/tmux/commands.ts and ferretTmuxSession)', () => {
  for (const name of HOSTILE_NAMES) {
    it(`should refuse ${JSON.stringify(name)}`, () => {
      should(() => sessionTarget(name)).throw(/lowercase tmux name/u);
    });
  }

  it('should refuse each format-significant character anywhere in the name', () => {
    for (const character of FORMAT_SIGNIFICANT) {
      for (const name of [`${character}abc`, `abc${character}`, `ab${character}c`])
        should(() => sessionTarget(name)).throw(/lowercase tmux name/u);
    }
  });

  it('should refuse a hostile window name too', () => {
    should(() => windowTarget('fy-a', '#{window_name}')).throw();
  });
});

describe('the new-session argv (lib/tmux/commands.ts)', () => {
  for (const session of HOSTILE_NAMES) {
    it(`should never build an argv around the session ${JSON.stringify(session)}`, () => {
      should(() => newSessionArguments({ session, cwd: '/work', command: ['sh'] })).throw();
    });
  }
});

describe('ferretTmuxSession (the -s name of the runner)', () => {
  for (const ferret of HOSTILE_NAMES) {
    it(`should refuse a ferret named ${JSON.stringify(ferret)}`, () => {
      should(() => ferretTmuxSession(ferret)).throw(/lowercase tmux name/u);
    });
  }

  it('should name an ordinary ferret with no format-significant character', () => {
    should(ferretTmuxSession('abc-123')).equal('fy-abc-123');
  });
});

describe('terminalTmuxSessionName (the -s name of a terminal)', () => {
  const ID = '0123456789abcdef';

  for (const owner of [...HOSTILE_NAMES, ...FORMAT_SIGNIFICANT.map(character => `own${character}er`)]) {
    it(`should sanitise the owner ${JSON.stringify(owner)} to [A-Za-z0-9_-] and keep the daemon id last`, () => {
      // Act
      const name = terminalTmuxSessionName(owner, ID);
      // Assert
      should(name).match(/^[A-Za-z0-9_-]+$/u);
      should(name).not.containEql('#');
      should(name.endsWith(ID)).be.true();
    });
  }

  it('should stay within the sanitised alphabet for an owner of any length', () => {
    should(terminalTmuxSessionName('#'.repeat(500), ID)).match(/^[A-Za-z0-9_-]+$/u);
  });
});
