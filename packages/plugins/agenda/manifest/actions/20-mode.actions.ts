/** Agenda mode: `GET|PATCH /v1/ferrets/:ferretId/agenda-mode` (Agenda's; ports/agenda.md lists session/agenda-mode with it), `fy agenda mode`, the toolbar switch. */
import { manifestFragment, panel, route, verb } from '@ferretry/kernel/manifest';
import { AGENDA_MODE_CHANGED_AUDIT, AgendaModeChanged } from '../../contract/index.ts';

export default manifestFragment({
  routes: [
    route('GET /v1/ferrets/:ferretId/agenda-mode', {
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      audit: { skip: 'a read of one switch' },
      guard: { none: 'a boolean and a sentence' },
    }),
    route('PATCH /v1/ferrets/:ferretId/agenda-mode', {
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      audit: { record: AGENDA_MODE_CHANGED_AUDIT },
      guard: { none: 'a boolean and a sentence' },
    }),
  ],
  cli: [
    verb('agenda mode', {
      summary: 'switch agenda mode for a ferret or for new ferrets',
      args: [{ name: 'mode', help: 'on or off', optional: true }],
      options: [
        { flag: '--ferret <id>', help: 'the ferret to read or switch' },
        { flag: '--json', help: 'print the answer as JSON' },
      ],
    }),
  ],
  ui: { panels: [panel('ferret.toolbar', { id: 'ferret-agenda-mode', order: 60 })] },
  data: { publishes: [AgendaModeChanged] },
});
