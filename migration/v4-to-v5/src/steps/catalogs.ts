/**
 * Catalogs and shares → `state/catalogs/` (`/plugin-catalogs`).
 *
 * | v4 (4.291.5)                                       | v5                                                       |
 * | -------------------------------------------------- | -------------------------------------------------------- |
 * | `state/catalogs/catalogs.json` (`schemaVersion` 3) | `state/catalogs/catalogs.json` `{format: 1, …}`          |
 * | `state/catalogs/blobs/<hex>.json`                  | `state/catalogs/blobs/<hex>.json`, byte for byte         |
 * | `state/catalogs/links.json`                        | `state/catalogs/links.json` `{format: 1, links}`         |
 * | `state/catalogs/link-keys.json` (SEALED)           | `state/catalogs/link-keys.json`, envelope `v` → `format` |
 * | `state/catalogs/members.json`, `shares.json`       | the same names, `{format: 1, …}`                         |
 * | `state/catalogs/member-passkeys.json`              | the same name, `{format: 1, passkeys}`                   |
 * | `state/catalog-installs.json`                      | `state/catalogs/installs.json` `{format: 1, …}`          |
 *
 * SIGNATURES. A catalog is signed by the publisher's daemon identity over RFC 8785 canonical JSON when it is exported
 * or served; nothing signed is stored in the home. The signed manifest is rebuilt from `catalogs.json`'s fields
 * (`publisherName`, `revision`, `issuedAt`, the entries and each binding's digest) and the frozen blobs, so the step
 * changes no value in that document (only `schemaVersion` → `format`; canonical JSON ignores key order) and copies
 * every blob as the same bytes. The identity step moves the daemon key unchanged, so v5 signs the same canonical bytes
 * with the same key; nothing is re-signed here. Each blob's name is re-checked as the SHA-256 of its bytes.
 *
 * PINS. `installs.json` keeps every install with its provenance (publisher, catalog, item, version, digest), every
 * publisher pin and the highest revision seen: nothing is updated, an install stays at the version it pinned.
 *
 * THE SEALED LINK KEYS are never opened, decrypted, printed or logged. v4 seals them with AES-256-GCM under the vault
 * key (`state/secrets.key`), AAD `catalog-link:<linkId>`, entries `{iv, ciphertext}` with no instants
 * (`file-link-key-vault.ts`). v5 keeps exactly that (Vault contract `sealed.ts`: "`'catalog-link:'` for the link
 * keys", unstamped; the Vault step moves the key unchanged to `state/vault/vault.key`), with the envelope's `"v": 1`
 * renamed `"format": 1`, which is outside the AAD. So the step re-labels the envelope with `rewrapSealed` and copies
 * each entry's two strings unchanged; the test opens the moved document with v5's own `KernelSealedDocuments`.
 *
 * The v5 Catalogs contract declares these files (`format: 1`) but not yet their bodies: its port "copies the schemas
 * with the code that answers them" from v4. So the bodies keep v4's field names and values, and the landing check
 * here is every id and digest that joins one file to another, through the contract's own id schemas. v4's
 * `state/local-skill-installs.json` is not carried (owner decision !A466: the local skill copy is gone). A runtime named by a former name
 * (`fleet/ids.json` `formerNames`) is named by its current one, as Settings names it (M7).
 */
import {
  CatalogDigestSchema,
  CatalogInstallIdSchema,
  CatalogInstallSummarySchema,
  CatalogItemKindSchema,
  CatalogLinkIdSchema,
  CatalogMemberIdSchema,
  CatalogMemberKeyIdSchema,
  CatalogShareIdSchema,
  LinkBundleIdSchema,
  SharedCatalogIdSchema,
  SharedCatalogItemIdSchema,
} from '@ferretry/plugin-catalogs/contract';
import { SealedDocumentSchema } from '@ferretry/core-vault/contract';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { KeptItem, NotCarried, StepReport } from '../report.ts';
import { rewrapSealed, SealedEnvelopeError } from '../rewrap.ts';
import { failureNote, isRecord, readV4Json, V4InputError } from '../v4/documents.ts';
import {
  isHeldLink,
  memberNameKey,
  V4_BLOB_NAME,
  V4_CATALOG_BACKUPS,
  V4_CATALOG_BLOBS,
  V4_CATALOG_INSTALL_PREFS,
  V4_CATALOG_INSTALLS,
  V4_CATALOG_LINK_KEYS,
  V4_CATALOG_LINKS,
  V4_CATALOG_MEMBER_PASSKEYS,
  V4_CATALOG_MEMBER_UNLOCKS,
  V4_CATALOG_MEMBERS,
  V4_CATALOG_SHARES,
  V4_CATALOGS,
  V4_CATALOGS_DIR,
  V4_VAULT_KEY,
  V4CatalogInstallPrefsDocument,
  V4CatalogInstallsDocument,
  V4CatalogsDocument,
  V4CatalogsDocumentV2,
  type V4InstallTarget,
  V4LinksDocument,
  V4MembersDocument,
  V4SharesDocument,
} from '../v4/catalogs.ts';
import { keyPath } from '../key-path.ts';
import { V4PasskeysSchema } from '../v4/access.ts';
import { runtimeIds } from '../v4/ferrets.ts';
import type { Step, StepContext } from './index.ts';

