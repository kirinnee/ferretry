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
  on(event: 'end' | 'close', listener: () => void): void;
  on(event: 'error', listener: (error: unknown) => void): void;
  off(event: 'data', listener: (chunk: Uint8Array | string) => void): void;
  off(event: 'end' | 'close', listener: () => void): void;
  off(event: 'error', listener: (error: unknown) => void): void;
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
 * newline. The terminal is put back on EVERY way out, through one cleanup that runs exactly once: Enter, Ctrl-C typed (raw mode
 * delivers it as a byte, which ends the read), a SIGINT sent to the process, the stream ending, closing or erroring, and
 * any fault while setting the prompt up. Both interrupts answer a `ShellError` with exit status 130, after the terminal
 * is restored. The promise always settles, and a fault while restoring REJECTS it rather than handing back a value.
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

      /** Undoes everything that was installed, each step on its own so one that throws cannot skip the rest; answers the first fault. */
      const restore = (): { readonly fault: unknown } | undefined => {
        let fault: { readonly fault: unknown } | undefined;
        const attempt = (step: () => void): void => {
          try {
            step();
          } catch (error) {
            fault ??= { fault: error };
          }
        };
        attempt(() => input.off('data', onData));
        attempt(() => input.off('end', onEnd));
        attempt(() => input.off('close', onEnd));
        attempt(() => input.off('error', onError));
        attempt(() => stopListening());
        attempt(() => input.setRawMode(false));
        attempt(() => input.pause());
        attempt(() => deps.write('\n'));
        return fault;
      };

      /** The ONE way out: restores exactly once, then settles exactly once. A restore fault wins over a read value. */
      const finish = (outcome: { readonly ok: string } | { readonly fail: unknown }): void => {
        if (finished) return;
        finished = true;
        const restored = restore();
        if (restored) reject(restored.fault);
        else if ('fail' in outcome) reject(outcome.fail);
        else resolve(outcome.ok);
      };
      const interrupt = (): void => finish({ fail: new ShellError('interrupted', INTERRUPTED) });
      function onEnd(): void {
        finish({ fail: new ShellError('the terminal input closed before a value was entered') });
      }
      function onError(error: unknown): void {
        finish({ fail: error });
      }

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
            finish({ ok: typed.join('') });
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

      // Everything from here on is inside one try: whatever fails to install, the terminal is put back.
      try {
        input.setRawMode(true);
        input.resume();
        input.on('data', onData);
        input.on('end', onEnd);
        input.on('close', onEnd);
        input.on('error', onError);
        stopListening = deps.onInterrupt(interrupt);
      } catch (error) {
        finish({ fail: error });
      }
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
