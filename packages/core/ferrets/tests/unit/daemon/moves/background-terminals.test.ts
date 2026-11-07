import { describe, it } from 'bun:test';
import should from 'should';
import { backgroundTerminalCount } from '../../../src/lib/migrate/background-terminals.ts';

describe('codex background terminal count', () => {
  it('should read the count out of a pane footer regardless of case or plurality', () => {
    // Act + Assert
    should(backgroundTerminalCount('  Esc to interrupt · 3 background terminals running')).equal(3);
    should(backgroundTerminalCount('1 Background Terminal Running')).equal(1);
    should(backgroundTerminalCount('12  background   terminals  running')).equal(12);
  });

  it('should report none when the footer says nothing about background terminals', () => {
    // Act + Assert
    should(backgroundTerminalCount('')).equal(0);
    should(backgroundTerminalCount('working (12s · 3.1k tokens)')).equal(0);
    should(backgroundTerminalCount('background terminals running')).equal(0);
  });
});
