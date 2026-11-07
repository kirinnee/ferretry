/**
 * Access: paired devices, passkeys, the grant journal and push → `state/access/` (`@ferretry/plugin-access/contract`
 * `state.ts`). Device and passkey records hold PUBLIC keys only, but no record is ever logged: the report gives counts,
 * and an error names a file, a record index or a key path, never a value.
 *
 * - Devices: v4 `devices.json` `{schemaVersion: 2, daemonId, devices}` → `devices.json` `{format: 1, daemonId,
 *   devices}` (`DevicesFileSchema`), every record field for field (v5 kept v4's record: id, daemonId, name, platform,
 *   instants, `pairedOver`, public key, `keyRotatedAt`). `daemonId` stays: the identity itself is carried (spine D17),
 *   so the fingerprint it names is the same. A `schemaVersion: 1` (bearer) document is not converted: v4 itself made
 *   those devices pair again.
 * - Grants: v5 names a fixed capability set (`CAPABILITY_NAMES`). Each axis is v4's EFFECTIVE value (`configure` only
 *   where `use` is on, v4's rule); a capability v5 has and v4 did not name is OFF on both axes, as v4 read it
 *   (`ReadCapabilityGrantsSchema`); one v4 had and v5 dropped is not carried. Never wider than v4.
 * - Passkeys: `passkeys.json` `{schemaVersion: 1, passkeys}` → `{format: 1, passkeys}`, credential id, algorithm, public
 *   key, sign counter, origin and instant unchanged (`PasskeysFileSchema`). A passkey of a device that is not carried
 *   goes with its device (v4-formats §6: dropping a device drops its passkeys).
 * - Unlocks: NOT carried. `unlocks.json` holds only live unlocks (device id + instant), so each device unlocks again
 *   once. The unlock SETTINGS (unlock on open, validity hours) are v4 `security.json`, which v5 keeps in `gate.yaml`
 *   `security` (the Daemon settings step).
 * - Grant journal: v4 `grant-audit.jsonl` and `security-audit.jsonl` → ONE `grant-audit.jsonl`, the file v5 Access
 *   declares and writes both journals into (`kind` keeps them apart, `daemon/runtime.ts`). Each line is v4's
 *   `{kind, at, actor, changes}` with `format: 1` first, parsed by `GrantAuditLineSchema`, oldest first. A line v4
 *   could not read is skipped and counted, as v4 counted it; a line v5 refuses is counted too.
 * - Push keys: v4 `push-vapid.json` `{schemaVersion: 1, privateKeyJwk}` → `push-keys.json` (`store: 'secret'`), which
 *   v5 reads as bytes and parses as `{format: 1, privateKeyJwk}` (`daemon/adapters/push/webcrypto-vapid-keys.ts`), so
 *   a byte-for-byte move would read as damaged. Lead decision (2026-11-07, option a): ONLY the envelope changes. The
 *   document is read once into memory, must be exactly `{schemaVersion: 1, privateKeyJwk: {…}}` or the step fails
 *   naming the file; the JWK object is written back unchanged (same members, same order) as
 *   `{format: 1, privateKeyJwk}`, the way v5's own writer encodes it, in one atomic 0600 write. No log, report field
 *   or error ever holds a JWK member; the report counts the key.
 * - Push subscriptions: `push.json` `{schemaVersion: 1, subscriptions}` → `{format: 1, subscriptions}`
 *   (`PushFileSchema`), v4's legacy `prefs` dropped as v4 dropped it on rewrite. Every subscription was made against
 *   that VAPID key, so `push.json` is written only in the run that writes the key, after both were checked: a key
 *   that fails writes neither. A subscription of a device that is not carried goes with it.
 */
