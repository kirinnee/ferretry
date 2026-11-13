import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { TerminalIo } from '@ferretry/kernel/manifest';
import { milliseconds } from '@ferretry/std';
import { type HostFacilities, PRODUCT_NAME, type ShellTime } from '../shell.ts';

/** The facilities, bound to this process. Every global reach of the CLI half is here or in `adapters/`. */
export function hostFacilities(io: TerminalIo, time: ShellTime): HostFacilities {
  return {
    clock: {
      now: () => {
        if (time.clock === undefined) throw new Error('this fy shell has no clock yet; update fy');
        return time.clock.nowMs();
      },
      sleep: async wait => {
        if (time.sleep === undefined) throw new Error('this fy shell has no timer yet; update fy');
        await time.sleep(milliseconds(wait));
      },
    },
    prompt: {
      async ask(message) {
        const reader = createInterface({ input: process.stdin, output: process.stdout });
        try {
          return await reader.question(`? ${message} `);
        } finally {
          reader.close();
        }
      },
    },
    progress: {
      // Ora off a terminal prints `- text` per start and the symbol line per ending; on one it rewrites one line.
      start: text => io.err(io.isTty ? `\r\u001b[2K- ${text}` : `- ${text}\n`),
      succeed: text => io.err(`${io.isTty ? '\r\u001b[2K' : ''}✔ ${text}\n`),
      fail: text => io.err(`${io.isTty ? '\r\u001b[2K' : ''}✖ ${text}\n`),
    },
    stateHome() {
      const pinned = process.env.FY_HOME?.trim();
      if (pinned === undefined || pinned === '') return join(homedir(), `.${PRODUCT_NAME}`);
      if (!isAbsolute(pinned)) throw new Error('FY_HOME must be an absolute path');
      return pinned;
    },
  };
}
