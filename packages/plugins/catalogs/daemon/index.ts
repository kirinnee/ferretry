import { ApiError, type RouteHandler, type MemberRouteHandler } from '@ferretry/kernel/contract';
import { implementDaemon, type DaemonHalf } from '@ferretry/kernel/manifest';
import { auditKind } from '@ferretry/core-gate/contract';
import { milliseconds } from '@ferretry/std';
import { createHash } from './adapters/share-code-hasher.ts';
import manifest from '../manifest.ts';
import { CatalogsChanged, CatalogInstallSummarySchema } from '../contract/index.ts';
import { CatalogLinkKeys, CatalogInstallPrefs } from '../contract/storage.ts';
import { CatalogsConfigFile, MEMBER_UNLOCK_DAYS } from '../contract/config.ts';
import {
  documentStore,
  blobStore,
  linkKeyVault,
  linksDamage,
  membersDamage,
  catalogsDamage,
  installsDamage,
} from './adapters/state.ts';
import { itemProviders } from './adapters/items.ts';
import { APP_ORIGIN, DIRECTORY_ORIGIN, connectionFacts, type CatalogKernel } from './adapters/host-facts.ts';
import { toBase64Url } from './lib/relay-wire/index.ts';
import { WebCryptoSessionCrypto } from './adapters/web-crypto.ts';
import { StatePasskeyStore } from './adapters/member-passkey-store.ts';
import { StateUnlockLedger } from './adapters/member-unlocks.ts';
import { memberVerifier } from './adapters/access.ts';
import { memberMode } from './adapters/member-mode.ts';
import { HttpLinkStoreClient } from './adapters/http-link-store-client.ts';
import { ConfiguredLinkStoreLocator } from './adapters/link-store-locator.ts';
import { SharedCatalogService } from './lib/shared-catalogs/service.ts';
import { CatalogsDocumentSchema, EMPTY_CATALOGS_DOCUMENT } from './lib/shared-catalogs/document.ts';
import { linkUsageOf } from './lib/catalog-links/usage.ts';
import { CatalogLinkService } from './lib/catalog-links/service.ts';
import { LinksDocumentSchema, EMPTY_LINKS_DOCUMENT } from './lib/catalog-links/document.ts';
import { CatalogMemberService } from './lib/catalog-members/service.ts';
import { MemberPasskeyService } from './lib/catalog-members/passkeys.ts';
import { MemberJoinGate } from './lib/catalog-members/join.ts';
import { MemberJoinProver } from './lib/catalog-members/join-proof.ts';
import { LiveMemberSessions } from './lib/catalog-members/sessions.ts';
import { shareLinkTarget } from './lib/catalog-members/link-target.ts';
import { memberFailure, sharedRoutes } from './lib/catalog-members/shared-routes.ts';
import {
  MembersDocumentSchema,
  SharesDocumentSchema,
  EMPTY_MEMBERS_DOCUMENT,
  EMPTY_SHARES_DOCUMENT,
} from './lib/catalog-members/document.ts';
import { ChallengeLedger } from './lib/member-passkeys/challenges.ts';
import { CatalogInstallService } from './lib/catalog-installs/service.ts';
import { CatalogInstallStateSchema, EMPTY_CATALOG_INSTALL_STATE } from './lib/catalog-installs/store.ts';
import { CatalogInstallPrefsStateSchema, EMPTY_CATALOG_INSTALL_PREFS } from './lib/catalog-installs/prefs.ts';
import { sharedCatalogRoutes } from './lib/routes/shared-catalogs.ts';
import { catalogMemberRoutes } from './lib/routes/catalog-members.ts';
import { catalogLinkRoutes } from './lib/routes/catalog-links.ts';
import { catalogInstallRoutes } from './lib/routes/catalog-installs.ts';
import type { AuditEntry } from './lib/audit.ts';
import type { DocumentDamage } from './adapters/state.ts';

