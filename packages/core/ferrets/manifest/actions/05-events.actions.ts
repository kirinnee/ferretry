/** The fleet journal stream: the `GET /v1/events` socket and `fy stream` / `fy events`. */
import { socket, verb } from '@ferretry/kernel/manifest';
import { FLEET_USE, fragment } from '../kit.ts';

export default fragment({
  sockets: [
    // R-0424: the journal stream (a ferret from its cursor, or the fleet's recent tail). Today's descriptor.
    socket('GET /v1/events', {
      minimum: 'operator',
      caller: 'any',
      capability: FLEET_USE,
      audit: { skip: 'a live read of the journals records nothing' },
      guard: 'secrets',
    }),
  ],
  cli: [
    // V-0452: today's `fy stream [id]`: the journal socket `GET /v1/events`, followed until interrupted.
    verb('stream [id]', {
      summary: "follow one ferret or this daemon's whole fleet until interrupted",
      args: [{ name: 'id', help: 'optional session id; omitted follows the daemon-local fleet', optional: true }],
      options: [
        { flag: '--after <sequence>', help: 'start after this sequence' },
        { flag: '--json', help: 'print one protocol event per line' },
      ],
    }),
    // V-0258: today’s `fy events <id>`: the journal after a cursor, read through the stream socket.
    verb('events <id>', {
      summary: 'read the events the daemon recorded for a ferret',
      args: [{ name: 'id', help: 'session id or callsign' }],
      options: [
        { flag: '--after <sequence>', help: 'start after this sequence' },
        { flag: '--limit <count>', help: 'stop after this many events' },
        { flag: '--json', help: 'print one protocol event per line' },
      ],
    }),
  ],
});
