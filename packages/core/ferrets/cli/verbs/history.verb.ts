import { HISTORY_CLAIM_HELD_EXIT_CODE } from '../../contract/conversation-lease.ts';
import { hostLeaseStore } from '../adapters/history/host-lease-store.ts';
import { HistoryController } from '../lib/history/controller.ts';
import { historyClaimRequest } from '../lib/history/request.ts';
import { BINARY, defineVerbs } from './context.ts';

/** The variable a runtime's wrapper exports its own name in, read to name the runtime in a refusal. */
const RUNTIME_NAME_ENV = 'FY_RUNTIME';

const HISTORY_USAGE = [
  'the conversations every runtime of a harness shares:',
  `  ${BINARY} history claim --harness <claude|codex> --pid <pid> [--from-arguments --] <conversation or harness arguments>`,
  `      claim a conversation for one writer; refused (exit ${HISTORY_CLAIM_HELD_EXIT_CODE}) while another is writing it`,
];

export default defineVerbs(({ env, ownState, readEnvironment, verb, usage }) => ({
  history: usage(HISTORY_USAGE),
  // `fy history claim` (V-0283): the wrapper's claim before it `exec`s a resumed harness. It reads and writes the lease
  // files itself and asks the daemon nothing, so a person's own terminal is covered with no daemon running; a failure
  // of any kind answers 1 (or 2 for words it cannot read), never the held status, so a wrapper launches anyway.
  'history claim [words...]': verb(async (invocation, _presenter, io) => {
    const request = historyClaimRequest(invocation);
    if (ownState === undefined) throw new Error('this shell gives no state home to keep conversation leases in');
    const runtime = readEnvironment?.([RUNTIME_NAME_ENV])[RUNTIME_NAME_ENV];
    const session = env?.FY_SESSION_ID;
    await new HistoryController(hostLeaseStore(ownState), io, {
      ...(session === undefined || session === '' ? {} : { session }),
      ...(runtime === undefined || runtime === '' ? {} : { runtime }),
    }).claim(request);
  }),
}));
