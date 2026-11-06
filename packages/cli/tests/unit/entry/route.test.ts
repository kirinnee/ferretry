import { describe, it } from 'bun:test';
import should from 'should';
import { entrySlice, SLICE_COMMANDS } from '../../../src/lib/entry/route.ts';

describe('entrySlice', () => {
  it('should send every command a slice lists to that slice', () => {
    // Arrange
    const listed = Object.entries(SLICE_COMMANDS).flatMap(([slice, commands]) =>
      commands.map(command => ({ slice, command })),
    );

    // Act
    const routed = listed.map(({ command }) => entrySlice([command, 'mw0-x']));

    // Assert
    should(routed).eql(listed.map(({ slice }) => slice));
  });

  it('should route on the command alone, whatever follows it', () => {
    // Arrange + Act + Assert — a subcommand, an option or a help flag after the command keep the slice,
    // because the slice registers the whole group and answers its own help.
    should(entrySlice(['mcp', 'serve'])).equal('mcp');
    should(entrySlice(['wait', 'mw0-x', '--keep', '--as-owner'])).equal('reads');
    should(entrySlice(['wait', '--help'])).equal('reads');
  });

  it('should load the full program for anything that is not a sliced command first', () => {
    // Arrange
    const others = [[], ['--as-owner', 'wait', 'mw0-x'], ['help', 'wait'], ['--help'], ['-v'], ['status'], ['waitt']];

    // Act
    const routed = others.map(args => entrySlice(args));

    // Assert
    should(routed).eql(others.map(() => undefined));
  });
});