import { CAPABILITY_NAMES } from '@ferretry/core-gate/contract';
import {
  DevicesFile,
  DevicesFileSchema,
  GrantAuditFile,
  type GrantAuditLine,
  GrantAuditLineSchema,
  PasskeysFile,
  PasskeysFileSchema,
  PushFile,
  PushFileSchema,
  PushKeysFile,
  PushKeysFileSchema,
} from '@ferretry/plugin-access/contract';
import { join } from 'node:path';
import type { z } from 'zod';
import type { KeptItem, NotCarried, StepReport } from '../report.ts';
import {
  V4_DEVICES,
  V4_GRANT_JOURNAL,
  V4_PASSKEYS,
  V4_PUSH,
  V4_PUSH_VAPID,
  V4_SECURITY_JOURNAL,
  V4_UNLOCKS,
  V4DevicesSchema,
  type V4Grant,
  V4JournalLine,
  V4PasskeysSchema,
  V4PushSchema,
} from '../v4/access.ts';
import { failureNote, isRecord, readV4Json, readV4Lines, V4InputError } from '../v4/documents.ts';
import { jsonLine } from '../v4/gate.ts';
import type { Step, StepContext } from './index.ts';

const V5_DIR = 'state/access';
export const V5_DEVICES_FILE = join(V5_DIR, DevicesFile.path);
export const V5_PASSKEYS_FILE = join(V5_DIR, PasskeysFile.path);
export const V5_GRANT_AUDIT_FILE = join(V5_DIR, GrantAuditFile.path);
export const V5_PUSH_FILE = join(V5_DIR, PushFile.path);
export const V5_PUSH_KEYS_FILE = join(V5_DIR, PushKeysFile.path);

const OFF = { use: false, configure: false } as const;

const ACCESS_NOT_CARRIED: readonly NotCarried[] = [
  { what: 'pairing codes', why: 'single-use and two minutes long; none survives a stop' },
  {
    what: 'live unlocks (state/unlocks.json)',
    why: 'each device unlocks again once with its passkey; the unlock settings are gate.yaml security (Daemon settings step)',
  },
  {
    what: 'a grant or security journal line v4 could not read',
    why: 'v4 counted it as unreadable and never showed it; skipped and counted, never quoted',
  },
];

/** The key paths of a zod failure: field names and indexes, never a value. */
const where = (error: z.ZodError): string => error.issues.map(issue => issue.path.join('.') || '(top)').join(', ');

interface Part {
  readonly kept: KeptItem[];
  readonly notCarried: NotCarried[];
  readonly notes: string[];
}

/** The carried devices' ids, so passkeys (and push rows) of a device that is not carried go with it. */
async function convertDevices(ctx: StepContext, part: Part): Promise<ReadonlySet<string>> {
  const decoded = await readV4Json(ctx.v4.home, join(ctx.v4.state, 'devices.json'));
  if (decoded === undefined) {
    part.notes.push('no paired devices');
    return new Set();
  }
  if ((decoded as { schemaVersion?: unknown } | null)?.schemaVersion === 1) {
    part.notCarried.push({ what: 'bearer-era devices', why: 'v4 already made them pair again' });
    return new Set();
  }
  const parsed = V4DevicesSchema.safeParse(decoded);
  if (!parsed.success) throw new V4InputError(`${V4_DEVICES}: does not match v4's shape at: ${where(parsed.error)}`);

  const dropped = new Set<string>();
  const v5Names = new Set<string>(CAPABILITY_NAMES);
  const devices = parsed.data.devices.map(device => {
    for (const name of Object.keys(device.grants)) if (!v5Names.has(name)) dropped.add(name);
    const effective = (grant: V4Grant | undefined) =>
      grant === undefined ? OFF : { use: grant.use, configure: grant.use && grant.configure };
    return {
      id: device.id,
      daemonId: device.daemonId,
      name: device.name,
      platform: device.platform,
      createdAt: device.createdAt,
      lastSeenAt: device.lastSeenAt,
      ...(device.pairedOver === undefined ? {} : { pairedOver: device.pairedOver }),
      publicKey: device.publicKey,
      grants: Object.fromEntries(CAPABILITY_NAMES.map(name => [name, effective(device.grants[name])])),
      ...(device.keyRotatedAt === undefined ? {} : { keyRotatedAt: device.keyRotatedAt }),
    };
  });
  const checked = DevicesFileSchema.safeParse({ format: 1, daemonId: parsed.data.daemonId, devices });
  if (!checked.success) throw new V4InputError(`${V4_DEVICES}: a device does not fit v5 at: ${where(checked.error)}`);
  await ctx.v5.json({ path: V5_DEVICES_FILE, format: 1, schema: DevicesFileSchema }, checked.data);
  part.kept.push({ what: 'paired devices', count: devices.length });
  if (dropped.size > 0)
    part.notCarried.push({ what: `grants for ${[...dropped].sort().join(', ')}`, why: 'v5 has no such capability' });
  return new Set(checked.data.devices.map(device => device.id));
}

