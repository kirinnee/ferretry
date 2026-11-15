/**
 * The production hidden prompt (`terminalHiddenPrompt`): it reads THIS process's `stdin`, writes the question to THIS
 * process's `stderr` and listens for a SIGINT on THIS process. Each test swaps `process.stdin` for a fake terminal and
 * `process.stderr.write` for a recorder for the length of one prompt, and puts both back; no real terminal is touched.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { ShellError } from '../../../src/lib/errors.ts';
import { terminalHiddenPrompt } from '../../../src/adapters/terminal/hidden-prompt.ts';

const SECRET = 'typed-fake-secret-000';
const QUESTION = 'value for NAME (hidden; press Enter when done): ';

type Listener = (chunk: Uint8Array | string) => void;

function fakeTerminal(isTTY: boolean) {
  const events: string[] = [];
  const data = new Set<Listener>();
  const stdin = {
    isTTY,
    setRawMode: (on: boolean) => void events.push(`raw:${String(on)}`),
    resume: () => void events.push('resume'),
    pause: () => void events.push('pause'),
    on: (event: string, listener: Listener) => {
      if (event === 'data') data.add(listener);
    },
    off: (event: string, listener: Listener) => {
      if (event === 'data') data.delete(listener);
    },
  };
  const type = (chunk: string): void => {
    for (const listener of [...data]) listener(chunk);
  };
  return { stdin, events, data, type };
}

const realStdin = Object.getOwnPropertyDescriptor(process, 'stdin');
const realWrite = process.stderr.write;

function install(terminal: ReturnType<typeof fakeTerminal>): string[] {
  const written: string[] = [];
  Object.defineProperty(process, 'stdin', { value: terminal.stdin, configurable: true });
  process.stderr.write = ((text: string) => {
    written.push(text);
    return true;
  }) as typeof process.stderr.write;
  return written;
}

afterEach(() => {
  if (realStdin !== undefined) Object.defineProperty(process, 'stdin', realStdin);
  process.stderr.write = realWrite;
});

describe('terminalHiddenPrompt', () => {
  it('reads one line from the process’s terminal without echo, asks on stderr, and leaves no SIGINT listener behind', async () => {
    const terminal = fakeTerminal(true);
    const written = install(terminal);
    const listening = process.listenerCount('SIGINT');

    const asked = terminalHiddenPrompt(QUESTION);
    expect(process.listenerCount('SIGINT')).toBe(listening + 1);
    terminal.type(`${SECRET}\r`);

    expect(await asked).toBe(SECRET);
    expect(written).toEqual([QUESTION, '\n']);
    expect(terminal.events).toEqual(['raw:true', 'resume', 'raw:false', 'pause']);
    expect(terminal.data.size).toBe(0);
    expect(process.listenerCount('SIGINT')).toBe(listening);
  });

  it('ends with status 130 on a SIGINT sent to the process, after the terminal is restored', async () => {
    const terminal = fakeTerminal(true);
    install(terminal);
    const before = new Set(process.listeners('SIGINT'));

    const asked = terminalHiddenPrompt(QUESTION).then(
      () => undefined,
      (error: unknown) => error,
    );
    const ours = process.listeners('SIGINT').filter(listener => !before.has(listener));
    expect(ours).toHaveLength(1);
    (ours[0] as () => void)();

    const refusal = await asked;
    expect(refusal).toBeInstanceOf(ShellError);
    expect((refusal as ShellError).exitCode).toBe(130);
    expect(terminal.events).toEqual(['raw:true', 'resume', 'raw:false', 'pause']);
    expect(process.listeners('SIGINT').filter(listener => !before.has(listener))).toHaveLength(0);
  });

  it('answers undefined, and asks nothing, when the process’s standard input is not a terminal', async () => {
    const terminal = fakeTerminal(false);
    const written = install(terminal);

    expect(await terminalHiddenPrompt(QUESTION)).toBeUndefined();
    expect(written).toEqual([]);
    expect(terminal.events).toEqual([]);
  });
});
