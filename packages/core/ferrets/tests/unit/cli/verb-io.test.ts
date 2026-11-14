import { expect, test } from 'bun:test';
import type { TerminalIo } from '@ferretry/kernel/manifest';
import { SessionCommandError } from '../../../cli/lib/session/errors.ts';
import { SessionPresenter } from '../../../cli/lib/session/presenter.ts';
import { guarded, PLAIN, VerbIo } from '../../../cli/lib/verb-io.ts';

const terminal = (): { readonly io: TerminalIo; readonly out: string[]; readonly err: string[] } => {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: text => void out.push(text), err: text => void err.push(text), isTty: false }, out, err };
};

test('verb io answers on stdout and says notes and diagnostics on stderr', () => {
  const { io, out, err } = terminal();
  const verb = new VerbIo(io);
  verb.success('ok');
  verb.report('report');
  verb.warn('warned');
  verb.error('refused');
  verb.diagnostic('diagnosed');
  // The shell's terminal writes exactly what it is given, so every message ends its own line: `fy ps -a` printed all
  // its rows as one line before they did.
  expect(out).toEqual(['ok\n', 'report\n', 'warned\n']);
  expect(err).toEqual(['refused\n', 'diagnosed\n']);
});

test('verb io keeps the exit code a controller sets and starts at zero', () => {
  const verb = new VerbIo(terminal().io);
  expect(verb.exitCode).toBe(0);
  verb.setExitCode(3);
  expect(verb.exitCode).toBe(3);
});

test('the shell terminal paints the amber cell as plain text', () => {
  expect(PLAIN.amber('12')).toBe('12');
});

test('a guarded verb answers the exit code its controller set', async () => {
  const { io } = terminal();
  const verb = new VerbIo(io);
  expect(await guarded(verb, new SessionPresenter(verb), async () => verb.setExitCode(4))).toBe(4);
});

test('a guarded verb prints a caller mistake through the presenter and answers its exit code', async () => {
  const { io, err } = terminal();
  const verb = new VerbIo(io);
  const code = await guarded(verb, new SessionPresenter(verb), async () => {
    throw new SessionCommandError('name the ferret');
  });
  expect(code).toBe(2);
  expect(err.join('\n')).toContain('name the ferret');
});

test('a guarded verb hands a shell refusal that carries its own exit code back untouched', async () => {
  const { io, err } = terminal();
  const verb = new VerbIo(io);
  const refusal = Object.assign(new Error('the plugin is paused'), { exitCode: 7 });
  await expect(
    guarded(verb, new SessionPresenter(verb), async () => {
      throw refusal;
    }),
  ).rejects.toBe(refusal);
  expect(err).toEqual([]);
});
