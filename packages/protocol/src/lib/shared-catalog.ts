/**
 * Catalogs: the signed lists of skills and MCP setups one machine shares with people who are not its
 * devices (docs/catalogs.md). This file is the wire: the frozen item, the manifest that lists items,
 * the signature over it, and the catalog FILE a publisher exports and an installer reads.
 *
 * "Catalog" already names four other things in this codebase (`catalog.ts`, the fleet catalogue, model
 * catalogs, the catalog subsystem), so everything here is `SharedCatalog*`.
 *
 * ## Everything is signed by the publisher's daemon identity
 *
 * The key whose fingerprint IS the daemon id signs the manifest, and the manifest lists every item
 * version by the SHA-256 of its canonical JSON. So a copy is checkable wherever it came from — a file
 * someone sent, the app's offline copy, a live read — and the subscriber's OWN daemon checks it itself
 * rather than trusting the browser or the file that carried it. The signing and checking live beside the
 * identity code (`@ferretry/relay`, `catalog-signature.ts`); this file holds the bytes they agree on.
 *
 * ## No schema here transforms
 *
 * A signature covers the canonical JSON of the PARSED document, so a schema that trimmed, defaulted or
 * coerced a field would make the parsed document differ from the one that was signed — and the two ends
 * would hash different things. Every schema below only accepts or refuses: a string with spaces at its
 * ends is refused, never trimmed. `tests/unit/shared-catalog.test.ts` proves a parse returns its input.
 *
 * ## No secret value, no code, no key
 *
 * An MCP setup names a secret only as a WHOLE environment value, `${secret:NAME}`, which the installer
 * maps to one of their own secrets, explicitly, every time. Nothing else may carry `${`: not an
 * argument, not the command, not the address, and not part of a value — so a setup cannot quietly expand
 * the installer's environment into its own program. A value that looks like a raw key is refused by the
 * same rule the MCP forms use ({@link mcpServerRefusal}). An OAuth client secret never travels, not even
 * as a placeholder: the installer signs in themselves.
 */
import { z } from 'zod';
import { canonicalJson } from './canonical-json.ts';
import { isCanonicalAssetPath } from './fleet-clone-review.ts';
import { InstantSchema } from './common.ts';
import { DaemonIdSchema } from './pairing.ts';
import { SECRET_REFERENCE_SOURCE } from './secrets.ts';
import { mcpServerRefusal, SessionMcpEnvNameSchema, SessionMcpNameSchema } from './session-mcp.ts';

// ── Formats and bounds ───────────────────────────────────────────────────────────────────────────

export const SHARED_CATALOG_MANIFEST_FORMAT = 'ferretry-catalog-manifest' as const;
export const SHARED_CATALOG_ITEM_FORMAT = 'ferretry-catalog-item' as const;
export const SHARED_CATALOG_FILE_FORMAT = 'ferretry-catalog-file' as const;

/**
 * The domain label a manifest signature covers. It is new, so a manifest signature can never be replayed
 * as a handshake signature, a rendezvous claim or a secret-import offer — all of which the same identity
 * key also signs, each under its own label.
 */
export const CATALOG_MANIFEST_SIGNATURE_LABEL = 'ferretry-catalog-manifest-v1' as const;

/** Clone's bounds where Clone has one (docs/cross-daemon.md §3a). */
export const CATALOG_SKILL_FILE_MAX_BYTES = 256 * 1024;
export const CATALOG_SKILL_MAX_BYTES = 2 * 1024 * 1024;
export const CATALOG_SKILL_MAX_FILES = 200;
export const CATALOG_SKILL_PATH_MAX_LENGTH = 512;
export const CATALOG_SKILL_PATH_MAX_DEPTH = 16;
export const CATALOG_MAX_ITEMS = 200;
/** A withdrawn item stays listed so an installer can say so; this bounds how many a manifest carries. */
export const CATALOG_MAX_WITHDRAWN = 1_000;
export const CATALOG_MCP_MAX_ARGS = 64;
export const CATALOG_MCP_MAX_ENV = 64;
/** An artifact snapshot's bound (owner decision Q6): the item carries the reference, never the bytes. */
export const CATALOG_ARTIFACT_MAX_BYTES = 10 * 1024 * 1024;
/**
 * A catalog file larger than this is refused before it is parsed. Generous for a hand-sent file of
 * skills and setups; a whole 200-item catalog of 2 MiB skills does not fit, and is exported in parts.
 */
