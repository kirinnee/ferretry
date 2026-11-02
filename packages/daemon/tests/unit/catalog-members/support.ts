import { createHash } from 'node:crypto';
import type { CatalogShareMintRequest } from '@ferretry/protocol';
import type { AuditEntry } from '../../../src/lib/audit/types.ts';
import type {
  Admitted,
  DigestComparison,
  JoinAdmission,
  JoinReservation,
  Probe,
  RedeemAdmission,
  RedeemReservation,
  Refused,
} from '../../../src/lib/catalog-members/admission.ts';
import {
  EMPTY_MEMBERS_DOCUMENT,
  EMPTY_SHARES_DOCUMENT,
  type MembersDocument,
  type SharesDocument,
  type StoredMember,
  type StoredMemberKey,
  type StoredShare,
} from '../../../src/lib/catalog-members/document.ts';
import type {
  CatalogDirectory,
  MemberAuditSink,
  MembersUpgrade,
  MemberSessionCloser,
  ShareCodeHasher,
  ShareLinkSource,
  ShareLinkTarget,
} from '../../../src/lib/catalog-members/ports.ts';
import type { MemberRename } from '../../../src/lib/catalog-members/names.ts';
import { CatalogMemberRefusal } from '../../../src/lib/catalog-members/refusal.ts';
import { CatalogMemberService, type NewMemberKey } from '../../../src/lib/catalog-members/service.ts';

export const T0 = Date.parse('2026-03-01T12:00:00.000Z');
export const MINUTE = 60 * 1_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
export const iso = (ms: number): string => new Date(ms).toISOString();

const pad = (n: number): string => String(n).padStart(22, 'A');
export const memberId = (n: number): string => `mbr_${pad(n)}`;
export const keyId = (n: number): string => `mk_${pad(n)}`;
export const shareId = (n: number): string => `shr_${pad(n)}`;
export const catalogId = (n: number): string => `cat_${pad(n)}`;
export const codeOf = (n: number): string => `fy_share_${pad(n)}`;
export const digestOf = (text: string): string => createHash('sha256').update(text).digest('hex');
export const DUMMY_DIGEST = '0'.repeat(64);

export const DAEMON_ID = `fy_daemon_${'A'.repeat(43)}`;
export const APP_ORIGIN = 'https://app.ferretry.test';
export const DAEMON_URL = 'https://daemon.example.test:7077';
const READY_LINK: ShareLinkTarget = {
  kind: 'ready',
  appOrigin: APP_ORIGIN,
  daemonUrl: DAEMON_URL,
  daemonId: DAEMON_ID,
};

/** An Ed25519 SPKI as base64url: the fixed prefix and 32 bytes that differ per `n`. */
function memberKeyText(n: number): string {
  const bytes = new Uint8Array(44);
  bytes.set([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]);
  bytes[12] = (n >> 8) & 255;
  bytes[13] = n & 255;
  bytes.fill(9, 14);
  return Buffer.from(bytes).toString('base64url');
}

/** An X25519 key as base64url: 32 bytes that are never all zero. */
function boxKeyText(n: number): string {
  const bytes = new Uint8Array(32).fill(3);
  bytes[0] = (n >> 8) & 255;
  bytes[1] = n & 255;
  bytes[31] = 1;
  return Buffer.from(bytes).toString('base64url');
}

export const storedKey = (n: number, overrides: Partial<StoredMemberKey> = {}): StoredMemberKey => ({
  keyId: keyId(n),
  memberKey: memberKeyText(n),
  boxKey: boxKeyText(n),
  clientName: `Browser ${String(n)}`,
  joinedAt: iso(T0),
  passkeyCount: 1,
  ...overrides,
});

export const keysOf = (from: number, count: number): StoredMemberKey[] =>
  Array.from({ length: count }, (_, index) => storedKey(from + index));

export const storedMember = (n: number, overrides: Partial<StoredMember> = {}): StoredMember => ({
  memberId: memberId(n),
  label: `Member ${String(n)}`,
  catalogIds: [],
  createdAt: iso(T0),
  keys: [],
  ...overrides,
});

