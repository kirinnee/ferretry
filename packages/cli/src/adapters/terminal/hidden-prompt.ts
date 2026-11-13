import { ShellError } from '../../lib/errors.ts';

/** The exit status of a command stopped with Ctrl-C (128 + SIGINT), as a shell reports it. */
const INTERRUPTED = 130;

/** The terminal's input side, narrow on purpose: a test hands in a fake TTY, production hands in `process.stdin`. */
export interface HiddenPromptInput {
  readonly isTTY: boolean;
  /** Raw mode is what turns the terminal's echo (and its line editing) off. */
  setRawMode(on: boolean): void;
  resume(): void;
  pause(): void;
  on(event: 'data', listener: (chunk: Uint8Array | string) => void): void;
  off(event: 'data', listener: (chunk: Uint8Array | string) => void): void;
}

export interface HiddenPromptDeps {
  readonly input: HiddenPromptInput;
  /** Where the question and the closing newline go: stderr, so stdout stays whole for a script. */
  readonly write: (text: string) => void;
  /** Hears a SIGINT sent to the process (not a typed Ctrl-C, which raw mode delivers as a byte); answers how to stop. */
  readonly onInterrupt: (handler: () => void) => () => void;
}

/**
 * Reads ONE line typed at the terminal without echoing it, for a value that must not reach the screen or its scrollback.
 *
 * Answers `undefined` when standard input is not a terminal, so the caller keeps reading a pipe as it always did. The
 * typed value is returned to the caller and written NOWHERE here: the only text this prints is the question and one
 * newline. The terminal is put back in a `finally`-equivalent on every way out: Enter, Ctrl-C typed (raw mode delivers
 * it as a byte, which ends the read), and a SIGINT sent to the process. Both interrupts answer a `ShellError` with exit
 * status 130, after the terminal is restored.
 *
 * Backspace edits what was typed; an escape sequence (an arrow key) is skipped rather than stored.
 */
export function createHiddenPrompt(deps: HiddenPromptDeps): (question: string) => Promise<string | undefined> {
  const { input } = deps;
  return async question => {
    if (!input.isTTY) return undefined;
    deps.write(question);
    return await new Promise<string>((resolve, reject) => {
      const decoder = new TextDecoder();
      let typed: string[] = [];
      let skipping: 'none' | 'after-escape' | 'in-sequence' = 'none';
      let finished = false;
      let stopListening = (): void => undefined;

      const finish = (outcome: () => void): void => {
        if (finished) return;
        finished = true;
        input.off('data', onData);
        stopListening();
        try {
          input.setRawMode(false);
        } finally {
          input.pause();
          deps.write('\n');
          outcome();
        }
      };
      const interrupt = (): void => finish(() => reject(new ShellError('interrupted', INTERRUPTED)));

      function onData(chunk: Uint8Array | string): void {
        const text = typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
        for (const char of text) {
          if (skipping === 'after-escape') {
            skipping = char === '[' ? 'in-sequence' : 'none';
            continue;
          }
          if (skipping === 'in-sequence') {
            // A CSI sequence ends at its final byte, `@` to `~`.
            if (char >= '@' && char <= '~') skipping = 'none';
            continue;
          }
          if (char === '\r' || char === '\n' || char === '\u0004') {
            finish(() => resolve(typed.join('')));
            return;
          }
          if (char === '\u0003') {
            interrupt();
            return;
          }
          if (char === '\u001b') skipping = 'after-escape';
          else if (char === '\u007f' || char === '\b') typed = typed.slice(0, -1);
          else if (char >= ' ') typed.push(char);
        }
      }

      try {
        input.setRawMode(true);
      } catch (error) {
        finish(() => reject(error));
        return;
      }
      input.resume();
      input.on('data', onData);
      stopListening = deps.onInterrupt(interrupt);
    });
  };
}

/** The production prompt: this process's own terminal. Nothing is read until it is asked. */
export const terminalHiddenPrompt = (question: string): Promise<string | undefined> =>
  createHiddenPrompt({
    input: process.stdin as unknown as HiddenPromptInput,
    write: text => void process.stderr.write(text),
    onInterrupt: handler => {
      process.on('SIGINT', handler);
      return () => void process.off('SIGINT', handler);
    },
  })(question);
