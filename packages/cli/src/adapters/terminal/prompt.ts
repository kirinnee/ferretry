import { createInterface } from 'node:readline/promises';
import type { IDaemonPrompt } from '../../lib/update/machine.ts';

/** Asks on stderr and reads one line from stdin, so stdout stays whole for a script reading the answer of the verb. */
export const terminalPrompt: IDaemonPrompt = {
  ask: async question => {
    const terminal = createInterface({ input: process.stdin, output: process.stderr });
    try {
      return await terminal.question(`${question} `);
    } finally {
      terminal.close();
    }
  },
};