export const storedShare = (n: number, overrides: Partial<StoredShare> = {}): StoredShare => ({
  shareId: shareId(n),
  codeSha256: digestOf(codeOf(n)),
  memberId: memberId(n),
  memberLabel: `Member ${String(n)}`,
  memberKind: 'new',
  catalogIds: [catalogId(1)],
  createdAt: iso(T0),
  expiresAt: iso(T0 + HOUR),
  uses: { kind: 'single' },
  used: 0,
  state: 'live',
  usedBy: [],
  successes: [],
  ...overrides,
});

export const membersDoc = (...members: StoredMember[]): MembersDocument => ({ ...EMPTY_MEMBERS_DOCUMENT, members });
export const sharesDoc = (...shares: StoredShare[]): SharesDocument => ({ ...EMPTY_SHARES_DOCUMENT, shares });

export const catalogIds = (from: number, count: number): string[] =>
  Array.from({ length: count }, (_, index) => catalogId(from + index));

export const joinReservation = (n: number, memberN: number): JoinReservation => ({
  kind: 'join',
  reservationId: `rsv-${String(n)}`,
  shareId: shareId(n),
  memberId: memberId(memberN),
  memberLabel: `Member ${String(memberN)}`,
  catalogIds: [],
});

/** A probe with the plain equality compare; every field can be overridden. */
export function probeOf(
  parts: {
    members?: MembersDocument;
    shares?: SharesDocument;
    pending?: readonly JoinReservation[];
    now?: number;
    code?: string;
    compare?: DigestComparison;
  } = {},
): Probe {
  return {
    members: parts.members ?? membersDoc(),
    shares: parts.shares ?? sharesDoc(),
    pending: parts.pending ?? [],
    now: parts.now ?? T0,
    digest: digestOf(parts.code ?? codeOf(1)),
    compare: parts.compare ?? ((left, right) => left === right),
    reservationId: 'rsv-new',
  };
}

export function refusedOf(result: Admitted<JoinReservation | RedeemReservation> | Refused): Refused {
  if (result.ok) throw new Error('expected a refusal');
  return result;
}

export function joinOf(result: JoinAdmission): JoinReservation {
  if (!result.ok) throw new Error(`expected a reservation, was refused: ${result.reason}`);
  return result.reservation;
}

export function redeemOf(result: RedeemAdmission): RedeemReservation {
  if (!result.ok) throw new Error(`expected a reservation, was refused: ${result.reason}`);
  return result.reservation;
}

export const shareOf = (document: SharesDocument, n: number): StoredShare => {
  const found = document.shares.find(share => share.shareId === shareId(n));
  if (found === undefined) throw new Error(`no share ${String(n)}`);
  return found;
};

export const memberOf = (document: MembersDocument, n: number): StoredMember => {
  const found = document.members.find(member => member.memberId === memberId(n));
  if (found === undefined) throw new Error(`no member ${String(n)}`);
  return found;
};

/** A document store in memory. `failing` makes a write throw; `hold` parks a write until released. */
class MemoryStore<D> {
  reads = 0;
  writes = 0;
  failing = false;
  unreadable: Error | undefined;
  /** The upgrade the next `read` is said to have found due (members only). */
  upgrade: MembersUpgrade | undefined;
  /** Every document that reached the disk, serialised, so a test can search them. */
  readonly history: string[] = [];
  #gate: Promise<void> | undefined;

  constructor(
    public document: D,
    private readonly name: string,
    private readonly log: string[],
  ) {}

  async read(): Promise<D> {
    this.reads += 1;
    if (this.unreadable !== undefined) throw this.unreadable;
    return this.document;
  }

  takeUpgrade(): MembersUpgrade | undefined {
    const upgrade = this.upgrade;
    this.upgrade = undefined;
    return upgrade;
  }

  async write(document: D): Promise<void> {
    this.writes += 1;
    this.log.push(`${this.name}.write`);
    if (this.#gate !== undefined) await this.#gate;
    if (this.failing) throw new Error(`${this.name} disk full`);
    this.document = document;
    this.history.push(JSON.stringify(document));
  }

  hold(): () => void {
    let release: () => void = () => undefined;
    this.#gate = new Promise<void>(resolve => {
      release = resolve;
    });
    return () => {
      this.#gate = undefined;
      release();
    };
  }
}

