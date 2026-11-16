import { createInterface } from 'node:readline';
import { milliseconds, type Duration } from '@ferretry/std';
import { Writable } from 'node:stream';
import type { IAccountPrompt } from '../lib/account-ports.ts';

/** TODO(kernel contract): lead-approved CliContext.readText(path), with '-' reading stdin. */
export function recipeReader(ctx: { readText?: (path: string) => Promise<string> }): (path: string) => Promise<string> {
  return async path => {
    if (ctx.readText === undefined)
      throw new Error(
        'this fy shell cannot read recipe files yet; update fy, or edit the recipe in Settings › Accounts',
      );
    return await ctx.readText(path);
  };
}

/**
 * The host facilities `fy account` needs that the 5.0 CLI context does not offer yet (REPLACE WITH CliContext ports):
 * a terminal prompt, with a hidden read that echoes NOTHING (not even `*`) so a password or seed never reaches
 * scrollback; the session this CLI runs inside; a clock and a wait for the seed card's poll. Today's `InquirerPrompt`
 * did the same through inquirer, which 5.0 does not carry.
 */
/** TODO(CliContext port): a prompt with a hidden read. */
export class TerminalPrompt implements IAccountPrompt {
  async ask(message: string): Promise<string> {
    return await this.#read(message, false);
  }

  async askHidden(message: string): Promise<string> {
    return await this.#read(message, true);
  }

  async #read(message: string, hidden: boolean): Promise<string> {
    let muted = false;
    const output = new Writable({
      write(chunk: Buffer | string, _encoding, done) {
        if (!muted) process.stdout.write(chunk);
        done();
      },
    });
    const reader = createInterface({ input: process.stdin, output, terminal: process.stdin.isTTY === true });
    try {
      return await new Promise<string>(resolve => {
        reader.question(message, answer => {
          if (hidden) process.stdout.write('\n');
          resolve(answer);
        });
        muted = hidden;
      });
    } finally {
      reader.close();
    }
  }
}

/** `FY_SESSION_ID`: the session this CLI runs inside; absent at the owner's own shell. TODO(CliContext port): env. */
export const ownSessionId = (): string | undefined => process.env.FY_SESSION_ID;

/** The clock and the wait the fy shell hands every half (`CliContext.clock` and `.sleep`). */
export interface ShellTimeContext {
  readonly clock?: { nowMs(): number };
  sleep?(delay: Duration, signal?: AbortSignal): Promise<void>;
}

/** Today's `Date.now` and `setTimeout` wait, taken from the shell; a shell that hands neither says so when asked. */
export function shellTime(ctx: ShellTimeContext): {
  readonly nowMs: () => number;
  readonly sleep: (ms: number) => Promise<void>;
} {
  return {
    nowMs: () => {
      if (ctx.clock === undefined) throw new Error('this fy shell has no clock yet; update fy');
      return ctx.clock.nowMs();
    },
    sleep: async ms => {
      if (ctx.sleep === undefined) throw new Error('this fy shell has no timer yet; update fy');
      await ctx.sleep(milliseconds(ms));
    },
  };
}

/**
 * Whether this pane holds a ferret's credential (today's `paneCredentialValue` over `FY_SESSION_TOKEN` and
 * `FY_SESSION_BOARD_CAPABILITY`), as a MARKER only: the owner-command refusal needs to know one is there, never what it
 * is, so the value is not read into this process's own variables. TODO(CliContext port): env.
 */
export const paneCredentialMarker = (): string | undefined =>
  ['FY_SESSION_TOKEN', 'FY_SESSION_BOARD_CAPABILITY'].some(name => (process.env[name]?.trim() ?? '') !== '')
    ? 'present'
    : undefined;