async function convertPasskeys(ctx: StepContext, part: Part, devices: ReadonlySet<string>): Promise<void> {
  const decoded = await readV4Json(ctx.v4.home, join(ctx.v4.state, 'passkeys.json'));
  if (decoded === undefined) return;
  const parsed = V4PasskeysSchema.safeParse(decoded);
  if (!parsed.success) throw new V4InputError(`${V4_PASSKEYS}: does not match v4's shape at: ${where(parsed.error)}`);
  const passkeys = parsed.data.passkeys.filter(passkey => devices.has(passkey.deviceId));
  const orphaned = parsed.data.passkeys.length - passkeys.length;
  const checked = PasskeysFileSchema.safeParse({ format: 1, passkeys });
  if (!checked.success) throw new V4InputError(`${V4_PASSKEYS}: a passkey does not fit v5 at: ${where(checked.error)}`);
  await ctx.v5.json({ path: V5_PASSKEYS_FILE, format: 1, schema: PasskeysFileSchema }, checked.data);
  part.kept.push({ what: 'passkeys', count: passkeys.length });
  if (orphaned > 0)
    part.notCarried.push({
      what: `${String(orphaned)} passkey(s) of a device that is not carried`,
      why: 'a passkey goes with its device; that device pairs again',
    });
}

async function convertJournals(ctx: StepContext, part: Part): Promise<void> {
  const lines: { line: GrantAuditLine; order: number }[] = [];
  let present = false;
  let unreadable = 0;
  let refused = 0;
  for (const file of [V4_GRANT_JOURNAL, V4_SECURITY_JOURNAL]) {
    const found = await readV4Lines(ctx.v4.home, file);
    if (found === undefined) continue;
    present = true;
    for (const text of found) {
      const entry = V4JournalLine.safeParse(jsonLine(text));
      if (!entry.success) {
        unreadable++;
        continue;
      }
      const { kind, at, actor, changes } = entry.data;
      const line = GrantAuditLineSchema.safeParse({ format: 1, kind, at, actor, changes });
      if (line.success) lines.push({ line: line.data, order: lines.length });
      else refused++;
    }
  }
  if (!present) return;
  // Oldest first, as an append-only journal reads; equal instants keep the order they were met in.
  lines.sort((a, b) => Date.parse(a.line.at) - Date.parse(b.line.at) || a.order - b.order);
  await ctx.v5.jsonl(
    { path: V5_GRANT_AUDIT_FILE, format: GrantAuditFile.format, schema: GrantAuditLineSchema },
    lines.map(entry => entry.line),
  );
  part.kept.push({ what: 'grant and security journal lines', count: lines.length });
  if (unreadable > 0) part.notes.push(`${String(unreadable)} unreadable journal line(s) skipped, as v4 skipped them`);
  if (refused > 0) part.notes.push(`${String(refused)} journal line(s) v5 refuses skipped`);
}

/**
 * The bytes of v5's `push-keys.json` for v4's VAPID document, held in memory only. Every failure names the file and
 * never a member: a zod issue path would be harmless, but nothing about the key is worth a sentence.
 */
function v5PushKeys(decoded: unknown): string {
  const envelope = new V4InputError(`${V4_PUSH_VAPID}: is not v4's {schemaVersion: 1, privateKeyJwk} document`);
  if (!isRecord(decoded)) throw envelope;
  const names = Object.keys(decoded).sort();
  if (names.join() !== 'privateKeyJwk,schemaVersion' || decoded.schemaVersion !== 1 || !isRecord(decoded.privateKeyJwk))
    throw envelope;
  // v5's writer: `JSON.stringify({ format: 1, privateKeyJwk: jwk })`, no newline. The JWK object goes in as it is.
  const bytes = JSON.stringify({ format: PushKeysFile.format, privateKeyJwk: decoded.privateKeyJwk });
  // Read back exactly as v5's reader does; only the verdict leaves this block.
  let readable = false;
  try {
    readable = PushKeysFileSchema.safeParse(JSON.parse(bytes)).success;
  } catch {
    readable = false;
  }
  if (!readable) throw new V4InputError(`${V4_PUSH_VAPID}: the key is not one v5 can read`);
  return bytes;
}

