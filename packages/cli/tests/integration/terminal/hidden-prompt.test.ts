/**
 * The hidden prompt (`src/adapters/terminal/hidden-prompt.ts`) over a FAKE terminal: echo off before the first read and
 * back on after every way out, the typed value written nowhere, and Ctrl-C ends it with status 130 after the terminal
 * is restored. No test touches the real terminal.
 */
import { describe, expect, it } from 'bun:test';
import { createHiddenPrompt, type HiddenPromptInput } from '../../../src/adapters/terminal/hidden-prompt.ts';
import { ShellError } from '../../../src/lib/errors.ts';

const SECRET = 'typed-fake-secret-000';
const QUESTION = 'value for NAME (hidden; press Enter when done): ';

function terminal(isTTY = true) {
  const events: string[] = [];
  const listeners = new Set<(chunk: Uint8Array | string) => void>();
  const written: string[] = [];
  const interrupts = new Set<() => void>();
  const input: HiddenPromptInput = {
    isTTY,
    setRawMode: on => void events.push(`raw:${String(on)}`),
    resume: () => void events.push('resume'),
    pause: () => void events.push('pause'),
    on: (_event, listener) => void listeners.add(listener),
    off: (_event, listener) => void listeners.delete(listener),
  };
  const prompt = createHiddenPrompt({
    input,
    write: text => void written.push(text),
    onInterrupt: handler => {
      interrupts.add(handler);
      return () => void interrupts.delete(handler);
    },
  });
  return {
    prompt,
    events,
    written,
    listeners,
    interrupts,
    type: (chunk: Uint8Array | string) => {
      for (const listener of [...listeners]) listener(chunk);
    },
  };
}

describe('the hidden prompt', () => {
  it('turns echo off before it listens, reads one line and turns echo back on, writing only the question and a newline', async () => {
    const t = terminal();
    const asked = t.prompt(QUESTION);
    expect(t.events).toEqual(['raw:true', 'resume']);
    t.type(SECRET);
    t.type('\r');
    expect(await asked).toBe(SECRET);
    expect(t.events).toEqual(['raw:true', 'resume', 'raw:false', 'pause']);
    expect(t.written).toEqual([QUESTION, '\n']);
    expect(t.written.join('')).not.toContain(SECRET);
    expect(t.listeners.size).toBe(0);
    expect(t.interrupts.size).toBe(0);
  });

  it('reads a value that arrives in pieces, as bytes, and a pasted line with its ending in one chunk', async () => {
    const t = terminal();
    const asked = t.prompt(QUESTION);
    t.type(new TextEncoder().encode('typed-fake'));
    t.type(new TextEncoder().encode('-secret-000'));
    t.type('\n');
    expect(await asked).toBe(SECRET);
    const pasted = terminal();
    const second = pasted.prompt(QUESTION);
    pasted.type(`${SECRET}\nnot-part-of-it`);
    expect(await second).toBe(SECRET);
  });

  it('lets backspace edit and skips an arrow key instead of storing it', async () => {
    const t = terminal();
    const asked = t.prompt(QUESTION);
    t.type('abcx\u007f\u007fd');
    t.type('\u001b[A\u001b[1;5D');
    t.type('e\r');
    expect(await asked).toBe('abde');
  });

  it('answers an empty line as empty, for the caller to refuse', async () => {
    const t = terminal();
    const asked = t.prompt(QUESTION);
    t.type('\r');
    expect(await asked).toBe('');
  });

  it('restores the terminal and ends with status 130 on a typed Ctrl-C, and returns nothing typed so far', async () => {
    const t = terminal();
    const asked = t.prompt(QUESTION);
    t.type(`${SECRET}\u0003`);
    const refusal = await asked.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(ShellError);
    expect((refusal as ShellError).exitCode).toBe(130);
    expect(t.events).toEqual(['raw:true', 'resume', 'raw:false', 'pause']);
    expect(t.written).toEqual([QUESTION, '\n']);
    expect(t.listeners.size).toBe(0);
  });

  it('restores the terminal and ends with status 130 on a SIGINT sent to the process', async () => {
    const t = terminal();
    const asked = t.prompt(QUESTION);
    t.type('half');
    for (const handler of [...t.interrupts]) handler();
    const refusal = await asked.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect((refusal as ShellError).exitCode).toBe(130);
    expect(t.events).toEqual(['raw:true', 'resume', 'raw:false', 'pause']);
    expect(t.interrupts.size).toBe(0);
  });

  it('touches nothing and answers undefined when standard input is not a terminal', async () => {
    const t = terminal(false);
    expect(await t.prompt(QUESTION)).toBeUndefined();
    expect(t.events).toEqual([]);
    expect(t.written).toEqual([]);
  });

  it('puts the terminal back if raw mode cannot be turned on', async () => {
    const t = terminal();
    const failing = createHiddenPrompt({
      input: {
        isTTY: true,
        setRawMode: on => {
          t.events.push(`raw:${String(on)}`);
          if (on) throw new Error('no raw mode here');
        },
        resume: () => void t.events.push('resume'),
        pause: () => void t.events.push('pause'),
        on: () => undefined,
        off: () => undefined,
      },
      write: () => undefined,
      onInterrupt: () => () => undefined,
    });
    await expect(failing(QUESTION)).rejects.toThrow('no raw mode here');
    expect(t.events).toEqual(['raw:true', 'raw:false', 'pause']);
  });
});
