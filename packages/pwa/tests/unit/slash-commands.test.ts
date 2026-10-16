import { describe, expect, test } from 'bun:test';
import {
  commandOutputIsLong,
  commandOutputSummary,
  parseSlashCommandText,
  withCommandOutput,
} from '../../src/lib/slash-commands.ts';

const ESC = String.fromCharCode(27);

describe('parseSlashCommandText', () => {
  test('reads the command record Claude writes for /model', () => {
    const text = [
      '<command-name>/model</command-name>',
      '            <command-message>model</command-message>',
      '            <command-args>opus[1m]</command-args>',
    ].join('\n');
    expect(parseSlashCommandText(text)).toEqual({
      kind: 'command',
      command: { name: '/model', args: 'opus[1m]', tone: 'ok' },
    });
  });

  test('a command with no arguments has no args, and a bare message still names it', () => {
    expect(parseSlashCommandText('<command-name>/clear</command-name><command-args></command-args>')).toEqual({
      kind: 'command',
      command: { name: '/clear', tone: 'ok' },
    });
    expect(parseSlashCommandText('<command-message>compact</command-message>')).toEqual({
      kind: 'command',
      command: { name: '/compact', tone: 'ok' },
    });
  });

  test('keeps output written in the same record, with colour codes removed', () => {
    const text = `<command-name>/model</command-name><local-command-stdout>Set model to ${ESC}[1mOpus 5.5${ESC}[22m</local-command-stdout>`;
    expect(parseSlashCommandText(text)).toEqual({
      kind: 'command',
      command: { name: '/model', output: 'Set model to Opus 5.5', tone: 'ok' },
    });
  });

  test('reads stdout and stderr records on their own, stderr in the error tone', () => {
    expect(parseSlashCommandText('<local-command-stdout>  done  </local-command-stdout>')).toEqual({
      kind: 'output',
      output: 'done',
      tone: 'ok',
    });
    expect(
      parseSlashCommandText(
        '<local-command-stdout>partial</local-command-stdout>\n<local-command-stderr>broke</local-command-stderr>',
      ),
    ).toEqual({ kind: 'output', output: 'partial\nbroke', tone: 'err' });
    expect(parseSlashCommandText('<local-command-stdout></local-command-stdout>')).toEqual({
      kind: 'output',
      output: '',
      tone: 'ok',
    });
  });

  test('recognises the caveat so it can be dropped', () => {
    expect(
      parseSlashCommandText('<local-command-caveat>Caveat: DO NOT respond to these messages.</local-command-caveat>'),
    ).toEqual({ kind: 'caveat' });
  });

  test('never claims prose a human wrote around the markup, or text with no markup at all', () => {
    expect(parseSlashCommandText('please run <command-name>/model</command-name> for me')).toBeNull();
    expect(parseSlashCommandText('just a message')).toBeNull();
    expect(parseSlashCommandText('   ')).toBeNull();
    expect(parseSlashCommandText('<command-name>/model')).toBeNull();
  });
});

describe('command output helpers', () => {
  test('joins later output onto a command, and an empty output leaves it without one', () => {
    const command = { name: '/doctor', tone: 'ok' as const };
    expect(withCommandOutput(command, { kind: 'output', output: 'broke', tone: 'err' })).toEqual({
      name: '/doctor',
      output: 'broke',
      tone: 'err',
    });
    expect(withCommandOutput(command, { kind: 'output', output: '', tone: 'ok' })).toEqual(command);
  });

  test('summarises with the first line that says anything, and knows when there is more', () => {
    expect(commandOutputSummary('\n  first  \nsecond')).toBe('first');
    expect(commandOutputSummary('\n \n')).toBe('');
    expect(commandOutputIsLong('one line')).toBe(false);
    expect(commandOutputIsLong('one\n\ntwo')).toBe(true);
  });
});