/** `packages/plugins/catalogs/manifest.ts` `data.state` (declared in the manifest, not the contract), under `state/catalogs/`. */
const V5_DIR = 'state/catalogs';
export const V5_CATALOGS = join(V5_DIR, 'catalogs.json');
export const V5_CATALOG_BLOBS = join(V5_DIR, 'blobs');
export const V5_CATALOG_LINKS = join(V5_DIR, 'links.json');
export const V5_CATALOG_LINK_KEYS = join(V5_DIR, 'link-keys.json');
export const V5_CATALOG_MEMBERS = join(V5_DIR, 'members.json');
export const V5_CATALOG_SHARES = join(V5_DIR, 'shares.json');
export const V5_CATALOG_MEMBER_PASSKEYS = join(V5_DIR, 'member-passkeys.json');
export const V5_CATALOG_INSTALLS = join(V5_DIR, 'installs.json');
/** The manifest's `format` for every Catalogs file. */
const FORMAT = 1;

// ─── the landing checks: v5's own ids for every join (the bodies are v4's, see the header) ───────────────────────

const Format = z.literal(FORMAT);

const CatalogsFile = z.looseObject({
  format: Format,
  defaultCatalogId: SharedCatalogIdSchema.optional(),
  items: z.array(
    z.looseObject({
      itemId: SharedCatalogItemIdSchema,
      kind: CatalogItemKindSchema,
      versions: z.array(
        z.looseObject({
          contentDigest: CatalogDigestSchema,
          bindings: z.record(SharedCatalogIdSchema, z.looseObject({ digest: CatalogDigestSchema })),
        }),
      ),
    }),
  ),
  catalogs: z.array(
    z.looseObject({
      id: SharedCatalogIdSchema,
      entries: z.array(z.looseObject({ itemId: SharedCatalogItemIdSchema })),
    }),
  ),
});

const LinksFile = z.looseObject({
  format: Format,
  links: z.array(
    z.looseObject({
      linkId: CatalogLinkIdSchema,
      itemId: SharedCatalogItemIdSchema,
      bundleId: LinkBundleIdSchema,
      keyRef: CatalogLinkIdSchema.optional(),
    }),
  ),
});

const catalogIds = z.array(SharedCatalogIdSchema);

const MembersFile = z.looseObject({
  format: Format,
  members: z.array(
    z.looseObject({
      memberId: CatalogMemberIdSchema,
      catalogIds,
      keys: z.array(z.looseObject({ keyId: CatalogMemberKeyIdSchema })),
    }),
  ),
});

const SharesFile = z.looseObject({
  format: Format,
  shares: z.array(
    z.looseObject({
      shareId: CatalogShareIdSchema,
      memberId: CatalogMemberIdSchema,
      catalogIds,
      usedBy: z.array(z.looseObject({ keyId: CatalogMemberKeyIdSchema })),
    }),
  ),
});

const MemberPasskeysFile = z.looseObject({
  format: Format,
  passkeys: z.array(z.looseObject({ deviceId: CatalogMemberKeyIdSchema })),
});

const InstallsFile = z.looseObject({
  format: Format,
  installs: z.array(z.looseObject({ installId: CatalogInstallIdSchema })),
  pins: z.record(SharedCatalogIdSchema, z.string().min(1)),
  revisions: z.record(SharedCatalogIdSchema, z.number().int().min(1)),
});

// ─── what is never carried ───────────────────────────────────────────────────────────────────────────────────────