async function convertPush(ctx: StepContext, part: Part, devices: ReadonlySet<string>): Promise<void> {
  const keyDocument = await readV4Json(ctx.v4.home, join(ctx.v4.state, 'push-vapid.json'));
  const pushDocument = await readV4Json(ctx.v4.home, join(ctx.v4.state, 'push.json'));
  // Both are checked before either is written: a key that fails leaves neither file.
  const keyBytes = keyDocument === undefined ? undefined : v5PushKeys(keyDocument);
  let subscriptions: unknown[] | undefined;
  let total = 0;
  let orphaned = 0;
  if (pushDocument !== undefined) {
    const parsed = V4PushSchema.safeParse(pushDocument);
    if (!parsed.success) throw new V4InputError(`${V4_PUSH}: does not match v4's shape at: ${where(parsed.error)}`);
    const rows = parsed.data.subscriptions.filter(row => devices.has(row.deviceId));
    total = parsed.data.subscriptions.length;
    orphaned = total - rows.length;
    subscriptions = rows.map(({ prefs: _legacyPrefs, ...row }) => row);
  }
  if (keyBytes === undefined) {
    if (total > 0)
      part.notCarried.push({
        what: `${String(total)} push subscription(s) with no VAPID key`,
        why: `${V4_PUSH_VAPID} is absent, so no subscription can be signed for; each phone enrols again`,
      });
    return;
  }
  const checked = subscriptions === undefined ? undefined : PushFileSchema.safeParse({ format: 1, subscriptions });
  if (checked !== undefined && !checked.success)
    throw new V4InputError(`${V4_PUSH}: a subscription does not fit v5 at: ${where(checked.error)}`);
  await ctx.v5.opaque(V5_PUSH_KEYS_FILE, keyBytes);
  part.kept.push({ what: 'push signing key (envelope only, never shown)', count: 1 });
  if (checked === undefined) return;
  await ctx.v5.json({ path: V5_PUSH_FILE, format: 1, schema: PushFileSchema }, checked.data);
  part.kept.push({ what: 'push subscriptions', count: checked.data.subscriptions.length });
  if (orphaned > 0)
    part.notCarried.push({
      what: `${String(orphaned)} push subscription(s) of a device that is not carried`,
      why: 'a subscription goes with its device',
    });
}

export const accessStep: Step = {
  id: 'access',
  title: 'Paired devices and passkeys (public keys, grants, grant journal, push)',
  owner: ['plugin-access'],
  reads: [V4_DEVICES, V4_PASSKEYS, V4_UNLOCKS, V4_PUSH, V4_PUSH_VAPID, V4_GRANT_JOURNAL, V4_SECURITY_JOURNAL],
  // The VAPID key is opened (its envelope changes), so it is not a sealed move; it is never shown.
  sealed: [],
  notCarried: ACCESS_NOT_CARRIED,
  async run(ctx: StepContext): Promise<StepReport> {
    const base = { id: this.id, title: this.title, sealed: [] };
    const part: Part = {
      kept: [],
      notCarried: [...ACCESS_NOT_CARRIED],
      notes: ctx.dryRun ? ['dry run: nothing written'] : [],
    };
    try {
      const devices = await convertDevices(ctx, part);
      await convertPasskeys(ctx, part, devices);
      await convertJournals(ctx, part);
      await convertPush(ctx, part, devices);
    } catch (error) {
      return {
        ...base,
        status: 'failed',
        note: failureNote(error, 'cannot convert the paired devices, passkeys, grant journal or push'),
        kept: [],
        notCarried: part.notCarried,
      };
    }
    return {
      ...base,
      status: 'converted',
      ...(part.notes.length > 0 ? { note: part.notes.join('; ') } : {}),
      kept: part.kept,
      notCarried: part.notCarried,
    };
  },
};
