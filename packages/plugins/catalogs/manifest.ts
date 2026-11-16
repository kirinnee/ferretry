import { Credentials, GatePort } from '@ferretry/core-gate/contract';
import { VaultPort, SealedDocumentsPort } from '@ferretry/core-vault/contract';
import { CatalogLinkKeys, CatalogInstallPrefs } from './contract/storage.ts';
import { CatalogsConfigFile } from './contract/config.ts';
import { defineState, SessionModes } from '@ferretry/kernel/contract';
import { definePlugin, memberRoute, panel, route, screen, verb } from '@ferretry/kernel/manifest';
import { AccessPort } from '@ferretry/plugin-access/contract';
import { ConnectionsPort } from '@ferretry/plugin-connections/contract';
import { ProjectsPort } from '@ferretry/plugin-projects/contract';
import { SKILLS_ADD_SLOT, SkillsPort } from '@ferretry/plugin-skills/contract';
import {
  AUDIT,
  CATALOGS_WORDS,
  CatalogsChanged,
  CatalogsPort,
  ShareWindowPort,
  CatalogItems,
  CONFIGURE,
  GUARD_NONE,
  NARROW,
  SKIP_READ,
  SKIP_UNRECORDED,
  USE,
} from './contract/index.ts';
// Package-internal wire: the bodies each member route parses and answers, which the member-surface hash covers (§9.6).
import {
  SharedCatalogItemSchema,
  SharedContractSchema,
  SharedMeSchema,
  SharedRedeemRequestSchema,
  SharedRedeemResponseSchema,
  SignedCatalogItemVersionsSchema,
  SignedCatalogManifestSchema,
} from './contract/wire/index.ts';
import {
  PasskeyOptionsRequestSchema,
  PasskeyRegistrationOptionsSchema,
  PasskeyRegistrationSchema,
  PasskeyViewSchema,
  StepUpAssertionSchema,
  StepUpOptionsSchema,
  UnlockGrantedSchema,
} from './contract/wire/member-passkeys.ts';

/**
 * Catalogs (§2.3): share your setup — MCP servers, skills, shells, recipes, layouts — with other daemons and people.
 * Off: nothing is shared; your items still work.
 *
 * Routes copied from today's `runtime/mounts/{shared-catalogs,catalog-members,catalog-links,catalog-installs}.ts`;
 * member routes from `catalog-members/shared-routes.ts`. `/v1/projects` and `/v1/skills*` (mounted from `catalogs.ts`
 * today) are Projects' and Skills', not declared here — see the slice report.
 * Every catalog is signed by the publisher's daemon identity; installing shows every file and command in full and
 * asks your yes for anything that runs one; a pin never auto-updates.
 */
