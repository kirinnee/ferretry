import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import type { IAccountPrompt } from '../lib/account-ports.ts';

/**
 * The host facilities `fy account` needs that the 5.0 CLI context does not offer yet (REPLACE WITH CliContext ports):
 * a terminal prompt, with a hidden read that echoes NOTHING (not even `*`) so a password or seed never reaches
 * scrollback; the session this CLI runs inside; a clock and a wait for the seed card's poll. Today's `InquirerPrompt`
 * did the same through inquirer, which 5.0 does not carry.
 */
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

/** `FY_SESSION_ID`: the session this CLI runs inside; absent at the owner's own shell. */
export const ownSessionId = (): string | undefined => process.env.FY_SESSION_ID;

export const nowMs = (): number => Date.now();

export const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms));
};