export const SHARED_CATALOG_FILE_MAX_BYTES = 32 * 1024 * 1024;

/** The one file every skill must carry at its root. */
export const CATALOG_SKILL_ENTRY_FILE = 'SKILL.md';

const utf8Length = (text: string): number => new TextEncoder().encode(text).length;

// ── Words a person reads ─────────────────────────────────────────────────────────────────────────

/**
 * Characters that change how text LOOKS without being seen: C0 and C1 controls, and the bidirectional
 * overrides and isolates. A catalog's name is the publisher's own text and is shown beside the
 * installer's own label for that publisher; an override could make "Anthropic" out of other letters, or
 * hide the end of a name. Refused in every label, and in a description everything but a line break.
 */
// Written as escapes in a string, so the source never holds an invisible character itself.
const DIRECTION_MARKS = String.raw`\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069`;
const INVISIBLE_IN_LABEL = new RegExp(String.raw`[\u0000-\u001F\u007F-\u009F${DIRECTION_MARKS}]`, 'u');
const INVISIBLE_IN_TEXT = new RegExp(String.raw`[\u0000-\u0009\u000B-\u001F\u007F-\u009F${DIRECTION_MARKS}]`, 'u');

const words = (max: number, invisible: RegExp) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine(text => text.trim() === text, 'no spaces at the start or the end')
    .refine(text => !invisible.test(text), 'no control or text-direction characters');

/** A catalog's or a publisher's name, as its publisher wrote it. */
export const CatalogLabelSchema = words(80, INVISIBLE_IN_LABEL);
/** One line about an item. */
export const CatalogSummarySchema = words(280, INVISIBLE_IN_LABEL);
/** A catalog's description: may hold line breaks. Empty is allowed. */
export const CatalogDescriptionSchema = z.union([z.literal(''), words(2_000, INVISIBLE_IN_TEXT)]);

// ── Identifiers ──────────────────────────────────────────────────────────────────────────────────

/** `cat_` and 22 base64url characters: 128 random bits, never a counter or a name. */
export const SharedCatalogIdSchema = z.string().regex(/^cat_[A-Za-z0-9_-]{22}$/u, 'invalid catalog id');
export type SharedCatalogId = z.infer<typeof SharedCatalogIdSchema>;

/** `itm_` and 22 base64url characters. Stable across an item's versions. */
export const SharedCatalogItemIdSchema = z.string().regex(/^itm_[A-Za-z0-9_-]{22}$/u, 'invalid catalog item id');
export type SharedCatalogItemId = z.infer<typeof SharedCatalogItemIdSchema>;

/** `sha256:` and 64 lower-case hex digits: SHA-256 of an item's canonical JSON. */
export const CatalogDigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/u, 'expected sha256:<64 hex digits>');
export type CatalogDigest = z.infer<typeof CatalogDigestSchema>;

/**
 * An item's name: the folder a skill installs as, or the name an MCP server is registered under. One
 * plain path segment by construction — a letter or digit first, so never `.` or `..`.
 */
export const CatalogItemNameSchema = SessionMcpNameSchema;
export type CatalogItemName = z.infer<typeof CatalogItemNameSchema>;

export const CATALOG_ITEM_KINDS = ['skill', 'mcp', 'artifact'] as const;
export const CatalogItemKindSchema = z.enum(CATALOG_ITEM_KINDS);
export type CatalogItemKind = z.infer<typeof CatalogItemKindSchema>;

/** Which harness an item is written for; `generic` works with both. */
export const CatalogHarnessSchema = z.enum(['claude', 'codex', 'generic']);
export type CatalogHarness = z.infer<typeof CatalogHarnessSchema>;

