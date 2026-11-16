/**
 * Finding cards and asks (work-search), the verb and the agent tool. Its two routes are `85-search-routes.actions.ts`: a
 * list's order is part of the contract hash, and the manifest declared `fy search` before the render and link verbs but
 * its routes after the link routes, so one file cannot hold both without moving an entry.
 */
import { tool, verb } from '@ferretry/kernel/manifest';
import { cap, SearchWorkToolInputSchema } from '../../contract/index.ts';
import { fragment } from '../kit.ts';

export default fragment({
  cli: [
    verb('search', {
      summary: 'find cards and asks by what they say',
      args: [{ name: 'text', help: 'words to look for, or an id like F303 / A3', variadic: true }],
      options: [
        { flag: '--kind <kind>', help: 'only task | agenda' },
        { flag: '--open', help: 'only work still to do' },
        { flag: '--project <name>', help: "only this project's cards (agenda items are kept)" },
        { flag: '--all', help: 'also find closed, dropped and addressed work older than 30 days' },
        { flag: '--limit <n>', help: 'at most this many hits (default 20)' },
        { flag: '--session <id>', help: 'act as this session instead of the ambient FY_SESSION_ID' },
        { flag: '--json', help: 'print the daemon response as JSON' },
      ],
    }),
  ],
  agentTools: [
    tool('search_work', {
      minimum: 'authenticated',
      caller: 'any',
      capability: cap('fleet', 'use'),
      audit: { skip: 'read' },
      guard: 'secrets',
      summary: 'Find cards and asks by words or id before filing a duplicate; `all` adds old closed ones.',
      input: SearchWorkToolInputSchema,
    }),
  ],
});
