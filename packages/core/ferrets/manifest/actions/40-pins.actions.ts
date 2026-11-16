/** A ferret's pin board and the sidebar pin: the routes and `fy pin`. */
import { route, verb } from '@ferretry/kernel/manifest';
import { FLEET_USE, ferretRead, fragment } from '../kit.ts';

export default fragment({
  routes: [
    // Pins (today's mounts/session-pin.ts and mounts/pins.ts, renamed): the owner's sidebar pin is a person's act. It answers
    // the ferret's whole identity record and takes any ferret by name, so a device narrowed off fleet use is refused (c58-sec2).
    route('POST /v1/ferrets/:ferretId/pin', {
      minimum: 'operator',
      caller: 'person',
      capability: FLEET_USE,
      noStore: true,
      audit: { skip: 'a sidebar pin records nothing, as today' },
      guard: { none: 'one ferret identity record with its pin instant' },
    }),
    route('POST /v1/ferrets/:ferretId/unpin', {
      minimum: 'operator',
      caller: 'person',
      capability: FLEET_USE,
      noStore: true,
      audit: { skip: 'a sidebar unpin records nothing, as today' },
      guard: { none: 'one ferret identity record' },
    }),
    ferretRead('GET /v1/ferrets/:ferretId/pins', {
      audit: { skip: 'a pin board read records nothing, as today' },
      guard: { none: 'the notes and message references a person or the ferret pinned' },
    }),
    // The write side of the board the read above guards (c58-sec2): add, edit and remove are one `fleet.use`
    // demand like the read, so a device narrowed off fleet use can neither read nor change a ferret's pinned notes.
    // `use`, not `configure`: a note pin changes no host behaviour, and `configure` would put a passkey step-up on the app's
    // ordinary pin button. A ferret's own credential is never grant-governed, so it keeps its own board.
    route('POST /v1/ferrets/:ferretId/pins', {
      minimum: 'operator',
      caller: 'any',
      capability: FLEET_USE,
      noStore: true,
      audit: { skip: 'a pin board change records nothing, as today' },
      guard: { none: 'answers the pin board' },
    }),
  ],
  cli: [
    // V-0341…: today’s `fy pin`: a ferret’s pin board; `fy pin <words>` is `fy pin add <words>`.
    verb('pin add <text...>', {
      summary: 'pin a note to the board',
      default: true,
      args: [{ name: 'text', help: 'the note to pin', variadic: true }],
      options: [
        { flag: '-s, --session <id>', help: 'another ferret’s board (defaults to the ferret this runs inside)' },
        { flag: '--json', help: 'print the daemon’s answer as JSON' },
      ],
    }),
    verb('pin ls', {
      summary: 'list the pins on the board',
      args: [],
      options: [
        { flag: '-s, --session <id>', help: 'another ferret’s board (defaults to the ferret this runs inside)' },
        { flag: '--json', help: 'print the daemon’s answer as JSON' },
      ],
    }),
    verb('pin edit <id> <text...>', {
      summary: 'replace the text of a note pin',
      args: [
        { name: 'id', help: 'the pin id, or the short id `pin ls` prints' },
        { name: 'text', help: 'the replacement note', variadic: true },
      ],
      options: [
        { flag: '-s, --session <id>', help: 'another ferret’s board (defaults to the ferret this runs inside)' },
        { flag: '--json', help: 'print the daemon’s answer as JSON' },
      ],
    }),
    verb('pin rm <id>', {
      summary: 'remove a pin from the board',
      args: [{ name: 'id', help: 'the pin id, or the short id `pin ls` prints' }],
      options: [
        { flag: '-s, --session <id>', help: 'another ferret’s board (defaults to the ferret this runs inside)' },
        { flag: '--json', help: 'print the daemon’s answer as JSON' },
      ],
    }),
  ],
});