export default definePlugin({
  id: 'catalogs',
  title: 'Catalogs',
  version: '5.0.0',
  api: 5,
  core: false,
  kinds: ['session-mode', 'credential-provider', 'item', 'command', 'view'],
  words: CATALOGS_WORDS,

  // TODO(kernel contract): `permissions: { network: [{ resolver: 'link-store' }] }` and the half's
  // `resolvers['link-store']` (the configured `catalogs.linkStore.url` or Connections' directory origin, plus every
  // existing link's remembered origin) need rebuild/port-kernel's ResolverEntry. Until then `kernel.fetch` refuses
  // every link-store host, so making, refreshing or deleting a download link fails closed.
  needs: { access: AccessPort, gate: GatePort, vault: VaultPort, sealed: SealedDocumentsPort },
  /** Projects is optional: off, an install can only target the project folders the item providers name. */
  // Skills: the app half reads the skills.add slot's props shape (add-skills page) and Skills' machine inventory (`GET /v1/skills`).
  uses: { connections: ConnectionsPort, projects: ProjectsPort, skills: SkillsPort },
  provides: { catalogs: CatalogsPort, shareWindow: ShareWindowPort },

  // The install mapping offers the person the NAMES of their secrets for a `${secret:NAME}` placeholder (never a value),
  // behind the secrets-use grant. Catalogs mints no Vault secret and writes none: its link keys are its own sealed documents.
  permissions: { secretNamePicker: true },

  actions: {
    routes: [
      route('GET /v1/catalog-installs', {
        minimum: 'operator',
        caller: 'any',
        capability: USE.fleet,
        noStore: true,
        audit: SKIP_READ,
        guard: GUARD_NONE,
      }),
      route('GET /v1/catalog-installs/targets', {
        minimum: 'operator',
        caller: 'any',
        capability: USE.fleet,
        noStore: true,
        audit: SKIP_READ,
        guard: GUARD_NONE,
      }),
      route('POST /v1/catalog-installs/project', {
        minimum: 'operator',
        caller: 'person',
        capability: CONFIGURE.filesystem,
        noStore: true,
        audit: { record: AUDIT.fleetConfigured },
        guard: GUARD_NONE,
      }),
      route('DELETE /v1/catalog-installs/project/:installId', {
        minimum: 'operator',
        caller: 'person',
        capability: CONFIGURE.filesystem,
        noStore: true,
        audit: { record: AUDIT.fleetConfigured },
        guard: GUARD_NONE,
      }),
      route('PATCH /v1/catalog-installs/project/:installId', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.filesystem,
        noStore: true,
        audit: SKIP_UNRECORDED,
        guard: GUARD_NONE,
      }),
      route('POST /v1/catalog-installs/project/preview', {
        minimum: 'operator',
        caller: 'any',
        capability: USE.filesystem,
        noStore: true,
        audit: SKIP_UNRECORDED,
        guard: GUARD_NONE,
      }),
      route('POST /v1/catalog-installs/runtime', {
        minimum: 'operator',
        caller: 'person',
        capability: CONFIGURE.fleet,
        noStore: true,
        audit: { record: AUDIT.fleetConfigured },
        guard: GUARD_NONE,
      }),
      route('DELETE /v1/catalog-installs/runtime/:installId', {
        minimum: 'operator',
        caller: 'person',
        capability: CONFIGURE.fleet,
        noStore: true,
        audit: { record: AUDIT.fleetConfigured },
        guard: GUARD_NONE,
      }),
      route('PATCH /v1/catalog-installs/runtime/:installId', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.fleet,
        noStore: true,
        audit: SKIP_UNRECORDED,
        guard: GUARD_NONE,
      }),
      route('POST /v1/catalog-installs/runtime/preview', {
        minimum: 'operator',
        caller: 'any',
        capability: USE.fleet,
        noStore: true,
        audit: SKIP_UNRECORDED,
        guard: GUARD_NONE,
      }),
      route('GET /v1/catalog-items', {
        minimum: 'operator',
        caller: 'any',
        capability: USE.sharing,
        noStore: true,
        audit: SKIP_READ,
        guard: GUARD_NONE,
      }),
      route('GET /v1/catalog-items/:itemId', {
        minimum: 'operator',
        caller: 'any',
        capability: USE.sharing,
        noStore: true,
        audit: SKIP_READ,
        guard: GUARD_NONE,
      }),
      route('GET /v1/catalog-items/:itemId/changes', {
        minimum: 'operator',
        caller: 'any',
        capability: USE.sharing,
        noStore: true,
        audit: SKIP_READ,
        guard: GUARD_NONE,
      }),
      route('PUT /v1/catalog-items/:itemId/current', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.sharing,
        noStore: true,
        audit: { record: AUDIT.catalogChanged },
        guard: GUARD_NONE,
      }),
      route('POST /v1/catalog-items/:itemId/versions', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.sharing,
        noStore: true,
        audit: { record: AUDIT.catalogChanged },
        guard: GUARD_NONE,
      }),
      route('GET /v1/catalog-items/:itemId/versions/:version', {
        minimum: 'operator',
        caller: 'any',
        capability: USE.sharing,
        noStore: true,
        audit: SKIP_READ,
        guard: GUARD_NONE,
      }),
      route('PATCH /v1/catalog-items/:itemId/versions/:version', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.sharing,
        noStore: true,
        audit: { record: AUDIT.catalogChanged },
        guard: GUARD_NONE,
      }),
      route('POST /v1/catalog-items/:itemId/versions/preview', {
        minimum: 'operator',
        caller: 'any',
        capability: USE.sharing,
        noStore: true,
        audit: SKIP_UNRECORDED,
        guard: GUARD_NONE,
      }),
      route('POST /v1/catalog-items/quick-add', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.sharing,
        noStore: true,
        audit: { record: AUDIT.catalogChanged },
        guard: GUARD_NONE,
      }),
      route('POST /v1/catalog-items/quick-add/undo', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.sharing,
        noStore: true,
        audit: { record: AUDIT.catalogChanged },
        guard: GUARD_NONE,
      }),
      route('GET /v1/catalog-links', {
        minimum: 'operator',
        caller: 'any',
        capability: USE.sharing,
        noStore: true,
        audit: SKIP_READ,
        guard: GUARD_NONE,
      }),
      route('POST /v1/catalog-links', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.sharing,
        noStore: true,
        audit: { record: AUDIT.catalogLinkMinted },
        guard: GUARD_NONE,
      }),
      route('DELETE /v1/catalog-links/:linkId', {
        minimum: 'operator',
        caller: 'person',
        capability: NARROW.sharing,
        noStore: true,
        audit: { record: AUDIT.catalogLinkEnded },
        guard: GUARD_NONE,
      }),
      route('GET /v1/catalog-links/:linkId', {
        minimum: 'operator',
        caller: 'any',
        capability: USE.sharing,
        noStore: true,
        audit: SKIP_READ,
        guard: GUARD_NONE,
      }),
      route('PATCH /v1/catalog-links/:linkId', {
        minimum: 'operator',
        caller: 'person',
        capability: NARROW.sharing,
        noStore: true,
        audit: { record: AUDIT.catalogLinkChanged },
        guard: GUARD_NONE,
      }),
      route('POST /v1/catalog-links/:linkId/copy', {
        minimum: 'operator',
        caller: 'person',
        capability: NARROW.sharing,
        noStore: true,
        audit: { record: AUDIT.catalogLinkCopied },
        guard: GUARD_NONE,
      }),
      route('PUT /v1/catalog-links/:linkId/version', {
        minimum: 'operator',
        caller: 'person',
        capability: NARROW.sharing,
        noStore: true,
        audit: { record: AUDIT.catalogLinkMoved },
        guard: GUARD_NONE,
      }),
      route('POST /v1/catalog-links/preview', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.sharing,
        noStore: true,
        audit: SKIP_UNRECORDED,
        guard: GUARD_NONE,
      }),
      route('GET /v1/catalog-links/store', {
        minimum: 'operator',
        caller: 'any',
        capability: USE.sharing,
        noStore: true,
        audit: SKIP_READ,
        guard: GUARD_NONE,
      }),
      route('GET /v1/catalog-members', {
        minimum: 'operator',
        caller: 'any',
        capability: USE.sharing,
        noStore: true,
        audit: SKIP_READ,
        guard: GUARD_NONE,
      }),
      route('DELETE /v1/catalog-members/:memberId', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.sharing,
        noStore: true,
        audit: { record: AUDIT.catalogMemberRevoked },
        guard: GUARD_NONE,
      }),
      route('PATCH /v1/catalog-members/:memberId', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.sharing,
        noStore: true,
        audit: { record: AUDIT.catalogMemberRenamed },
        guard: GUARD_NONE,
      }),
      route('DELETE /v1/catalog-members/:memberId/catalogs/:catalogId', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.sharing,
        noStore: true,
        audit: { record: AUDIT.catalogMemberCatalogRemoved },
        guard: GUARD_NONE,
      }),
      route('DELETE /v1/catalog-members/:memberId/keys/:keyId', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.sharing,
        noStore: true,
        audit: { record: AUDIT.catalogMemberKeyRemoved },
        guard: GUARD_NONE,
      }),
      route('GET /v1/catalog-shares', {
        minimum: 'operator',
        caller: 'any',
        capability: USE.sharing,
        noStore: true,
        audit: SKIP_READ,
        guard: GUARD_NONE,
      }),
      route('POST /v1/catalog-shares', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.sharing,
        noStore: true,
        audit: { record: AUDIT.catalogShareMinted },
        guard: GUARD_NONE,
      }),
      route('DELETE /v1/catalog-shares/:shareId', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.sharing,
        noStore: true,
        audit: { record: AUDIT.catalogShareEnded },
        guard: GUARD_NONE,
      }),
      route('DELETE /v1/catalog-shares/:shareId/new-passkey', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.sharing,
        noStore: true,
        audit: { record: AUDIT.catalogShareNewPasskeyCleared },
        guard: GUARD_NONE,
      }),
      route('PUT /v1/catalog-shares/:shareId/new-passkey', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.sharing,
        noStore: true,
        audit: { record: AUDIT.catalogShareNewPasskeyMarked },
        guard: GUARD_NONE,
      }),
      route('GET /v1/catalogs', {
        minimum: 'operator',
        caller: 'any',
        capability: USE.sharing,
        noStore: true,
        audit: SKIP_READ,
        guard: GUARD_NONE,
      }),
      route('POST /v1/catalogs', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.sharing,
        noStore: true,
        audit: { record: AUDIT.catalogChanged },
        guard: GUARD_NONE,
      }),
      route('DELETE /v1/catalogs/:id', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.sharing,
        noStore: true,
        audit: { record: AUDIT.catalogChanged },
        guard: GUARD_NONE,
      }),
      route('PATCH /v1/catalogs/:id', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.sharing,
        noStore: true,
        audit: { record: AUDIT.catalogChanged },
        guard: GUARD_NONE,
      }),
      route('POST /v1/catalogs/:id/export', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.sharing,
        noStore: true,
        audit: { record: AUDIT.catalogExported },
        guard: GUARD_NONE,
      }),
      route('POST /v1/catalogs/:id/items', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.sharing,
        noStore: true,
        audit: { record: AUDIT.catalogChanged },
        guard: GUARD_NONE,
      }),
      route('DELETE /v1/catalogs/:id/items/:itemId', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.sharing,
        noStore: true,
        audit: { record: AUDIT.catalogChanged },
        guard: GUARD_NONE,
      }),
      route('POST /v1/catalogs/:id/items/:itemId/versions', {
        minimum: 'operator',
        caller: 'person',
        capability: USE.sharing,
        noStore: true,
        audit: { record: AUDIT.catalogChanged },
        guard: GUARD_NONE,
      }),
      route('POST /v1/catalogs/:id/items/preview', {
        minimum: 'operator',
        caller: 'any',
        capability: USE.sharing,
        noStore: true,
        audit: SKIP_UNRECORDED,
        guard: GUARD_NONE,
      }),
    ],
    memberRoutes: [
      memberRoute('GET /v1/shared/catalogs/:catalogId/items/:itemId/:version', {
        response: SharedCatalogItemSchema,
        member: 'unlocked',
        catalog: 'path',
        noStore: true,
        audit: SKIP_READ,
        guard: GUARD_NONE,
      }),
      memberRoute('GET /v1/shared/catalogs/:catalogId/items/:itemId/versions', {
        response: SignedCatalogItemVersionsSchema,
        member: 'unlocked',
        catalog: 'path',
        noStore: true,
        audit: SKIP_READ,
        guard: GUARD_NONE,
      }),
      memberRoute('GET /v1/shared/catalogs/:catalogId/manifest', {
        response: SignedCatalogManifestSchema,
        member: 'unlocked',
        catalog: 'path',
        noStore: true,
        audit: SKIP_READ,
        guard: GUARD_NONE,
      }),
      memberRoute('GET /v1/shared/contract', {
        response: SharedContractSchema,
        member: 'unlocked',
        noStore: true,
        audit: SKIP_READ,
        guard: GUARD_NONE,
      }),
      memberRoute('GET /v1/shared/me', {
        response: SharedMeSchema,
        member: 'unlocked',
        noStore: true,
        audit: SKIP_READ,
        guard: GUARD_NONE,
      }),
      memberRoute('DELETE /v1/shared/me/keys/self', {
        member: 'unlocked',
        noStore: true,
        audit: { record: AUDIT.catalogMemberKeyRemoved },
        guard: GUARD_NONE,
      }),
      memberRoute('POST /v1/shared/passkeys', {
        request: PasskeyRegistrationSchema.omit({ confirmation: true }),
        response: PasskeyViewSchema,
        member: 'key',
        noStore: true,
        audit: { record: AUDIT.catalogMemberPasskeyAdded },
        guard: GUARD_NONE,
      }),
      memberRoute('POST /v1/shared/passkeys/options', {
        request: PasskeyOptionsRequestSchema,
        response: PasskeyRegistrationOptionsSchema,
        member: 'key',
        noStore: true,
        audit: SKIP_UNRECORDED,
        guard: GUARD_NONE,
      }),
      memberRoute('POST /v1/shared/redeem', {
        request: SharedRedeemRequestSchema,
        response: SharedRedeemResponseSchema,
        member: 'unlocked',
        noStore: true,
        audit: { record: AUDIT.catalogMemberJoined },
        guard: GUARD_NONE,
      }),
      memberRoute('POST /v1/shared/unlock', {
        request: StepUpAssertionSchema.omit({ rotation: true }),
        response: UnlockGrantedSchema,
        member: 'key',
        noStore: true,
        audit: { record: AUDIT.catalogMemberUnlocked },
        guard: GUARD_NONE,
      }),
      memberRoute('POST /v1/shared/unlock/options', {
        request: PasskeyOptionsRequestSchema,
        response: StepUpOptionsSchema,
        member: 'key',
        noStore: true,
        audit: SKIP_UNRECORDED,
        guard: GUARD_NONE,
      }),
    ],
    cli: [
      verb('catalog install', {
        summary: 'install one skill or MCP setup from a signed catalog file, after you review all of it',
        args: [{ name: 'file', help: 'a catalog file' }],
        options: [
          { flag: '--item <name>', help: 'which item to install (needed when the file carries several)' },
          { flag: '--project <root>', help: 'install into this project folder' },
          { flag: '--harness <harness>', help: 'claude or codex: which agent CLI the project is for' },
          { flag: '--runtime <name>', help: 'install into this runtime' },
          { flag: '--profile <name>', help: 'the runtime profile that gets it' },
          {
            flag: '--bind <placeholder=secret>',
            help: 'fill a placeholder with one of YOUR secrets (repeatable) (default: [])',
          },
          { flag: '--unbound <placeholder>', help: 'leave a placeholder unfilled (repeatable) (default: [])' },
          { flag: '--older', help: 'allow installing an older version than the one installed' },
          { flag: '--yes', help: 'do not ask before installing' },
          { flag: '--json', help: 'print the protocol payload instead of the human rendering' },
        ],
      }),
      verb('catalog installs', {
        summary: 'list what is installed from catalogs, and where',
        args: [],
        options: [{ flag: '--json', help: 'print the protocol payload instead of the human rendering' }],
      }),
      verb('catalog uninstall', {
        summary: 'remove one install, and only the files it wrote',
        args: [{ name: 'installId', help: 'an install id from "catalog installs"' }],
        options: [
          { flag: '--yes', help: 'do not ask before removing' },
          { flag: '--json', help: 'print the protocol payload instead of the human rendering' },
        ],
      }),
      verb('catalog ls', {
        default: true,
        summary: 'every catalog on this machine, with its items',
        args: [],
        options: [{ flag: '--json', help: 'print the protocol payload instead of the human rendering' }],
      }),
      verb('catalog create', {
        summary: 'make an empty catalog',
        args: [{ name: 'name', help: 'what people will see it called' }],
        options: [
          { flag: '--description <text>', help: 'a line about what it is for' },
          { flag: '--json', help: 'print the protocol payload instead of the human rendering' },
        ],
      }),
      verb('catalog rename', {
        summary: "change a catalog's name",
        args: [
          { name: 'catalog', help: 'the catalog id or name' },
          { name: 'name', help: 'the new name' },
        ],
        options: [{ flag: '--json', help: 'print the protocol payload instead of the human rendering' }],
      }),
      verb('catalog describe', {
        summary: "change a catalog's description",
        args: [
          { name: 'catalog', help: 'the catalog id or name' },
          { name: 'description', help: 'the new description' },
        ],
        options: [{ flag: '--json', help: 'print the protocol payload instead of the human rendering' }],
      }),
      verb('catalog default', {
        summary: 'make this the default catalog, where one tap adds',
        args: [{ name: 'catalog', help: 'the catalog id or name' }],
        options: [{ flag: '--json', help: 'print the protocol payload instead of the human rendering' }],
      }),
      verb('catalog rm', {
        summary: 'delete a catalog and every version in it',
        args: [{ name: 'catalog', help: 'the catalog id or name' }],
        options: [
          { flag: '-y, --yes', help: 'skip the y/N question; required when not on a terminal' },
          { flag: '--json', help: 'print the protocol payload instead of the human rendering' },
        ],
      }),
      verb('catalog add', {
        summary:
          'freeze a skill or an MCP setup into a catalog, or list an item you already keep, after showing you all of it',
        args: [{ name: 'catalog', help: 'the catalog id or name' }],
        options: [
          {
            flag: '--item <item>',
            help: 'an item this machine already keeps (id or name), listed here too at its current version',
          },
          { flag: '--skill <source>', help: 'a SKILL.md path from the skills inventory, or a skill name' },
          { flag: '--mcp <source>', help: 'an MCP inventory server id, or a server name' },
          { flag: '--summary <text>', help: "your own words for what it does, instead of the skill's description" },
          { flag: '-y, --yes', help: 'skip the y/N question; required when not on a terminal' },
          { flag: '--json', help: 'print the protocol payload instead of the human rendering' },
        ],
      }),
      verb('catalog publish', {
        summary: "freeze the item's source as its next version, after showing you all of it",
        args: [
          { name: 'catalog', help: 'the catalog id or name' },
          { name: 'item', help: 'the item id or name' },
        ],
        options: [
          { flag: '-y, --yes', help: 'skip the y/N question; required when not on a terminal' },
          { flag: '--json', help: 'print the protocol payload instead of the human rendering' },
        ],
      }),
      verb('catalog versions', {
        summary: 'list every version of an item in a catalog; the current one is marked',
        args: [
          { name: 'catalog', help: 'the catalog id or name' },
          { name: 'item', help: 'the item id or name' },
        ],
        options: [{ flag: '--json', help: 'print the protocol payload instead of the human rendering' }],
      }),
      verb('catalog withdraw', {
        summary: 'take an item out of the catalog; installers are told it is gone',
        args: [
          { name: 'catalog', help: 'the catalog id or name' },
          { name: 'item', help: 'the item id or name' },
        ],
        options: [
          { flag: '-y, --yes', help: 'skip the y/N question; required when not on a terminal' },
          { flag: '--json', help: 'print the protocol payload instead of the human rendering' },
        ],
      }),
      verb('catalog export', {
        summary: 'write the catalog as a signed file',
        args: [{ name: 'catalog', help: 'the catalog id or name' }],
        options: [
          {
            flag: '--item <item>',
            help: 'carry only this item in the file (repeat for more). The signed list still names every live item, and the ask above shows them',
          },
          { flag: '--out <file>', help: 'where to write it; <catalog-name>.catalog.json in this directory otherwise' },
          { flag: '--force', help: 'replace the file if it is already there' },
          {
            flag: '-y, --yes',
            help: 'sign without asking; the list of what is signed is still printed. Required when not on a terminal',
          },
          { flag: '--json', help: 'print the protocol payload instead of the human rendering' },
        ],
      }),
      verb('catalog share', {
        summary: 'make a link that lets a person read one or more catalogs; shown once',
        args: [{ name: 'catalog', help: 'the catalog ids or names to share', variadic: true }],
        options: [
          { flag: '--member <name>', help: 'a new person, named by you' },
          { flag: '--to <person>', help: 'a person who has already joined: id or name' },
          { flag: '--expires <time>', help: 'how long the link lives: 15m, 1h, 3h, 8h or 1d' },
          { flag: '--multi', help: 'let several browsers use the link (it makes its own person; needs --member)' },
          { flag: '--cap <count>', help: 'with --multi, the most browsers that may join (2 to 200)' },
          { flag: '-y, --yes', help: 'with --to, skip the y/N warning; required when not on a terminal' },
          { flag: '--large', help: 'draw the QR at full size, for a camera that will not focus on the compact one' },
          { flag: '--json', help: 'print the protocol payload instead of the human rendering' },
        ],
      }),
      verb('catalog shares', {
        summary: 'every share and how it stands; a code is never shown',
        args: [],
        options: [{ flag: '--json', help: 'print the protocol payload instead of the human rendering' }],
      }),
      verb('catalog unshare', {
        summary: 'end a share so its code stops working',
        args: [{ name: 'share', help: 'the share id' }],
        options: [{ flag: '--json', help: 'print the protocol payload instead of the human rendering' }],
      }),
      verb('member ls', {
        default: true,
        summary: 'everyone who has joined, with their catalogs and browsers',
        args: [],
        options: [{ flag: '--json', help: 'print the protocol payload instead of the human rendering' }],
      }),
      verb('member rename', {
        summary: "change a person's name",
        args: [
          { name: 'member', help: 'the person id or name' },
          { name: 'name', help: 'the new name' },
        ],
        options: [{ flag: '--json', help: 'print the protocol payload instead of the human rendering' }],
      }),
      verb('member revoke', {
        summary: 'remove a person: their browsers are signed out and their shares end',
        args: [{ name: 'member', help: 'the person id or name' }],
        options: [
          { flag: '-y, --yes', help: 'skip the y/N question; required when not on a terminal' },
          { flag: '--json', help: 'print the protocol payload instead of the human rendering' },
        ],
      }),
      verb('member forget-key', {
        summary: "remove one of a person's browsers; their others keep working",
        args: [
          { name: 'member', help: 'the person id or name' },
          { name: 'key', help: 'the browser id (mk_…) or the name it gave itself' },
        ],
        options: [
          { flag: '-y, --yes', help: 'skip the y/N question; required when not on a terminal' },
          { flag: '--json', help: 'print the protocol payload instead of the human rendering' },
        ],
      }),
      verb('member take', {
        summary: 'stop a person reading one catalog',
        args: [
          { name: 'member', help: 'the person id or name' },
          { name: 'catalog', help: 'the catalog id or name' },
        ],
        options: [
          { flag: '-y, --yes', help: 'skip the y/N question; required when not on a terminal' },
          { flag: '--json', help: 'print the protocol payload instead of the human rendering' },
        ],
      }),
    ],
  },

  ui: {
    // "+ Add skills" in a ferret's Skills tab: Skills offers the slot, Catalogs contributes the way in.
    panels: [panel(SKILLS_ADD_SLOT, { id: 'add-skills', order: 10 })],
    screens: [
      screen('sharing', { path: 'sharing/:tab?', nav: { label: 'Sharing', icon: 'share-2', order: 20 } }),
      // Reached from Skills' `skills.add` slot (the panel above); the ferret's place rides in the query.
      screen('add-skills', { path: 'ferrets/:ferret/add-skills' }),
      // Daemon-less on purpose: a share link lands here, and what is shared with this browser spans daemons.
      screen('join', { path: '/join', daemonless: true }),
      screen('shared', { path: '/shared', daemonless: true }),
    ],
  },

  /** Never reached by a ferret, through any root: link keys, member passkeys and member unlocks (`PrivacyDecl`). */
  privacy: {
    private: ['link-keys.json', 'member-passkeys.json', 'member-unlocks.json'],
  },
  data: {
    config: [CatalogsConfigFile],
    state: [
      defineState({ name: 'catalogs', path: 'catalogs.json', store: 'json', format: 1 }),
      /** Frozen item versions by digest: content-addressed, re-checked against the signed document on read. */
      defineState({
        name: 'blobs',
        path: 'blobs/*',
        store: 'opaque',
        format: 1,
        onDamaged: { narrower: 'that version is refused; the catalog lists it as missing' },
      }),
      defineState({ name: 'links', path: 'links.json', store: 'json', format: 1 }),
      CatalogLinkKeys.state,
      defineState({ name: 'members', path: 'members.json', store: 'json', format: 1 }),
      /** Shares keep a hash of their code, never the code. */
      defineState({ name: 'shares', path: 'shares.json', store: 'json', format: 1 }),
      defineState({ name: 'member-passkeys', path: 'member-passkeys.json', store: 'json', format: 1 }),
      defineState({ name: 'member-unlocks', path: 'member-unlocks.json', store: 'json', format: 1 }),
      defineState({ name: 'installs', path: 'installs.json', store: 'json', format: 1 }),
      CatalogInstallPrefs,
    ],
    readModels: ['installs'],
    publishes: [CatalogsChanged],
  },

  hooks: {
    offers: [{ hook: CatalogItems }],
    takes: [
      { hook: Credentials, key: 'member' },
      { hook: SessionModes, key: 'member' },
    ],
  },
});