class MemoryAudit implements MemberAuditSink {
  readonly entries: AuditEntry[] = [];
  failing = false;
  async record(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
    if (this.failing) throw new Error('audit is down');
  }
}

export interface RigOptions {
  members?: MembersDocument;
  shares?: SharesDocument;
  known?: readonly string[];
  link?: ShareLinkTarget;
  compare?: DigestComparison;
  /** Leave the documents unread, as a caller that forgot `ready` would. */
  unloaded?: boolean;
  /** An upgrade the members file is said to have found due when it was read. */
  upgrade?: MembersUpgrade;
}

export async function rig(options: RigOptions = {}) {
  const log: string[] = [];
  const clock = { now: T0 };
  const members = new MemoryStore<MembersDocument>(options.members ?? EMPTY_MEMBERS_DOCUMENT, 'members', log);
  members.upgrade = options.upgrade;
  const shares = new MemoryStore<SharesDocument>(options.shares ?? EMPTY_SHARES_DOCUMENT, 'shares', log);
  const renamed: (readonly MemberRename[])[] = [];
  const audit = new MemoryAudit();
  const randomness = { calls: 0 };
  const known = new Set(options.known ?? catalogIds(1, 100));
  const linkState = { target: options.link ?? READY_LINK };
  const hasher: ShareCodeHasher = { hex: digestOf };
  const catalogs: CatalogDirectory = { knownIds: async () => known };
  const links: ShareLinkSource = { target: () => linkState.target };
  const sessions: MemberSessionCloser = {
    closeMember: async id => {
      log.push(`closeMember:${id}`);
    },
    closeKey: async (member, key) => {
      log.push(`closeKey:${member}:${key}`);
    },
  };
  const service = new CatalogMemberService({
    members,
    shares,
    hasher,
    crypto: {
      randomBytes: length => {
        randomness.calls += 1;
        const bytes = new Uint8Array(length).fill(7);
        bytes[0] = (randomness.calls >> 8) & 255;
        bytes[1] = randomness.calls & 255;
        return bytes;
      },
    },
    catalogs,
    links,
    sessions,
    audit,
    onRenamed: renames => renamed.push(renames),
    now: () => clock.now,
    ...(options.compare === undefined ? {} : { compare: options.compare }),
  });
  if (options.unloaded !== true) await service.ready();
  return { service, members, shares, audit, clock, log, randomness, known, linkState, renamed };
}

export const newKey = (n: number, clientName = `Browser ${String(n)}`): NewMemberKey => ({
  memberKey: memberKeyText(n),
  boxKey: boxKeyText(n),
  clientName,
});

export const singleFor = (label: string, ids: readonly string[] = [catalogId(1)]): CatalogShareMintRequest => ({
  catalogIds: [...ids],
  member: { kind: 'new', label },
  expiresIn: '1h',
  uses: { kind: 'single' },
});

export const multiFor = (
  label: string,
  cap = 200,
  ids: readonly string[] = [catalogId(1)],
): CatalogShareMintRequest => ({
  catalogIds: [...ids],
  member: { kind: 'new', label },
  expiresIn: '1h',
  uses: { kind: 'multi', cap },
});

export const singleNamed = (name: string, ids: readonly string[] = [catalogId(1)]): CatalogShareMintRequest => ({
  catalogIds: [...ids],
  member: { name },
  expiresIn: '1h',
  uses: { kind: 'single' },
});

export const multiNamed = (
  name: string,
  cap = 200,
  ids: readonly string[] = [catalogId(1)],
): CatalogShareMintRequest => ({
  catalogIds: [...ids],
  member: { name },
  expiresIn: '1h',
  uses: { kind: 'multi', cap },
});

export const singleForMember = (memberN: number, ids: readonly string[] = [catalogId(1)]): CatalogShareMintRequest => ({
  catalogIds: [...ids],
  member: { kind: 'existing', memberId: memberId(memberN) },
  expiresIn: '1h',
  uses: { kind: 'single' },
});

export async function refusal(work: () => Promise<unknown>): Promise<CatalogMemberRefusal> {
  try {
    await work();
  } catch (error) {
    if (error instanceof CatalogMemberRefusal) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

export async function failure(work: () => Promise<unknown>): Promise<Error> {
  try {
    await work();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error('expected a failure');
}

export const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));
