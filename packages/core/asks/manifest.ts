import { GatePort } from '@ferretry/core-gate/contract';
import { definePlugin, route } from '@ferretry/kernel/manifest';
import { AskAnswered, AskSources, AsksChanged, AsksPort, AskVersionsFiles } from './contract/index.ts';
import { ASKS_STATE } from './daemon/lib/state.ts';

/**
 * Asks (§2.2): every question for the owner and the owner's answers; the Agenda plugin is how you see them. Core,
 * because answering is a security act.
 *
 * Routes: today's descriptors (`lib/runtime/mounts/agenda.ts`, `agenda-clear.ts`) field for field, plus the two the
 * dispatcher requires. `/v1/sessions/:sessionId/agenda…` moved to `/v1/ferrets/:ferretId/agenda…` (§1.4); the
 * machine agenda and `/v1/agenda/open` are the Agenda plugin's.
 */
const AGENDA_AUDIT = { skip: 'an agenda change is recorded on the item itself; a config confirm records its own act' } as const;
const AGENDA_GUARD = {
  none: 'ask words a ferret, the daemon or the owner wrote; an input card holds its prompt, never the value typed',
} as const;
const read = { minimum: 'operator', caller: 'any', noStore: true, audit: AGENDA_AUDIT, guard: AGENDA_GUARD } as const;

export default definePlugin({
  id: 'asks',
  title: 'Asks',
  version: '5.0.0',
  api: 5,
  core: true,
  kinds: [],
  words: [
    { word: 'ask', means: 'something you must decide or do', insteadOf: ['attention', 'request'] },
    { word: 'notice', means: 'something you should know; no answer', insteadOf: ['notification'] },
    { word: 'answer', means: 'your reply to an ask', insteadOf: ['response'] },
  ],
  needs: { gate: GatePort },
  provides: { asks: AsksPort },
  data: {
    // One ledger per ferret (daemon/lib/state.ts, lead decision 2026-11-07), and the contract's version archives.
    state: [...ASKS_STATE, AskVersionsFiles],
    publishes: [AskAnswered, AsksChanged],
  },
  hooks: { offers: [{ hook: AskSources }] },
  actions: {
    routes: [
      route('GET /v1/ferrets/:ferretId/agenda/:id', read),
      route('GET /v1/ferrets/:ferretId/agenda', read),
      // No capability: the board is gated by who acts (docs/grants.md). But an answer that confirms a held
      // configuration change asks that file's grant, so the boundary hands the handler the caller's standing.
      route('POST /v1/ferrets/:ferretId/agenda', { ...read, consultsGrants: true }),
      route('GET /v1/ferrets/:ferretId/agenda/:id/conversation', read),
      route('GET /v1/ferrets/:ferretId/agenda/:id/versions', read),
      route('GET /v1/ferrets/:ferretId/agenda/:id/versions/:version', read),
      route('PUT /v1/ferrets/:ferretId/agenda/:id/seen', {
        ...read,
        caller: 'person',
        guard: { none: 'the version number this device last opened' },
      }),
      route('POST /v1/ferrets/:ferretId/agenda/replies', { ...read, caller: 'person' }),
      route('POST /v1/agenda/clear-agents', {
        ...read,
        caller: 'person',
        guard: { none: 'two counts: items cleared and boards they were on' },
      }),
    ],
  },
  instructions: [{ id: 'asks', text: 'instructions/asks.md', when: { role: 'any' } }],
});
