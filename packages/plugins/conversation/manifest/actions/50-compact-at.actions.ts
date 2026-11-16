/** When a ferret squeezes its memory: the two compact-at routes and `fy compact-at`. */
import { route, verb } from '@ferretry/kernel/manifest';
import { COMPACT_AT_CHANGED_AUDIT } from '../../contract/index.ts';
import { ACK, FERRET, fragment, READ } from '../kit.ts';

export default fragment({
  routes: [
    route('GET /v1/ferrets/:ferretId/compact-at', { ...FERRET, ...READ, ...ACK }),
    route('PATCH /v1/ferrets/:ferretId/compact-at', {
      ...FERRET,
      audit: { record: COMPACT_AT_CHANGED_AUDIT },
      ...ACK,
    }),
  ],
  cli: [
    verb('compact-at', {
      summary: 'when a ferret squeezes its memory',
      args: [
        { name: 'ferret', help: 'the ferret to read or change' },
        {
          name: 'value',
          help: 'a size like 250k, auto (the harness’s own trigger) or inherit; leave out to read',
          optional: true,
        },
      ],
      options: [{ flag: '--json', help: 'print the answer as JSON' }],
    }),
  ],
});
