/** The daemon's own agenda (what the machine itself has to tell the owner): read the roll-up and one notice, and act on one. */
import { manifestFragment, route } from '@ferretry/kernel/manifest';
import { MACHINE_AGENDA_ACTED_AUDIT } from '../../contract/index.ts';

export default manifestFragment({
  routes: [
    route('GET /v1/machine/agenda', {
      minimum: 'operator',
      caller: 'person',
      noStore: true,
      audit: { skip: 'a read of the daemon agenda' },
      guard: { none: 'daemon notices are authored text; no pane, page or vault text' },
    }),
    route('GET /v1/machine/agenda/:id', {
      minimum: 'operator',
      caller: 'person',
      noStore: true,
      audit: { skip: 'a read of one daemon notice' },
      guard: { none: 'daemon notices are authored text; no pane, page or vault text' },
    }),
    route('POST /v1/machine/agenda', {
      minimum: 'operator',
      caller: 'person',
      noStore: true,
      audit: { record: MACHINE_AGENDA_ACTED_AUDIT },
      guard: { none: 'answers the acted notice' },
    }),
  ],
});
