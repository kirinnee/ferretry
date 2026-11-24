/** A ferret's file browser: the `fs` routes and `fy fs`. */
import { CAPABILITIES } from '@ferretry/core-gate/contract';
import { route, verb } from '@ferretry/kernel/manifest';
import { fragment } from '../kit.ts';

export default fragment({
  routes: [
    // R-0151 (S47)
    route('GET /v1/ferrets/:ferretId/fs/file', {
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      capability: { capability: CAPABILITIES.filesystem, axis: 'use' },
      audit: { skip: 'a file read records nothing, as today' },
      guard: 'secrets',
    }),
    // A ferret's MEDIA file as raw bytes, in ranges (docs/fy-render.md rule 11): the same `filesystem` use grant as the
    // JSON read it lifts the 1 MiB cap of, and no new capability (docs/grants.md).
    route('GET /v1/ferrets/:ferretId/fs/media', {
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      capability: { capability: CAPABILITIES.filesystem, axis: 'use' },
      audit: { skip: 'a media read records nothing, as a file read does not' },
      guard: 'secrets',
    }),
    // The file browser (today's `mounts/session-filesystem.ts`). They answer 503 until the kernel's root walk lands.
    // R-0152
    route('GET /v1/ferrets/:ferretId/fs/index', {
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      capability: { capability: CAPABILITIES.filesystem, axis: 'use' },
      audit: { skip: 'a file index read records nothing, as today' },
      guard: 'secrets',
    }),
    // R-0149
    route('GET /v1/ferrets/:ferretId/fs/changes', {
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      capability: { capability: CAPABILITIES.filesystem, axis: 'use' },
      audit: { skip: 'a change list read records nothing, as today' },
      guard: 'secrets',
    }),
    // R-0150
    route('GET /v1/ferrets/:ferretId/fs/diff', {
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      capability: { capability: CAPABILITIES.filesystem, axis: 'use' },
      audit: { skip: 'a diff read records nothing, as today' },
      guard: 'secrets',
    }),
    // R-0148
    route('GET /v1/ferrets/:ferretId/fs', {
      minimum: 'operator',
      caller: 'any',
      noStore: true,
      capability: { capability: CAPABILITIES.filesystem, axis: 'use' },
      audit: { skip: 'a folder listing records nothing, as today' },
      guard: 'secrets',
    }),
  ],
  cli: [
    // V-0262…: today’s `fy fs`, read-only over the file browser’s routes.
    verb('fs', { summary: 'read a ferret’s working tree, never writing it', args: [] }),
    verb('fs ls <id> [path]', {
      summary: 'list a directory of a ferret’s working tree',
      args: [
        { name: 'id', help: 'session id or callsign' },
        { name: 'path', help: 'relative directory', optional: true },
      ],
      options: [{ flag: '--json', help: 'print the daemon’s answer as JSON' }],
    }),
    verb('fs index <id>', {
      summary: 'every searchable file under the ferret’s root in one read, with what it left out',
      args: [{ name: 'id', help: 'session id or callsign' }],
      options: [
        { flag: '--query <text>', help: 'only files whose name or path contains this text' },
        { flag: '--json', help: 'print the daemon’s answer as JSON' },
      ],
    }),
    verb('fs cat <id> <path>', {
      summary: 'read one file of a ferret’s working tree',
      args: [
        { name: 'id', help: 'session id or callsign' },
        { name: 'path', help: 'relative file path' },
      ],
      options: [
        { flag: '--head', help: 'read the file recorded in Git HEAD instead of the working tree' },
        { flag: '--json', help: 'print the daemon’s answer as JSON' },
      ],
    }),
    verb('fs changes <id>', {
      summary: 'the Git working-tree changes of a ferret’s folder',
      args: [{ name: 'id', help: 'session id or callsign' }],
      options: [{ flag: '--json', help: 'print the daemon’s answer as JSON' }],
    }),
    verb('fs diff <id> <path>', {
      summary: 'the unified diff of one changed path',
      args: [
        { name: 'id', help: 'session id or callsign' },
        { name: 'path', help: 'relative changed path' },
      ],
      options: [{ flag: '--json', help: 'print the daemon’s answer as JSON' }],
    }),
  ],
});
