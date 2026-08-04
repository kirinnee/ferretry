/**
 * The highlighter, held to the one property that makes it safe to ship: what it
 * renders must concatenate back to what the reader copies.
 *
 * Everything else here is a claim about legibility — that the binary, the verb,
 * the flags and the literals land in different buckets on the real commands this
 * page prints — and those are asserted against the shipped strings rather than
 * invented ones, so a change to `INSTALLATION.md` shows up here.
 */

import { describe, expect, it } from 'bun:test';

import { type CommandToken, tokenizeCommand } from '../../../src/features/onboarding/command-syntax.ts';
import {
  DAEMON_START_COMMAND,
  DAEMON_STATUS_COMMAND,
  INSTALL_CHANNELS,
  PAIR_COMMAND,
  VERIFY_COMMAND,
} from '../../../src/features/onboarding/onboarding-model.ts';

/** The rendered text, rebuilt exactly as the DOM would join it. */
const rendered = (command: string): string =>
  tokenizeCommand(command)
    .map(token => token.text)
    .join('');

/** Every token that carries a word, whitespace and breaks dropped. */
const words = (command: string): readonly CommandToken[] =>
  tokenizeCommand(command).filter(token => token.text.trim() !== '');

const kinds = (command: string): readonly string[] => words(command).map(token => token.kind);

const kindOf = (command: string, text: string): string | undefined =>
  words(command).find(token => token.text === text)?.kind;

/** The tokens of one line of a multi-line command, whitespace dropped. */
const lineKinds = (command: string, line: number): readonly string[] => {
  const start = command.split('\n').slice(0, line).join('\n').length + (line === 0 ? 0 : 1);
  const end = start + (command.split('\n')[line]?.length ?? 0);
  return words(command)
    .filter(token => token.start >= start && token.start < end)
    .map(token => token.kind);
};

const EVERY_SHIPPED_COMMAND = [
  VERIFY_COMMAND,
  DAEMON_START_COMMAND,
  DAEMON_STATUS_COMMAND,
  PAIR_COMMAND,
  ...INSTALL_CHANNELS.map(channel => channel.command),
];

describe('tokenizing a command', () => {
  it('never changes a single character of what the reader copies', () => {
    for (const command of EVERY_SHIPPED_COMMAND) expect(rendered(command)).toBe(command);
  });

  it('keeps a line break as a token of its own', () => {
    expect(rendered('sudo apt update\nsudo apt install fy')).toBe('sudo apt update\nsudo apt install fy');
    expect(rendered('a\n\nb')).toBe('a\n\nb');
    expect(tokenizeCommand('a\nb').filter(token => token.text === '\n')).toHaveLength(1);
  });

  it('separates the binary, its verb, its flags and its data', () => {
    expect(kinds('fy daemon start')).toEqual(['binary', 'subcommand', 'subcommand']);
    expect(kinds('fy --version')).toEqual(['binary', 'flag']);
    expect(kinds('brew install --cask ferretry')).toEqual(['binary', 'subcommand', 'flag', 'plain']);
  });

  it('treats a runner as a runner, so the real binary still reads as one', () => {
    expect(kinds('sudo apt install fy')).toEqual(['binary', 'binary', 'subcommand', 'subcommand']);
  });

  it('stops the verb at anything that is plainly data', () => {
    expect(kindOf('brew tap kirinnee/ferretry', 'kirinnee/ferretry')).toBe('plain');
    expect(kindOf('sudo tee /etc/apt/sources.list.d/fury.list', '/etc/apt/sources.list.d/fury.list')).toBe('plain');
    // Only two words may read as a verb; a third is an argument.
    expect(kinds('fy one two three')).toEqual(['binary', 'subcommand', 'subcommand', 'plain']);
  });

  it('marks a URL, so the address a reader is trusting stands out', () => {
    const tap = 'brew tap kirinnee/ferretry https://github.com/kirinnee/ferretry';

    expect(kindOf(tap, 'https://github.com/kirinnee/ferretry')).toBe('url');
    expect(kindOf('curl http://example.test', 'http://example.test')).toBe('url');
  });

  it('holds a quoted span together even though it contains spaces', () => {
    const line = 'echo "deb [trusted=yes] https://apt.fury.io/x/ /" | sudo tee /etc/apt/sources.list.d/fury.list';

    expect(kinds(line)).toEqual(['binary', 'string', 'operator', 'binary', 'binary', 'plain']);
    // A quote the writer never closed must still round-trip rather than hang.
    expect(rendered('echo "open')).toBe('echo "open');
    expect(kindOf("echo 'single quoted'", "'single quoted'")).toBe('string');
  });

  it('hands the far side of a pipe back to a fresh command', () => {
    expect(kinds('curl -fsSL https://example.test/install.sh | bash')).toEqual([
      'binary',
      'flag',
      'url',
      'operator',
      'binary',
    ]);
    expect(kinds('a && b')).toEqual(['binary', 'operator', 'binary']);
  });

  it('reads a heredoc body as the literal data it is', () => {
    const block = ["sudo tee /etc/yum.repos.d/fury.repo <<'EOF'", '[fury]', 'enabled=1', 'EOF', 'sudo dnf install fy'];
    const command = block.join('\n');

    expect(lineKinds(command, 0)).toEqual(['binary', 'binary', 'plain', 'operator']);
    expect(lineKinds(command, 1)).toEqual(['string']);
    expect(lineKinds(command, 2)).toEqual(['string']);
    // The terminator is punctuation, not data.
    expect(lineKinds(command, 3)).toEqual(['operator']);
    // …and the command after it is read from scratch.
    expect(lineKinds(command, 4)).toEqual(['binary', 'binary', 'subcommand', 'subcommand']);
  });

  it('accepts every spelling of a heredoc opener, and no false ones', () => {
    expect(lineKinds('tee f <<EOF\nbody\nEOF', 1)).toEqual(['string']);
    expect(lineKinds('tee f <<-END\nbody\nEND', 1)).toEqual(['string']);
    expect(lineKinds('tee f <<"X"\nbody\nX', 1)).toEqual(['string']);
    // A bare `<<` names no delimiter, so nothing may be swallowed as a body.
    expect(kindOf('tee f << next', '<<')).toBe('plain');
    expect(lineKinds('tee f <<\nnext', 1)).toEqual(['binary']);
  });

  it('lets a comment swallow the rest of its line, the way the shell does', () => {
    const command = 'fy pair # copy the link it prints\nfy daemon status';

    expect(lineKinds(command, 0)).toEqual(['binary', 'subcommand', 'comment']);
    expect(words(command).find(token => token.kind === 'comment')?.text).toBe('# copy the link it prints');
    // The next line is still a command.
    expect(lineKinds(command, 1)).toEqual(['binary', 'subcommand', 'subcommand']);
  });

  it('survives input that is not a command at all', () => {
    expect(tokenizeCommand('')).toEqual([]);
    expect(tokenizeCommand('   ')).toEqual([{ kind: 'plain', text: '   ', start: 0 }]);
    // A leading flag leaves the binary slot open rather than consuming it.
    expect(kinds('--flag ls')).toEqual(['flag', 'binary']);
  });

  it('gives every token a key that is unique within its block', () => {
    for (const command of EVERY_SHIPPED_COMMAND) {
      const tokens = tokenizeCommand(command);
      expect(new Set(tokens.map(token => token.start)).size).toBe(tokens.length);
    }
  });
});
