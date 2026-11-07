import { GatePort } from '@ferretry/core-gate/contract';
import { definePlugin } from '@ferretry/kernel/manifest';
import { AskAnswered, AskSources, AsksChanged, AsksPort, AskVersionsFiles } from './contract/index.ts';
import { ASKS_STATE } from './daemon/lib/state.ts';

/**
 * Asks (§2.2): every question for the owner and the owner's answers; the Agenda plugin is how you see them. Core,
 * because answering is a security act. Its routes (raise, answer, read) are added by the Asks port with today's
 * descriptors; the day-1 spine declares the contract surface only.
 */
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
  instructions: [{ id: 'asks', text: 'instructions/asks.md', when: { role: 'any' } }],
});