const STATIC_NOT_CARRIED: readonly NotCarried[] = [
  { what: V4_CATALOG_BACKUPS.join(', '), why: 'v4 upgrade backups, kept once and never read' },
  {
    what: 'live member unlocks (state/catalogs/member-unlocks.json)',
    why: 'each member browser unlocks again once with its passkey (as Access does for paired devices); never read here',
  },
  {
    what: 'install hold and skip choices (state/catalog-install-prefs.json)',
    why: 'v5 Catalogs declares no file for them; they only changed what a reader said, never acted, and an install stays at its pin either way (a skipped version is offered again)',
  },
  {
    what: 'local skill copies (state/local-skill-installs.json)',
    why: 'v5 has no local skill copy (owner decision !A466); the file is not carried and never read',
  },
  {
    what: 'the link store’s copy of each public link',
    why: 'remote (the Cloudflare link-store Worker), not in the home; the daemon identity is carried, so the store still knows its owner',
  },
  {
    what: 'config/daemon.json catalogs (link store, member unlock days)',
    why: 'the Daemon settings step’s: v5 Catalogs declares no config',
  },
];

// ─── reading ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The first failing field's path (never a value: zod's messages can quote one). */
const where = (error: z.ZodError): string =>
  error.issues
    .slice(0, 3)
    .map(issue => keyPath(issue.path))
    .join(', ');

async function readDocument<Shape>(home: string, file: string, schema: z.ZodType<Shape>): Promise<Shape | undefined> {
  const value = await readV4Json(home, join(home, file));
  if (value === undefined) return undefined;
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new V4InputError(`${file}: is not the v4.291.5 document at: ${where(parsed.error)}`);
  return parsed.data;
}

/** A v4 body under the v5 envelope, checked by the landing schema; a failure names the file and field path. */
function landed<Shape, V4 extends { readonly schemaVersion: number }>(
  file: string,
  schema: z.ZodType<Shape>,
  v4: V4,
): Shape {
  const { schemaVersion: _version, ...body } = v4;
  const parsed = schema.safeParse({ format: FORMAT, ...body });
  if (!parsed.success) throw new V4InputError(`${file}: does not fit v5 Catalogs at: ${where(parsed.error)}`);
  return parsed.data;
}

type Resolve = (runtime: string) => string;

/** A runtime by its current name: v4 kept former names in `fleet/ids.json` (M7), v5 has none. */
async function runtimeResolver(ctx: StepContext): Promise<Resolve> {
  let ids: Awaited<ReturnType<typeof runtimeIds>>;
  try {
    ids = await runtimeIds(ctx.v4.fleet);
  } catch {
    throw new V4InputError('fleet/ids.json: is not a valid v4 runtime id document');
  }
  return name =>
    ids?.runtimes[name] !== undefined
      ? name
      : (Object.entries(ids?.runtimes ?? {}).find(([, entry]) => entry.formerNames.includes(name))?.[0] ?? name);
}

/** Catalogs' own target vocabulary is still v4's (`CatalogHarnessSchema`: `claude`); only a former runtime name moves. */
const catalogTarget = (target: V4InstallTarget, resolve: Resolve): V4InstallTarget =>
  target.scope === 'runtime' ? { ...target, runtime: resolve(target.runtime) } : target;

interface Plan {
  readonly writes: (() => Promise<void>)[];
  readonly kept: KeptItem[];
  readonly notes: string[];
  readonly notCarried: NotCarried[];
  readonly sealed: { file: string; bytes: number }[];
}

const keep = (plan: Plan, what: string, count: number): void => {
  plan.kept.push({ what, count });
};

// ─── catalogs.json and the frozen versions ───────────────────────────────────────────────────────────────────────

