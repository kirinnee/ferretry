import { describe, expect, it } from 'bun:test';
import { clientAt, shellCommandOf, simpleCommands, type Word } from '../../../app/lib/shell-words.ts';

const call = (name: string | undefined, input: unknown) => ({ use: { name, input } }) as never;
const texts = (script: string): string[][] => simpleCommands(script).map(words => words.map(word => word.text));

describe('shellCommandOf', () => {
  it('reads Claude’s Bash command and Codex’s exec command', () => {
    expect(shellCommandOf(call('Bash', { command: 'fy ls' }))).toBe('fy ls');
    expect(shellCommandOf(call('exec_command', { cmd: 'fy ls' }))).toBe('fy ls');
  });

  it('is undefined for a command that is not text, or input that is not an object', () => {
    expect(shellCommandOf(call('Bash', { command: 3 }))).toBeUndefined();
    expect(shellCommandOf(call('exec_command', {}))).toBeUndefined();
    expect(shellCommandOf(call('Bash', null))).toBeUndefined();
    expect(shellCommandOf(call('Bash', ['fy']))).toBeUndefined();
    expect(shellCommandOf(call(undefined, { command: 'fy' }))).toBeUndefined();
    expect(shellCommandOf(call('Read', { command: 'fy' }))).toBeUndefined();
  });

  it('reads the script of a Codex shell call that runs it through bash -lc', () => {
    expect(shellCommandOf(call('shell', { command: ['bash', '-lc', 'fy send a hi'] }))).toBe('fy send a hi');
    expect(shellCommandOf(call('local_shell', { command: ['zsh', '-c', 'fy ls'] }))).toBe('fy ls');
  });

  it('joins any other argv with spaces, and refuses one that is not all text', () => {
    expect(shellCommandOf(call('shell', { command: ['fy', 'ls'] }))).toBe('fy ls');
    expect(shellCommandOf(call('shell', { command: ['bash', '-x', 'script'] }))).toBe('bash -x script');
    expect(shellCommandOf(call('shell', { command: ['fy', 3] }))).toBeUndefined();
    expect(shellCommandOf(call('shell', { command: 'fy ls' }))).toBeUndefined();
  });
});

describe('simpleCommands', () => {
  it('splits on spaces and on the operators that end a command', () => {
    expect(texts('fy ls; fy send a hi && fy x | cat\nfy y')).toEqual([
      ['fy', 'ls'],
      ['fy', 'send', 'a', 'hi'],
      ['fy', 'x'],
      ['cat'],
      ['fy', 'y'],
    ]);
  });

  it('reads single quotes verbatim and double quotes with their escapes', () => {
    expect(texts(`fy send a 'hi $there' "say \\"hi\\" \\\\ \\$HOME" `)).toEqual([
      ['fy', 'send', 'a', 'hi $there', 'say "hi" \\ $HOME'],
    ]);
  });

  it('marks a word with an expansion it cannot run, bare or inside double quotes', () => {
    const words = (simpleCommands('fy send a $NAME "x$(y)" "`z`" plain')[0] ?? []) as readonly Word[];
    expect(words.map(word => [word.text, word.expanded])).toEqual([
      ['fy', false],
      ['send', false],
      ['a', false],
      ['$NAME', true],
      ['x$(y)', true],
      ['`z`', true],
      ['plain', false],
    ]);
  });

  it('reads a backslash as the next character, and a backslash-newline as nothing', () => {
    expect(texts('fy send a\\ b c\\\nd')).toEqual([['fy', 'send', 'a b', 'cd']]);
    expect(texts('fy send trailing\\')).toEqual([['fy', 'send', 'trailing']]);
  });

  it('gives up on a quote that never closes', () => {
    expect(simpleCommands(`fy send a 'oops`)).toEqual([]);
    expect(simpleCommands(`fy send a "oops`)).toEqual([]);
  });

  it('replaces the heredoc substitution with its body', () => {
    const script = 'fy send a "$(cat <<\'EOF\'\nline one\nline two\nEOF\n)"';
    expect(texts(script)).toEqual([['fy', 'send', 'a', 'line one\nline two']]);
  });

  it('drops redirections, operator and target both', () => {
    expect(texts('fy send a hi 2>&1')).toEqual([['fy', 'send', 'a', 'hi']]);
    expect(texts('fy send a hi > /dev/null')).toEqual([['fy', 'send', 'a', 'hi']]);
    expect(texts('fy send a hi >>log >|clobber &>out &>>out')).toEqual([['fy', 'send', 'a', 'hi']]);
    expect(texts('fy send a hi < in <>rw <&3 >&- 1>&2')).toEqual([['fy', 'send', 'a', 'hi']]);
    expect(texts('fy send a hi <<< "text"')).toEqual([['fy', 'send', 'a', 'hi']]);
  });

  it('keeps a bare number that does not touch an operator, and a lone ampersand ends the command', () => {
    expect(texts('fy send a 2 > out')).toEqual([['fy', 'send', 'a', '2']]);
    expect(texts('fy ls & fy ps')).toEqual([
      ['fy', 'ls'],
      ['fy', 'ps'],
    ]);
  });

  it('skips the bodies of heredocs opened on a command line, plain and indented', () => {
    expect(texts('fy send a hi <<EOF\nnot a command\nEOF\nfy ls')).toEqual([
      ['fy', 'send', 'a', 'hi'],
      ['fy', 'ls'],
    ]);
    expect(texts('cat <<-END\n\tnot; a command\n\tEND\nfy ls')).toEqual([['cat'], ['fy', 'ls']]);
    expect(texts('cat <<ONE <<TWO\nx\nONE\ny\nTWO\nfy ls')).toEqual([['cat'], ['fy', 'ls']]);
  });

  it('skips to the end when a heredoc is never closed', () => {
    expect(texts('cat <<EOF\nnever closed\nfy ls')).toEqual([['cat']]);
  });
});

describe('clientAt', () => {
  const words = (script: string) => simpleCommands(script)[0] ?? [];

  it('finds the client at the start, by name or by a path ending in it', () => {
    expect(clientAt(words('fy ls'), 'fy')).toBe(0);
    expect(clientAt(words('/usr/bin/fy ls'), 'fy')).toBe(0);
  });

  it('allows only direnv exec <dir> in front of it', () => {
    expect(clientAt(words('direnv exec . fy ls'), 'fy')).toBe(3);
    expect(clientAt(words('echo fy ls'), 'fy')).toBe(-1);
    expect(clientAt(words('direnv run . fy ls'), 'fy')).toBe(-1);
    expect(clientAt(words('ls'), 'fy')).toBe(-1);
  });
});
