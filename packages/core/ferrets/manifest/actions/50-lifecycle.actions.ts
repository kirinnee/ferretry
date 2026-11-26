/** Stop, resume, rename and revoke a ferret; `fy stop`, `rename`, `resume` and `session`. */
import { AUDIT_KINDS } from '@ferretry/core-gate/contract';
import { route, verb } from '@ferretry/kernel/manifest';
import { FLEET_CONFIGURE, FLEET_USE, fragment } from '../kit.ts';

export default fragment({
  routes: [
    // R-0372
    route('POST /v1/ferrets/:ferretId/stop', {
      minimum: 'operator',
      caller: 'any',
      capability: FLEET_USE,
      noStore: true,
      audit: { skip: 'a stop is recorded in the ferret history, as today' },
      guard: { none: 'answers the new state only' },
    }),
    // R-0363
    route('POST /v1/ferrets/:ferretId/resume', {
      minimum: 'operator',
      caller: 'any',
      capability: FLEET_USE,
      noStore: true,
      consultsGrants: true,
      audit: { skip: 'a resume is recorded in the ferret history, as today' },
      guard: { none: 'answers the ferret id only' },
    }),
    // R-0362
    route('POST /v1/ferrets/:ferretId/rename', {
      minimum: 'operator',
      caller: 'any',
      capability: FLEET_USE,
      noStore: true,
      audit: { skip: 'a rename records nothing, as today' },
      guard: { none: 'one ferret identity record' },
    }),
    // R-0364
    route('POST /v1/ferrets/:ferretId/revoke-credential', {
      minimum: 'operator',
      caller: 'person',
      capability: FLEET_CONFIGURE,
      noStore: true,
      audit: { record: AUDIT_KINDS['ferret.credential-revoked'] },
      guard: { none: 'answers whether a token was live, never a token or digest' },
    }),
  ],
  cli: [
    verb('stop [ferret]', {
      summary: 'stop one ferret by id or callsign (it can resume), or ferrets in bulk with a sub-verb below',
      args: [{ name: 'ferret', help: 'id or callsign of the one ferret to stop', optional: true }],
      options: [
        { flag: '-r, --reason <text>', help: 'reason recorded against every stopped session' },
        // A bulk mode's switches, typed before the mode: they would swallow it, so a lone word beside one is a usage error.
        { flag: '-n, --dry-run', help: 'a bulk mode’s switch: put it after the mode', hidden: true },
        { flag: '-y, --yes', help: 'a bulk mode’s switch: put it after the mode', hidden: true },
        { flag: '--include-caller', help: 'a bulk mode’s switch: put it after the mode', hidden: true },
      ],
    }),
    verb('stop orphan <session>', {
      summary: 'stop one ferret and leave its helpers running',
      args: [{ name: 'session', help: 'session to stop' }],
      options: [
        { flag: '-r, --reason <text>', help: 'reason recorded against every stopped session' },
        { flag: '-n, --dry-run', help: 'print the plan and stop nothing' },
        { flag: '-y, --yes', help: 'skip the typed confirmation' },
        { flag: '--include-caller', help: 'also stop the issuing session, last' },
      ],
    }),
    verb('stop cascade <session>', {
      summary: 'stop a ferret and every transitive helper',
      args: [{ name: 'session', help: 'root of the subtree to stop' }],
      options: [
        { flag: '-r, --reason <text>', help: 'reason recorded against every stopped session' },
        { flag: '-n, --dry-run', help: 'print the plan and stop nothing' },
        { flag: '-y, --yes', help: 'skip the typed confirmation' },
        { flag: '--include-caller', help: 'also stop the issuing session, last' },
      ],
    }),
    verb('stop children <session>', {
      summary: 'stop every transitive helper and keep the ferret running',
      args: [{ name: 'session', help: 'root whose descendants are stopped' }],
      options: [
        { flag: '-r, --reason <text>', help: 'reason recorded against every stopped session' },
        { flag: '-n, --dry-run', help: 'print the plan and stop nothing' },
        { flag: '-y, --yes', help: 'skip the typed confirmation' },
        { flag: '--include-caller', help: 'also stop the issuing session, last' },
      ],
    }),
    verb('stop label <label>', {
      summary: 'stop every ferret in a pack, independent of lineage',
      args: [{ name: 'label', help: 'exact label to match' }],
      options: [
        { flag: '-r, --reason <text>', help: 'reason recorded against every stopped session' },
        { flag: '-n, --dry-run', help: 'print the plan and stop nothing' },
        { flag: '-y, --yes', help: 'skip the typed confirmation' },
        { flag: '--include-caller', help: 'also stop the issuing session, last' },
      ],
    }),
    verb('rename <session> [name]', {
      summary: 'give a ferret a new first name',
      args: [
        { name: 'session', help: 'session id or current first name' },
        {
          name: 'name',
          help: 'the new first name: letters, digits or hyphens, starting with a letter',
          optional: true,
        },
      ],
      options: [
        { flag: '--title <title>', help: 'a new task title' },
        { flag: '--json', help: 'print the renamed session as JSON' },
      ],
    }),
    verb('resume <id> [message...]', {
      summary: 'revive a stopped ferret with its conversation intact',
      args: [
        { name: 'id', help: 'session id or callsign' },
        { name: 'message', help: 'optional message to deliver on revival', optional: true, variadic: true },
      ],
      options: [{ flag: '--json', help: 'print the session as JSON' }],
    }),
    verb('session', { summary: "act on a ferret's own standing with this daemon", args: [] }),
    verb('session revoke-credential <session>', {
      summary: 'cut a ferret off at once: its own credential stops working until a person resumes it',
      args: [{ name: 'session', help: 'session id or first name' }],
      options: [{ flag: '--json', help: 'print the answer as JSON' }],
    }),
    verb('session pin <session>', {
      summary: 'pin a ferret to the top of the sidebar',
      args: [{ name: 'session', help: 'session id or first name' }],
      options: [{ flag: '--json', help: 'print the session as JSON' }],
    }),
    verb('session unpin <session>', {
      summary: 'unpin a ferret from the top of the sidebar',
      args: [{ name: 'session', help: 'session id or first name' }],
      options: [{ flag: '--json', help: 'print the session as JSON' }],
    }),
  ],
});