async function planCatalogs(ctx: StepContext, plan: Plan): Promise<void> {
  const home = ctx.v4.home;
  const raw = await readV4Json(home, join(home, V4_CATALOGS));
  /** Every version's content digest (hex): the frozen file each one should have. */
  const digests = new Set<string>();
  if (raw !== undefined) {
    const version = isRecord(raw) ? raw.schemaVersion : undefined;
    if (version === 1)
      throw new V4InputError(
        `${V4_CATALOGS}: is still schema version 1; start v4.291.5 once so it upgrades the file, then convert again`,
      );
    const schema = version === 2 ? V4CatalogsDocumentV2 : V4CatalogsDocument;
    const parsed = schema.safeParse(raw);
    if (!parsed.success)
      throw new V4InputError(`${V4_CATALOGS}: is not the v4.291.5 document at: ${where(parsed.error)}`);
    // v4's `upgradeCatalogsV2`: "Version 2 to 3 changes no data, only the number".
    if (version === 2)
      plan.notes.push(`${V4_CATALOGS} was schema version 2 (the same shape as 3; upgraded as v4 does)`);
    const v5 = landed(V4_CATALOGS, CatalogsFile, parsed.data);
    for (const item of parsed.data.items)
      for (const version of item.versions) digests.add(version.contentDigest.replace(/^sha256:/u, ''));
    plan.writes.push(() => ctx.v5.json({ path: V5_CATALOGS, format: FORMAT, schema: CatalogsFile }, v5));
    keep(plan, 'catalogs', v5.catalogs.length);
    keep(plan, 'catalog items', v5.items.length);
    keep(
      plan,
      'item versions',
      v5.items.reduce((sum, item) => sum + item.versions.length, 0),
    );
  }

  const blobs = join(home, V4_CATALOG_BLOBS);
  const folder = await lstat(blobs).catch(() => undefined);
  const present = new Set<string>();
  if (folder !== undefined) {
    if (!folder.isDirectory()) throw new V4InputError(`${V4_CATALOG_BLOBS}: is not a folder`);
    let mismatched = 0;
    for (const name of (await readdir(blobs)).sort()) {
      const label = `${V4_CATALOG_BLOBS}/${name}`;
      const hex = V4_BLOB_NAME.exec(name)?.[1];
      const facts = await lstat(join(blobs, name));
      if (hex === undefined || !facts.isFile()) {
        plan.notCarried.push({
          what: label,
          why: 'not a frozen version v4 writes (a <sha256>.json file); never followed',
        });
        continue;
      }
      // A frozen item version (a skill or MCP setup someone published), not a secret: read to check its name.
      const bytes = new Uint8Array(await readFile(join(blobs, name)));
      if (new Bun.CryptoHasher('sha256').update(bytes).digest('hex') !== hex) mismatched += 1;
      present.add(hex);
      plan.writes.push(() => ctx.v5.opaque(join(V5_CATALOG_BLOBS, name), bytes));
    }
    keep(plan, 'frozen item versions (byte for byte)', present.size);
    if (mismatched > 0)
      plan.notes.push(
        `${String(mismatched)} frozen version(s) do not hash to their name: copied as they are; v5 refuses them on read, as v4 did`,
      );
  }
  const missing = [...digests].filter(hex => !present.has(hex)).length;
  if (missing > 0)
    plan.notes.push(`${String(missing)} item version(s) have no frozen file in v4 either; v5 lists them as missing`);
}

// ─── links.json and the sealed link keys ─────────────────────────────────────────────────────────────────────────

async function planLinks(ctx: StepContext, plan: Plan): Promise<void> {
  const home = ctx.v4.home;
  const v4 = await readDocument(home, V4_CATALOG_LINKS, V4LinksDocument);
  const keyFile = join(home, V4_CATALOG_LINK_KEYS);
  const sealedFacts = await lstat(keyFile).catch(() => undefined);
  let names: readonly string[] = [];
  if (sealedFacts !== undefined) {
    const vaultKey = await lstat(join(home, V4_VAULT_KEY)).catch(() => undefined);
    // Envelope and entry names only: the strings are copied, never decoded. `write: false` checks without writing.
    const checked = await rewrapSealed(keyFile, ctx.v5.resolve(V5_CATALOG_LINK_KEYS), {
      stamped: false,
      schema: SealedDocumentSchema,
      write: false,
    });
    names = checked.names;
    if (names.length > 0 && vaultKey === undefined)
      throw new V4InputError(`${V4_CATALOG_LINK_KEYS} exists but the vault key ${V4_VAULT_KEY} that seals it does not`);
    if (names.some(name => !CatalogLinkIdSchema.safeParse(name).success))
      throw new V4InputError(`${V4_CATALOG_LINK_KEYS}: an entry is not named by a link id`);
    plan.writes.push(async () => {
      const moved = await rewrapSealed(keyFile, ctx.v5.resolve(V5_CATALOG_LINK_KEYS), {
        stamped: false,
        schema: SealedDocumentSchema,
      });
      plan.sealed.push({ file: V5_CATALOG_LINK_KEYS, bytes: (await lstat(moved.to)).size });
    });
    if (ctx.dryRun) plan.sealed.push({ file: V5_CATALOG_LINK_KEYS, bytes: sealedFacts.size });
    keep(plan, 'link keys (sealed, moved unopened)', names.length);
  }
  if (v4 === undefined) {
    if (names.length > 0) plan.notes.push(`${String(names.length)} link key(s) belong to no link (v4 kept them too)`);
    return;
  }
  const v5 = landed(V4_CATALOG_LINKS, LinksFile, v4);
  plan.writes.push(() => ctx.v5.json({ path: V5_CATALOG_LINKS, format: FORMAT, schema: LinksFile }, v5));
  keep(plan, 'links', v5.links.length);
  const held = new Set(names);
  const keyless = v4.links.filter(link => link.kind === 'public' && isHeldLink(link) && !held.has(link.linkId));
  if (keyless.length > 0)
    plan.notes.push(
      `${String(keyless.length)} public link(s) have no stored key in v4 either, so Copy link cannot show them again`,
    );
  const named = new Set(v4.links.map(link => link.keyRef).filter(ref => ref !== undefined));
  const orphans = names.filter(name => !named.has(name)).length;
  if (orphans > 0) plan.notes.push(`${String(orphans)} link key(s) belong to no link (v4 kept them too)`);
}

