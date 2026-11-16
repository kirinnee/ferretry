import { describe, it } from 'bun:test';
import should from 'should';
import { newSessionArguments } from '../../../../daemon/lib/tmux/commands.ts';
import { escapeTmuxFormat, tmuxStartDirectory } from '../../../../daemon/lib/tmux/format-escape.ts';

describe('escaping text tmux would expand as a format', () => {
  it('should double every # so tmux reads it as a literal #', () => {
    should(escapeTmuxFormat('/r/#(touch pwned)')).equal('/r/##(touch pwned)');
    should(escapeTmuxFormat('#{x}#[fg=red]##')).equal('##{x}##[fg=red]####');
  });

  it('should leave text without # untouched', () => {
    should(escapeTmuxFormat('/home/a b/c')).equal('/home/a b/c');
    should(tmuxStartDirectory('')).equal('');
  });
});

describe('the new-session argv', () => {
  it('should hand tmux an escaped start directory', () => {
    // Arrange / Act
    const argv = newSessionArguments({ session: 'work-1', cwd: '/r/#(touch /x)', command: ['sh'] });
    // Assert
    should(argv[argv.indexOf('-c') + 1]).equal('/r/##(touch /x)');
  });
});
