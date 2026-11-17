/** Reading ferrets: the list, one ferret, its subtree and its live turns; `fy ps` and `fy status`. */
import { CAPABILITIES } from '@ferretry/core-gate/contract';
import { route, verb } from '@ferretry/kernel/manifest';
import { ferretRead, fragment } from '../kit.ts';

export default fragment({
  routes: [
    // R-0134: conditional (R501, R503); registered before the pattern below.
    ferretRead('GET /v1/ferrets', {
      compress: true,
      audit: { skip: 'a fleet read records nothing' },
      guard: { none: 'ferret identity records: names, lineage, folders and states, no pane or vault text' },
    }),
    // Today's subtree API (G24): lineage is from the registry, excerpts are masked before truncation.
    ferretRead('GET /v1/ferrets/:ferretId/subtree', {
      audit: { skip: 'a subtree read records nothing, as today' },
      guard: { none: 'G24 masks whole excerpts through kernel.redaction before cutting; failures withhold excerpts' },
    }),
    // R-0135
    ferretRead('GET /v1/ferrets/:ferretId', {
      audit: { skip: 'a ferret read records nothing' },
      guard: { none: 'one ferret identity record' },
    }),
    // The ferret's turns and context as its state document stands now (`FerretLiveReadSchema`). It is a fleet read, so
    // a governed (remote) device needs the `fleet` use grant; an agent keeps v4's reach, as the ferret reads do.
    ferretRead('GET /v1/ferrets/:ferretId/live', {
      audit: { skip: 'a ferret read records nothing' },
      guard: { none: 'a turn count and a context percentage; no text' },
    }),
    // A stopped ferret's STORED last screen (`FerretsApi.lastSnapshot`): what `fy status` and Info say a ferret that ended
    // on its own showed last. A screen is pane text, so it asks `terminal.use` of a remote device like the pane routes do,
    // is refused to a caller that may not touch the ferret before the file is opened, and is masked AGAIN on this read.
    route('GET /v1/ferrets/:ferretId/last-screen', {
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      capability: { capability: CAPABILITIES.terminal, axis: 'use' },
      audit: { skip: 'a ferret read records nothing' },
      guard: 'secrets',
    }),
  ],
  cli: [
    verb('ps', {
      summary: 'list ferrets',
      args: [],
      options: [
        { flag: '--pack <label>', help: 'only the sessions in this pack', hidden: true },
        { flag: '-a, --all', help: 'include terminal sessions (completed/failed/stalled/stopped)' },
        { flag: '-l, --label <label>', help: 'only sessions started with this ownership label' },
        { flag: '--json', help: 'print the selected sessions as JSON' },
      ],
    }),
    verb('status [id]', {
      summary: 'show one ferret in detail, or with --subtree a table of its helpers',
      args: [
        {
          name: 'id',
          help: 'session id or callsign (with --subtree: defaults to the calling session)',
          optional: true,
        },
      ],
      options: [
        {
          flag: '--subtree',
          help: 'one table of every live descendant (and those ended in the last 2h): model, state, task, PR and its last line',
        },
        { flag: '--json', help: 'print the session, or with --subtree its rows, as JSON' },
      ],
    }),
  ],
});