// ─── members, shares, member passkeys ────────────────────────────────────────────────────────────────────────────

async function planMembers(ctx: StepContext, plan: Plan): Promise<void> {
  const home = ctx.v4.home;
  const members = await readDocument(home, V4_CATALOG_MEMBERS, V4MembersDocument);
  if (members !== undefined) {
    // v4 renamed duplicate names once, on read (`LegacyMembersDocumentSchema`); a file still holding two is that file.
    const seen = new Map<string, string>();
    for (const member of members.members) {
      const key = memberNameKey(member.label);
      const other = seen.get(key);
      if (other !== undefined)
        throw new V4InputError(
          `${V4_CATALOG_MEMBERS}: members ${other} and ${member.memberId} share one name; start v4.291.5 once so it renames them, then convert again`,
        );
      seen.set(key, member.memberId);
    }
    const v5 = landed(V4_CATALOG_MEMBERS, MembersFile, members);
    plan.writes.push(() => ctx.v5.json({ path: V5_CATALOG_MEMBERS, format: FORMAT, schema: MembersFile }, v5));
    keep(plan, 'members', v5.members.length);
    keep(
      plan,
      'member browsers',
      v5.members.reduce((sum, member) => sum + member.keys.length, 0),
    );
  }
  const shares = await readDocument(home, V4_CATALOG_SHARES, V4SharesDocument);
  if (shares !== undefined) {
    const v5 = landed(V4_CATALOG_SHARES, SharesFile, shares);
    plan.writes.push(() => ctx.v5.json({ path: V5_CATALOG_SHARES, format: FORMAT, schema: SharesFile }, v5));
    keep(plan, 'shares (code hashes only)', v5.shares.length);
  }
  const passkeys = await readDocument(home, V4_CATALOG_MEMBER_PASSKEYS, V4PasskeysSchema);
  if (passkeys !== undefined) {
    const v5 = landed(V4_CATALOG_MEMBER_PASSKEYS, MemberPasskeysFile, passkeys);
    plan.writes.push(() =>
      ctx.v5.json({ path: V5_CATALOG_MEMBER_PASSKEYS, format: FORMAT, schema: MemberPasskeysFile }, v5),
    );
    keep(plan, 'member passkeys', v5.passkeys.length);
  }
}

// ─── installs ────────────────────────────────────────────────────────────────────────────────────────────────────

