import { FerretsPort } from '@ferretry/core-ferrets/contract';
import { cap } from '@ferretry/core-gate/contract';
import { definePlugin, route } from '@ferretry/kernel/manifest';
import { MOVE_SOURCE_GIT_READS } from '@ferretry/kernel/contract';
import { GitAccountsPort } from '@ferretry/plugin-git-accounts/contract';
import { ProjectsPort } from '@ferretry/plugin-projects/contract';
import { RuntimesPort } from '@ferretry/plugin-runtimes/contract';
import { VaultPort } from '@ferretry/core-vault/contract';
import { MOVED_STATE, RECEIVED_STATE, RELOCATE_AUDIT } from './contract/index.ts';

/**
 * Relocate (C-45, source and target): moves a ferret to another machine the person's app is already paired to. The TARGET
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
  // The target's neighbours, all optional: with one off, a move that needs it is refused with a sentence (never a crash).
  uses: { projects: ProjectsPort, gitAccounts: GitAccountsPort, runtimes: RuntimesPort, vault: VaultPort },

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
      route('POST /v1/relocate/offers', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('fleet', 'configure'),
        noStore: true,
        audit: { skip: 'opens a one-time public key in memory: nothing is written, nothing is read' },
        guard: { none: 'a public key and an id, signed by this daemon; the private key never leaves memory' },
      }),
      route('POST /v1/relocate/offers/:offerId/preflight', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('fleet', 'configure'),
        noStore: true,
        audit: { skip: 'a read: it says what this machine has and lacks and changes nothing' },
        guard: { none: 'names, a harness, a remote with no credential and secret NAMES; never a value' },
      }),
      route('PUT /v1/relocate/offers/:offerId/chunks/:index', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('fleet', 'configure'),
        noStore: true,
        audit: { skip: 'a chunk of ciphertext kept in memory; the import that opens it is audited' },
        guard: { none: 'AES-GCM ciphertext only: nothing here can be read without the one-time key held in memory' },
      }),
      route('POST /v1/relocate/offers/:offerId/import', {
        minimum: 'operator',
        caller: 'person',
        capability: cap('fleet', 'configure'),
        noStore: true,
        audit: { record: RELOCATE_AUDIT.imported },
        guard: { none: 'a header and a folder; every hash is verified before anything is written' },
      }),
    ],
  },

  data: { state: [MOVED_STATE, RECEIVED_STATE] },

  // The working tree is read through the `imports` root, scoped to the one folder the ferret works in, and git is run
  // only to list, diff and bundle it.
  permissions: {
    roots: ['imports', 'worktrees'],
    spawn: ['git'],
    readOnlySpawn: MOVE_SOURCE_GIT_READS,
    writePins: [{ root: 'imports', capability: cap('fleet', 'configure').capability }],
  },
});
