/** Which of its own prompt sections this ferret launched with: the `instructions` tool and `fy instructions`. */
import { tool, verb } from '@ferretry/kernel/manifest';
import { z } from 'zod';
import { fragment } from '../kit.ts';

export default fragment({
  agentTools: [
    // Today's `instructions` tool: which of its own system-prompt sections THIS ferret launched with. The launch parts own
    // those sections, so Ferrets answers it, for the ferret the session credential names.
    tool('instructions', {
      minimum: 'authenticated',
      caller: 'any',
      audit: { skip: 'a read of the ferret’s own launch sections: it changes nothing' },
      guard: { none: 'section names and on/off; never a value' },
      input: z.strictObject({}),
      summary:
        'Which Ferretry sections your prompt launched with (hypermedia, Pack mode, agenda mode, lessons) and how to turn each on. Check before saying one is missing.',
    }),
  ],
  cli: [
    verb('instructions', {
      summary: 'which of its own instruction sections this ferret launched with',
      args: [],
      options: [{ flag: '--json', help: 'print the report as JSON' }],
    }),
  ],
});