/** Unpadded base64url of exactly `bytes` bytes. */
const base64UrlOf = (bytes: number) => {
  const length = Math.ceil((bytes * 4) / 3);
  return z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${length}}$`, 'u'), `expected ${bytes} bytes as base64url`);
};

/** An Ed25519 SubjectPublicKeyInfo, DER: 44 bytes. */
export const CatalogSpkiSchema = base64UrlOf(44);
/** An Ed25519 signature: 64 bytes. */
export const CatalogSignatureSchema = base64UrlOf(64);

// ── Items ────────────────────────────────────────────────────────────────────────────────────────

/** One file of a skill, relative to the skill's own folder, carried as text. */
export const CatalogSkillFileSchema = z.strictObject({
  path: z
    .string()
    .max(CATALOG_SKILL_PATH_MAX_LENGTH)
    .refine(isCanonicalAssetPath, 'a plain relative path inside the skill: no leading /, ~ or $, no . or .., no \\')
    .refine(path => !INVISIBLE_IN_LABEL.test(path), 'no control or text-direction characters in a path')
    .refine(path => path.split('/').length <= CATALOG_SKILL_PATH_MAX_DEPTH, 'nested too deep'),
  content: z.string().refine(content => utf8Length(content) <= CATALOG_SKILL_FILE_MAX_BYTES, 'larger than 256 KiB'),
});
export type CatalogSkillFile = z.infer<typeof CatalogSkillFileSchema>;

/** How two paths could land on ONE file: a case-insensitive or normalising file system (macOS). */
const collisionKey = (path: string): string => path.normalize('NFC').toLowerCase();

/**
 * A skill: a folder with `SKILL.md` at its root and up to 200 text files. Every path is written one way,
 * no two land on the same file on any file system the installer might have, and no path is both a file
 * and a folder — so what the review lists is exactly what the installer writes.
 */
export const CatalogSkillSchema = z
  .strictObject({
    files: z.array(CatalogSkillFileSchema).min(1).max(CATALOG_SKILL_MAX_FILES),
  })
  .check(ctx => {
    const { files } = ctx.value;
    const issue = (message: string) => ctx.issues.push({ code: 'custom', message, input: files, path: ['files'] });
    if (!files.some(file => file.path === CATALOG_SKILL_ENTRY_FILE))
      issue(`a skill carries ${CATALOG_SKILL_ENTRY_FILE} at its root`);
    const seen = new Map<string, string>();
    for (const file of files) {
      const key = collisionKey(file.path);
      const earlier = seen.get(key);
      if (earlier !== undefined) {
        issue(
          earlier === file.path
            ? `${file.path} is carried twice`
            : `${earlier} and ${file.path} would be one file on a Mac, so neither is carried`,
        );
        return;
      }
      seen.set(key, file.path);
    }
    for (const key of seen.keys()) {
      const segments = key.split('/');
      for (let depth = 1; depth < segments.length; depth += 1) {
        const folder = segments.slice(0, depth).join('/');
        if (seen.has(folder)) {
          issue(`${seen.get(folder)} is both a file and a folder`);
          return;
        }
      }
    }
    const total = files.reduce((sum, file) => sum + utf8Length(file.content), 0);
    if (total > CATALOG_SKILL_MAX_BYTES) issue('a skill is at most 2 MiB in total');
  });
export type CatalogSkill = z.infer<typeof CatalogSkillSchema>;

/** A whole environment value that names a secret, and nothing else. */
const WHOLE_SECRET_PLACEHOLDER = new RegExp(`^${SECRET_REFERENCE_SOURCE}$`, 'u');

/** Whether `value` reaches for a substitution of any kind: `${secret:…}`, `${VAR}`, `${VAR:-x}`. */
const substitutes = (value: string): boolean => value.includes('${');

const HTTP_URL = /^https?:\/\/[^\s/?#@]+(?:[/?#][^\s]*)?$/u;

// biome-ignore lint/suspicious/noTemplateCurlyInString: the reference grammar, written out for a person to read
const NO_SUBSTITUTION = 'a secret travels only as a whole environment value, ${secret:NAME}; nothing else may hold ${';

/** A program the installer's runtimes start, with its arguments and environment. */
const CatalogMcpCommandSchema = z.strictObject({
  transport: z.literal('command'),
  command: z
    .string()
    .min(1)
    .max(1_024)
    .refine(text => !substitutes(text), NO_SUBSTITUTION),
  args: z
    .array(
      z
        .string()
        .max(4_096)
        .refine(text => !substitutes(text), NO_SUBSTITUTION),
    )
    .max(CATALOG_MCP_MAX_ARGS),
  /** Each value is a literal with no `${` in it, or exactly `${secret:NAME}` — a placeholder the installer fills. */
  env: z
    .record(
      SessionMcpEnvNameSchema,
      z
        .string()
        .max(4_096)
        .refine(value => !substitutes(value) || WHOLE_SECRET_PLACEHOLDER.test(value), NO_SUBSTITUTION),
    )
    .refine(env => Object.keys(env).length <= CATALOG_MCP_MAX_ENV, `at most ${CATALOG_MCP_MAX_ENV} variables`),
  harness: CatalogHarnessSchema.optional(),
});

/** A server the installer's runtimes reach at an address. */
const CatalogMcpUrlSchema = z.strictObject({
  transport: z.literal('url'),
  // A plain pattern rather than `z.url()`, which accepts `javascript:` and `data:`. No user name or
  // password in the address: that is a credential in plain text.
  url: z
    .string()
    .max(2_048)
    .regex(HTTP_URL, 'an http:// or https:// address, with no user name or password in it')
    .refine(text => !substitutes(text), NO_SUBSTITUTION),
  /** The installer signs in to it from their own machine (docs/mcp-oauth.md). A token never travels. */
  auth: z.literal('oauth').optional(),
  /** A client registered by hand with the provider. Its client SECRET has no field: it never travels. */
  oauth: z
    .strictObject({
      clientId: z.string().min(1).max(512),
      callbackPort: z.number().int().min(1024).max(65_535).optional(),
    })
    .optional(),
  harness: CatalogHarnessSchema.optional(),
});

/**
 * One MCP server definition, as McpComponentSchema's fields, minus everything that would carry a
 * credential. Refused when it looks like it holds a raw key, by the rule the MCP forms run.
 */
export const CatalogMcpSetupSchema = z
  .discriminatedUnion('transport', [CatalogMcpCommandSchema, CatalogMcpUrlSchema])
  .check(ctx => {
    const setup = ctx.value;
    if (setup.transport === 'url') {
      if (setup.oauth !== undefined && setup.auth !== 'oauth')
        ctx.issues.push({ code: 'custom', message: '"oauth" needs "auth": "oauth"', input: setup, path: ['oauth'] });
      if (setup.auth === 'oauth' && !setup.url.startsWith('https://'))
        ctx.issues.push({
          code: 'custom',
          message: 'a server signed in to is reached over https://',
          input: setup,
          path: ['url'],
        });
      return;
    }
    const refusal = mcpServerRefusal('login', setup);
    if (refusal !== null) ctx.issues.push({ code: 'custom', message: refusal, input: setup, path: [] });
  });
export type CatalogMcpSetup = z.infer<typeof CatalogMcpSetupSchema>;

/** An artifact: a reference to its encrypted snapshot in the hosted store (phase 6), never the bytes. */
export const CatalogArtifactSchema = z.strictObject({
  objectId: z.string().regex(/^[0-9a-f]{32}$/u, 'a 128-bit object id in hex'),
  mediaType: z.string().regex(/^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/u, 'a media type'),
  size: z.number().int().min(0).max(CATALOG_ARTIFACT_MAX_BYTES),
});
export type CatalogArtifact = z.infer<typeof CatalogArtifactSchema>;

const ItemHeadShape = {
  format: z.literal(SHARED_CATALOG_ITEM_FORMAT),
  version: z.literal(1),
  publisher: DaemonIdSchema,
  catalogId: SharedCatalogIdSchema,
  itemId: SharedCatalogItemIdSchema,
  /** 1, 2, 3…: each version is frozen when it is published and never rewritten. */
  itemVersion: z.number().int().min(1),
  name: CatalogItemNameSchema,
  summary: CatalogSummarySchema,
};

/**
 * One item version, frozen. Its digest — SHA-256 of its canonical JSON — is what the signed manifest
 * lists, so an item is checked by hashing it, wherever it came from.
 */
export const SharedCatalogItemSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...ItemHeadShape, kind: z.literal('skill'), skill: CatalogSkillSchema }),
  z.strictObject({ ...ItemHeadShape, kind: z.literal('mcp'), mcp: CatalogMcpSetupSchema }),
  z.strictObject({ ...ItemHeadShape, kind: z.literal('artifact'), artifact: CatalogArtifactSchema }),
]);
export type SharedCatalogItem = z.infer<typeof SharedCatalogItemSchema>;

// ── Manifests ────────────────────────────────────────────────────────────────────────────────────

/** One line of a manifest: an item version, by its digest. */
export const SharedCatalogManifestEntrySchema = z.strictObject({
  itemId: SharedCatalogItemIdSchema,
  kind: CatalogItemKindSchema,
  name: CatalogItemNameSchema,
  summary: CatalogSummarySchema,
  version: z.number().int().min(1),
  digest: CatalogDigestSchema,
  /** Bytes of the item's canonical JSON, so a reader can refuse an oversized item before fetching it. */
  size: z.number().int().min(1),
  publishedAt: InstantSchema,
  harness: CatalogHarnessSchema.optional(),
});
export type SharedCatalogManifestEntry = z.infer<typeof SharedCatalogManifestEntrySchema>;

export const CatalogVisibilitySchema = z.enum(['members', 'public']);
export type CatalogVisibility = z.infer<typeof CatalogVisibilitySchema>;

/**
 * Everything one catalog holds at one revision. The revision only goes up, so a reader that has seen
 * revision 7 refuses a signed revision 6 handed to it later.
 */
export const SharedCatalogManifestSchema = z
  .strictObject({
    format: z.literal(SHARED_CATALOG_MANIFEST_FORMAT),
    version: z.literal(1),
    publisher: DaemonIdSchema,
    /** The name the publisher gives itself. A reader shows its OWN label for the publisher beside it. */
    publisherName: CatalogLabelSchema,
    catalogId: SharedCatalogIdSchema,
    name: CatalogLabelSchema,
    description: CatalogDescriptionSchema,
    visibility: CatalogVisibilitySchema,
    revision: z.number().int().min(1),
    issuedAt: InstantSchema,
    items: z.array(SharedCatalogManifestEntrySchema).max(CATALOG_MAX_ITEMS),
    /** Items taken out. Installs of them keep working; an installer says they were withdrawn. */
    withdrawn: z
      .array(z.strictObject({ itemId: SharedCatalogItemIdSchema, at: InstantSchema }))
      .max(CATALOG_MAX_WITHDRAWN),
  })
  .check(ctx => {
    const { items, withdrawn } = ctx.value;
    const issue = (message: string, path: string) =>
      ctx.issues.push({ code: 'custom', message, input: ctx.value, path: [path] });
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const item of items) {
      if (ids.has(item.itemId)) issue(`${item.itemId} is listed twice`, 'items');
      ids.add(item.itemId);
      // Two items of one kind and one name would install over each other.
      const named = `${item.kind}/${item.name}`;
      if (names.has(named)) issue(`two ${item.kind} items are called ${item.name}`, 'items');
      names.add(named);
    }
    const gone = new Set<string>();
    for (const entry of withdrawn) {
      if (ids.has(entry.itemId)) issue(`${entry.itemId} is both listed and withdrawn`, 'withdrawn');
      if (gone.has(entry.itemId)) issue(`${entry.itemId} is withdrawn twice`, 'withdrawn');
      gone.add(entry.itemId);
    }
  });
export type SharedCatalogManifest = z.infer<typeof SharedCatalogManifestSchema>;

/** A manifest with the publisher's public key and its signature (`catalog-signature.ts` in `@ferretry/relay`). */
export const SignedCatalogManifestSchema = z.strictObject({
  manifest: SharedCatalogManifestSchema,
  /** The publisher's Ed25519 identity, SubjectPublicKeyInfo DER. Must hash to `manifest.publisher`. */
  spki: CatalogSpkiSchema,
  /** Ed25519 over {@link catalogManifestSignedBytes}. */
  sig: CatalogSignatureSchema,
});
export type SignedCatalogManifest = z.infer<typeof SignedCatalogManifestSchema>;

// ── The catalog file (phase 1: install from a file, no people yet) ─────────────────────────────────

/**
 * A catalog exported to a file: the signed manifest and the item versions it lists. Any subset of the
 * listed items may be carried; an item carried must be the version its manifest line names, by the same
 * publisher and catalog. Its digest is checked with the signature, by `verifySharedCatalogFile`.
 */
export const SharedCatalogFileSchema = z
  .strictObject({
    format: z.literal(SHARED_CATALOG_FILE_FORMAT),
    version: z.literal(1),
    exportedAt: InstantSchema,
    signedManifest: SignedCatalogManifestSchema,
    items: z.array(SharedCatalogItemSchema).max(CATALOG_MAX_ITEMS),
  })
  .check(ctx => {
    const { manifest } = ctx.value.signedManifest;
    const listed = new Map(manifest.items.map(entry => [entry.itemId, entry]));
    const carried = new Set<string>();
    for (const [index, item] of ctx.value.items.entries()) {
      const entry = listed.get(item.itemId);
      const problem = carried.has(item.itemId)
        ? 'is carried twice'
        : item.publisher !== manifest.publisher || item.catalogId !== manifest.catalogId
          ? 'belongs to another catalog'
          : entry === undefined
            ? 'is not listed in the signed manifest'
            : entry.version !== item.itemVersion || entry.kind !== item.kind || entry.name !== item.name
              ? 'is not the version the signed manifest lists'
              : undefined;
      carried.add(item.itemId);
      if (problem !== undefined)
        ctx.issues.push({
          code: 'custom',
          message: `item ${item.name} ${problem}`,
          input: item,
          path: ['items', index],
        });
    }
  });
export type SharedCatalogFile = z.infer<typeof SharedCatalogFileSchema>;

export type SharedCatalogFileReading =
  | { readonly ok: true; readonly file: SharedCatalogFile }
  | { readonly ok: false; readonly reason: string };

/**
 * A catalog file's text, read: bounded BEFORE it is parsed, then parsed through the schema. This says
 * nothing about who made it — the signature and digests are checked by `verifySharedCatalogFile`.
 */
export function readSharedCatalogFile(text: string): SharedCatalogFileReading {
  if (utf8Length(text) > SHARED_CATALOG_FILE_MAX_BYTES)
    return { ok: false, reason: 'This catalog file is larger than 32 MiB, so it was not read.' };
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'This is not a catalog file: it is not JSON.' };
  }
  if (
    typeof document !== 'object' ||
    document === null ||
    (document as { format?: unknown }).format !== SHARED_CATALOG_FILE_FORMAT
  )
    return { ok: false, reason: 'This is not a catalog file.' };
  const parsed = SharedCatalogFileSchema.safeParse(document);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first === undefined || first.path.length === 0 ? '' : ` (at ${first.path.join('.')})`;
    return {
      ok: false,
      reason: `This catalog file cannot be installed from: ${first?.message ?? 'it is malformed'}${where}.`,
    };
  }
  return { ok: true, file: parsed.data };
}

// ── The bytes a signature and a digest cover ─────────────────────────────────────────────────────

/** The canonical text a digest or a signature is computed over, or why the document has none. */
export const catalogCanonicalText = canonicalJson;

/**
 * What a manifest signature signs: the label, one zero byte, and the 32-byte SHA-256 of the manifest's
 * canonical JSON. The zero byte ends the label, so no label can be another's prefix.
 */
export function catalogManifestSignedBytes(manifestSha256: Uint8Array): Uint8Array {
  const label = new TextEncoder().encode(CATALOG_MANIFEST_SIGNATURE_LABEL);
  const bytes = new Uint8Array(label.length + 1 + manifestSha256.length);
  bytes.set(label, 0);
  bytes[label.length] = 0;
  bytes.set(manifestSha256, label.length + 1);
  return bytes;
}

/** `sha256:<hex>` for a 32-byte digest. */
export function catalogDigestOf(sha256: Uint8Array): CatalogDigest {
  return `sha256:${Array.from(sha256, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

/** Every distinct secret an MCP setup asks the installer to fill, in variable-name order. */
export function catalogSecretPlaceholders(item: SharedCatalogItem): readonly string[] {
  if (item.kind !== 'mcp' || item.mcp.transport !== 'command') return [];
  const names: string[] = [];
  for (const key of Object.keys(item.mcp.env).toSorted()) {
    const match = WHOLE_SECRET_PLACEHOLDER.exec(item.mcp.env[key] ?? '');
    const name = match?.[1];
    if (name !== undefined && !names.includes(name)) names.push(name);
  }
  return names;
}