/** Composition moved from today's daemon/bin/fyd.ts catalog block; all IO is through declared ports. */
export default implementDaemon(manifest, {
  build(ctx) {
    const kernel = ctx.kernel as CatalogKernel;
    const now = () => kernel.clock.nowMs();
    const crypto = new WebCryptoSessionCrypto();
    const facts = connectionFacts(ctx.uses.connections);
    const providers = itemProviders(ctx.hooks, ctx.uses.projects);
    const file = (name: string) => {
      const declared = manifest.data.state.find(state => state.name === name);
      if (declared === undefined) throw new TypeError(`Catalogs did not declare ${name}.`);
      return declared;
    };
    const changed = (change: 'catalog' | 'share' | 'member' | 'link' | 'install') =>
      kernel.events.publish(CatalogsChanged, { change });
    // read-scoped: none — declared typed state stores are composed here; no file or secret text is displayed.
    function store<T>(
      name: string,
      schema: import('zod').z.ZodType<T>,
      empty: T,
      change: 'catalog' | 'share' | 'member' | 'link' | 'install',
      damage: DocumentDamage,
    ) {
      const document = documentStore(kernel.state, file(name), schema, empty, damage);
      return {
        read: document.read,
        write: async (value: T) => {
          await document.write(value);
          changed(change);
        },
      };
    }
    const catalogDocuments = store(
      'catalogs',
      CatalogsDocumentSchema,
      EMPTY_CATALOGS_DOCUMENT,
      'catalog',
      catalogsDamage,
    );
    const linkDocuments = store('links', LinksDocumentSchema, EMPTY_LINKS_DOCUMENT, 'link', linksDamage);
    const identity = {
      identity: async () => ({ daemonId: kernel.identity.daemonId, signer: kernel.signer }),
      publisherName: () => kernel.identity.daemonName,
    };
    const audit = {
      record: async (entry: AuditEntry) => await ctx.needs.gate.audit({ ...entry, event: auditKind(entry.event) }),
    };
    const currentIdentity = () => kernel.identity;
    /** `catalogs.yaml` `memberUnlockDays` (1..90, default 30), read live; raising it loosens, so it is the owner's. */
    const unlockDays = () => kernel.config.file(CatalogsConfigFile)?.memberUnlockDays ?? MEMBER_UNLOCK_DAYS.default;
    const publisher = () => {
      const connection = ctx.uses.connections.current();
      if (connection === undefined || facts() === undefined)
        throw new ApiError(503, 'Connections cannot describe this machine.', 'signing_unavailable');
      return { ...currentIdentity(), carriers: connection.carriers(), memberUnlockDays: unlockDays() };
    };
    const live = new LiveMemberSessions();
    const members = new CatalogMemberService({
      members: store('members', MembersDocumentSchema, EMPTY_MEMBERS_DOCUMENT, 'member', membersDamage),
      shares: store('shares', SharesDocumentSchema, EMPTY_SHARES_DOCUMENT, 'share', membersDamage),
      hasher: { hex: text => createHash(text) },
      crypto,
      catalogs: { knownIds: async () => new Set((await catalogs.list()).catalogs.map(catalog => catalog.id)) },
      links: {
        target: () => {
          const connection = facts();
          return shareLinkTarget(
            connection?.advertisement,
            kernel.identity.daemonId,
            connection === undefined ? '' : APP_ORIGIN,
            connection?.discoveredRelayUrl,
          );
        },
      },
      sessions: {
        closeMember: async memberId => await live.closeMember(memberId),
        closeKey: async (memberId, keyId) => {
          await live.closeKey(memberId, keyId);
          await passkeys.forgetKey(keyId);
        },
      },
      audit,
      now,
    });
    const passkeyStore = new StatePasskeyStore(kernel.state, file('member-passkeys'));
    const verifier = memberVerifier(ctx.needs.access);
    const random = { bytes: (length: number) => crypto.randomBytes(length) };
    const clock = { nowMs: now };
    // TODO(Access contract): today's `passkeysChanged` signal ('member-key-forgotten', so Accounts' sign-in rules drop a
    // forgotten browser's passkeys) has no hook on Access's port yet; wire `passkeysChanged` here when it does.
    const passkeys = new MemberPasskeyService({
      store: passkeyStore,
      verifier,
      challenges: new ChallengeLedger(),
      random,
      clock,
      unlocks: new StateUnlockLedger(kernel.state, file('member-unlocks'), () => currentIdentity().daemonId),
      members,
      catalogNames: async () => new Map((await catalogs.list()).catalogs.map(catalog => [catalog.id, catalog.name])),
      allowedOrigins: () => facts()?.allowedOrigins ?? [],
      relyingPartyName: 'Ferretry',
      daemonName: () => currentIdentity().daemonName,
      unlockDays,
      audit,
    });
    const join = new MemberJoinGate({
      members,
      proof: new MemberJoinProver({
        passkeysOf: async memberId => await passkeys.passkeysOf(memberId),
        store: passkeyStore,
        verifier,
        random,
        clock,
        allowedOrigins: () => facts()?.allowedOrigins ?? [],
      }),
      publisher,
      audit,
      now,
      after: (run, ms) => {
        kernel.clock.after(milliseconds(ms), run);
      },
    });
    const member = memberMode({ members, passkeys, join, live });
    const catalogs = new SharedCatalogService({
      membership: members,
      linkUsage: linkUsageOf(linkDocuments),
      documents: catalogDocuments,
      blobs: blobStore(kernel.state, file('blobs')),
      skillTree: providers.tree,
      skills: providers.skills,
      mcp: providers.mcp,
      identity,
      crypto,
      now,
    });
    const client = new HttpLinkStoreClient(crypto, identity, {
      fetcher: async (input, init) => await kernel.fetch.request(input, init),
    });
    const links = new CatalogLinkService({
      documents: linkDocuments,
      vault: linkKeyVault(ctx.needs.sealed.open(kernel.state, CatalogLinkKeys)),
      locator: new ConfiguredLinkStoreLocator(
        () => kernel.config.file(CatalogsConfigFile)?.linkStore ?? { enabled: false },
        () => (facts() === undefined ? undefined : DIRECTORY_ORIGIN),
        client,
      ),
      client,
      items: catalogs,
      identity,
      crypto,
      now,
      appOrigin: APP_ORIGIN,
      random: () => {
        const bytes = crypto.randomBytes(4);
        return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0) / 0x1_0000_0000;
      },
      audit,
    });
    const installs = new CatalogInstallService({
      crypto,
      store: store(
        'installs',
        CatalogInstallStateSchema,
        EMPTY_CATALOG_INSTALL_STATE,
        'install',
        installsDamage('install', 'installs'),
      ),
      prefs: documentStore(
        kernel.state,
        CatalogInstallPrefs,
        CatalogInstallPrefsStateSchema,
        EMPTY_CATALOG_INSTALL_PREFS,
        installsDamage('preference', 'preferences'),
      ),
      projectRoots: providers.projectRoots,
      mcpFiles: providers.mcpFiles,
      skillFiles: providers.skillFiles,
      runtimeSkills: providers.assets,
      fleet: providers.runtime,
      secretNames: async () => new Set((await ctx.needs.vault.names()).map(secret => secret.name)),
      now,
      mint: prefix => `${prefix}_${toBase64Url(crypto.randomBytes(16))}`,
    });
    const main = [
      ...sharedCatalogRoutes({ catalogs }),
      ...catalogMemberRoutes({ members }),
      ...catalogLinkRoutes({ links }),
      ...catalogInstallRoutes(installs),
    ];
    const routes = Object.fromEntries(main.map(route => [`${route.method} ${route.path}`, route.handle])) as Record<
      string,
      RouteHandler
    >;
    const shared = sharedRoutes({
      members,
      passkeys,
      sessions: live,
      catalogs: {
        catalogs: async () =>
          (await catalogs.list()).catalogs.map(({ id, name, revision }) => ({ id, name, revision })),
        signedManifest: async id => await catalogs.signedManifest(id),
        versionsRevision: async (id, item) => await catalogs.versionsRevision(id, item),
        signedVersions: async (id, item) => await catalogs.signedVersions(id, item),
        frozenItem: async (id, item, version) => await catalogs.frozenItem(id, item, version),
      },
      publisher,
      audit,
      now,
    });
    const memberRoutes = Object.fromEntries(
      shared.map(route => [
        `${route.method} ${route.path}`,
        (async call => {
          try {
            const page = member.pages.get(call.session);
            const access = await members.access(call.principal.holder);
            if (page === undefined || access === undefined || page.keyId !== access.keyId)
              throw new ApiError(401, 'this browser is no longer registered here', 'unauthorized');
            if (route.needs === 'unlocked' && passkeys.unlockExpiresAt(access.keyId) === undefined)
              throw new ApiError(403, 'unlock with your passkey first', 'member_locked');
            return await route.handle({
              request: call.request,
              params: call.params,
              access,
              appSession: page.appSession,
              sessionId: call.session,
            });
          } catch (error) {
            // The member side's refusals answer as they always did: their own code and status, never a bare 500.
            throw memberFailure(error);
          }
        }) satisfies MemberRouteHandler,
      ]),
    ) as Record<string, MemberRouteHandler>;
    for (const route of manifest.actions.routes)
      if (routes[route.key] === undefined) throw new TypeError(`Catalogs has no handler for ${route.key}.`);
    for (const route of manifest.actions.memberRoutes)
      if (memberRoutes[route.key] === undefined)
        throw new TypeError(`Catalogs has no member handler for ${route.key}.`);
    kernel.jobs.add({
      id: 'catalogs-load-members',
      schedule: { onceAfterStart: true },
      run: async () => {
        await members.ready();
        const notice = await passkeys.restore();
        if (notice !== undefined) kernel.log.warn(notice);
      },
    });
    for (const [id, every, run] of [
      [
        'catalogs-sweep',
        60_000,
        async () => {
          await members.sweep();
        },
      ],
      [
        'catalogs-link-reconcile',
        60_000,
        async () => {
          await links.reconcile();
        },
      ],
      [
        'catalogs-link-refresh',
        6 * 60 * 60_000,
        async () => {
          await links.refresh();
        },
      ],
    ] as const) {
      kernel.jobs.add({ id: `${id}-boot`, schedule: { onceAfterStart: true }, run });
      kernel.jobs.add({ id, schedule: { every: milliseconds(every) }, run });
    }
    return {
      routes: routes as DaemonHalf<typeof manifest>['routes'],
      memberRoutes: memberRoutes as DaemonHalf<typeof manifest>['memberRoutes'],
      hooks: {
        'credentials:member': member.credentials,
        'session.modes:member': member.mode,
      },
      provides: {
        catalogs: {
          installs: async () =>
            (await installs.list()).installs.map(install =>
              CatalogInstallSummarySchema.parse({
                id: install.installId,
                catalog: install.provenance.catalogId,
                item: install.provenance.itemId,
                kind: install.provenance.kind,
                digest: install.provenance.digest,
              }),
            ),
        },
      },
    };
  },
});
