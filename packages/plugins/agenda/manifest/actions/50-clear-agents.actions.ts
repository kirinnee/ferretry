/** Clearing the agent ferrets' backlog: `fy agenda clear` and the page button. The route it calls is declared in 10-roll-up (route order is hashed). */
import { appAction, manifestFragment, verb } from '@ferretry/kernel/manifest';

export default manifestFragment({
  cli: [
    verb('agenda clear', {
      summary: 'dismiss the agent ferrets’ backlog (--dry-run counts it)',
      args: [],
      options: [
        { flag: '--agents', help: 'clear the boards of the agent ferrets (the only thing there is to clear yet)' },
        { flag: '--dry-run', help: 'say what would be cleared and clear nothing' },
        { flag: '--yes', help: 'do not ask first' },
        { flag: '--json', help: 'print the protocol payload instead of the human rendering' },
      ],
    }),
  ],
  app: [
    appAction('agenda.clear-agents', {
      on: 'page',
      label: 'Clear agent ferrets',
      calls: 'POST /v1/agenda/clear-agents',
    }),
  ],
});