async function planInstalls(ctx: StepContext, plan: Plan, resolve: () => Promise<Resolve>): Promise<void> {
  const home = ctx.v4.home;
  const installs = await readDocument(home, V4_CATALOG_INSTALLS, V4CatalogInstallsDocument);
  if (installs !== undefined) {
    const named = installs.installs.some(install => install.target.scope === 'runtime') ? await resolve() : undefined;
    const v5 = landed(V4_CATALOG_INSTALLS, InstallsFile, {
      ...installs,
      installs: installs.installs.map(install =>
        named === undefined ? install : { ...install, target: catalogTarget(install.target, named) },
      ),
    });
    // Every install must still read as the port's summary: what and which version, pinned by digest.
    for (const install of installs.installs) {
      const summary = CatalogInstallSummarySchema.safeParse({
        id: install.installId,
        catalog: install.provenance.catalogId,
        item: install.provenance.itemId,
        kind: install.provenance.kind,
        digest: install.provenance.digest,
      });
      if (!summary.success)
        throw new V4InputError(
          `${V4_CATALOG_INSTALLS}: install ${install.installId} does not fit v5's install summary at: ${where(summary.error)}`,
        );
    }
    plan.writes.push(() => ctx.v5.json({ path: V5_CATALOG_INSTALLS, format: FORMAT, schema: InstallsFile }, v5));
    keep(plan, 'catalog installs (each at its pinned version)', v5.installs.length);
    keep(plan, 'catalog publisher pins', Object.keys(v5.pins).length);
  }

  const prefs = await readV4Json(home, join(home, V4_CATALOG_INSTALL_PREFS));
  if (prefs !== undefined) {
    const parsed = V4CatalogInstallPrefsDocument.safeParse(prefs);
    plan.notes.push(
      parsed.success
        ? `${String(Object.keys(parsed.data.installs).length)} install hold/skip choice(s) not carried`
        : `${V4_CATALOG_INSTALL_PREFS} is damaged (v4 refused it too); not carried`,
    );
  }
}

/** Anything in `state/catalogs/` that 4.291.5 does not write is named, never read. */
async function planLeftovers(ctx: StepContext, plan: Plan): Promise<void> {
  const folder = join(ctx.v4.home, V4_CATALOGS_DIR);
  const facts = await lstat(folder).catch(() => undefined);
  if (facts === undefined) return;
  if (!facts.isDirectory()) throw new V4InputError(`${V4_CATALOGS_DIR}: is not a folder`);
  const known = new Set<string>([
    ...[V4_CATALOGS, V4_CATALOG_BLOBS, V4_CATALOG_LINKS, V4_CATALOG_LINK_KEYS, V4_CATALOG_MEMBERS].map(fileName),
    ...[V4_CATALOG_SHARES, V4_CATALOG_MEMBER_PASSKEYS, V4_CATALOG_MEMBER_UNLOCKS].map(fileName),
    ...V4_CATALOG_BACKUPS,
  ]);
  for (const name of (await readdir(folder)).sort())
    if (!known.has(name))
      plan.notCarried.push({ what: `${V4_CATALOGS_DIR}/${name}`, why: 'not a file v4.291.5 writes; never read' });
}

const fileName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

export const catalogsStep: Step = {
  id: 'catalogs',
  title: 'Catalogs and shares (published catalogs, links, members, installs)',
  owner: ['plugin-catalogs', 'plugin-skills'],
  reads: [`${V4_CATALOGS_DIR}/**`, V4_CATALOG_INSTALLS, V4_CATALOG_INSTALL_PREFS],
  sealed: [V4_CATALOG_LINK_KEYS],
  notCarried: STATIC_NOT_CARRIED,
  async run(ctx): Promise<StepReport> {
    const plan: Plan = { writes: [], kept: [], notes: [], notCarried: [...STATIC_NOT_CARRIED], sealed: [] };
    const base = () => ({ id: this.id, title: this.title, notCarried: plan.notCarried, sealed: plan.sealed });
    try {
      let resolver: Resolve | undefined;
      const resolve = async () => (resolver ??= await runtimeResolver(ctx));
      // Every input is read and checked before anything is written: a refused input writes nothing of this step.
      await planCatalogs(ctx, plan);
      await planLinks(ctx, plan);
      await planMembers(ctx, plan);
      await planInstalls(ctx, plan, resolve);
      await planLeftovers(ctx, plan);
      if (!ctx.dryRun) for (const write of plan.writes) await write();
      else plan.notes.push('dry run: nothing written');
      const notes =
        plan.kept.length === 0 ? ['this home has no catalogs, shares or installs', ...plan.notes] : plan.notes;
      return {
        ...base(),
        status: 'converted',
        ...(notes.length > 0 ? { note: notes.join('; ') } : {}),
        kept: plan.kept,
      };
    } catch (error) {
      // The sealed check names the file (and at most an entry NAME), never content; shown relative to the v4 home.
      const note =
        error instanceof SealedEnvelopeError
          ? error.message.replaceAll(`${ctx.v4.home}/`, '')
          : failureNote(error, 'cannot convert the catalogs, shares and installs');
      return { ...base(), status: 'failed', note, kept: [] };
    }
  },
};
