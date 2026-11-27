import { FerretsPort } from '@ferretry/core-ferrets/contract';
import { cap } from '@ferretry/core-gate/contract';
import { definePlugin, route } from '@ferretry/kernel/manifest';
import { MOVED_STATE, RELOCATE_AUDIT } from './contract/index.ts';

/**
 * Relocate (C-45, source side): moves a ferret to another machine the person's app is already paired to. The TARGET
 * opens a one-time X25519 offer signed by its daemon identity; the SOURCE seals a snapshot of the ferret to it; the app
 * carries only ciphertext between the two. No daemon talks to another daemon, nothing is paired, no credential is made,
 * and no secret value, credential file or ignored file is in what is sealed (`contract/wire.ts` is the whole table).
 *
 * Every route is a person's and a fleet write (`fleet.configure`: a governed device steps up with its passkey); the
 * handler also asks `filesystem.use`, because a move reads one working tree. A ferret can never move itself or another.
 * After a move the source keeps every file and becomes a read-only stub that says where the ferret went.
 */
export default definePlugin({
  id: 'relocate',
  title: 'Move to another machine',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['command'],

  needs: { ferrets: FerretsPort },

  actions: {
    routes: [
      route('POST /v1/relocate/:ferretId/preflight', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('fleet', 'configure'),
        noStore: true,
        audit: { skip: 'a read: it lists what would move and changes nothing' },
        guard: { none: 'names, counts, sizes and fixed sentences; no file content, secret or transcript text' },
      }),
      route('POST /v1/relocate/:ferretId/export', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('fleet', 'configure'),
        noStore: true,
        audit: { record: RELOCATE_AUDIT.exported },
        guard: {
          none: 'an id, a header and a size; the snapshot leaves only as ciphertext sealed to the target’s key',
        },
      }),
      route('GET /v1/relocate/exports/:exportId/chunks/:index', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('fleet', 'configure'),
        noStore: true,
        audit: { skip: 'a chunk of ciphertext the export already recorded; the route reads nothing else' },
        guard: { none: 'AES-GCM ciphertext only: nothing a person can read without the target’s one-time key' },
      }),
      route('POST /v1/relocate/exports/:exportId/complete', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('fleet', 'configure'),
        noStore: true,
        audit: { record: RELOCATE_AUDIT.moved },
        guard: { none: 'two ids and an instant; nothing of the ferret' },
      }),
    ],
  },

  data: { state: [MOVED_STATE] },

  // The working tree is read through the `imports` root, scoped to the one folder the ferret works in, and git is run
  // only to list, diff and bundle it.
  permissions: { roots: ['imports'], spawn: ['git'] },
});
