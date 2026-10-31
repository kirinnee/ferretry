/**
 * The people this machine shares catalogs with, and the codes that let them in (docs/catalogs.md § Members).
 *
 * ## Why the state lives in memory
 *
 * The admission step is ONE synchronous step (docs/relay-protocol.md §14): two concurrent joins cannot both
 * spend one code because nothing can run between the lookup and the spend. That needs the documents in
 * memory. They are loaded once, on first use, and every change is applied to memory FIRST and written
 * second; a write that fails puts back what it changed unless something else changed it meanwhile.
 *
 * A burned code is the exception: it stays burned in memory when a persist fails (contract step 3), so the
 * owner sees a share used with no key behind it and mints another.
 *
 * ## The order of a revoke
 *
 * `members.json` is written FIRST, then `shares.json`, then live sessions are closed (a no-op until phase
 * 2b-2 registers them): what the person can reach must stop before anything else is tidied.
 */
import {
  CATALOG_MAX_LIVE_SHARES,
  CATALOG_SHARE_EXPIRY_SECONDS,
  CATALOG_SHARE_MAX_CATALOGS,
  CatalogShareCodeSchema,
  type CatalogMemberList,
  type CatalogMemberView,
  type CatalogShareList,
  type CatalogShareMintRequest,
  type CatalogShareMintResponse,
  type CatalogShareView,
  MEMBER_PASSKEY_WINDOW_SECONDS,
  shareLinkUrl,
} from '@ferretry/protocol';
import { DaemonIdSchema } from '@ferretry/protocol';
import type { RelayCrypto } from '@ferretry/relay';
import { secretsMatch } from '../api/authentication.ts';
import {
  admitJoin,
  admitRedeem,
  type Admitted,
  type CrossMemberUse,
  type DigestComparison,
  type JoinAdmission,
  type JoinReservation,
  type Probe,
  type RedeemAdmission,
  type RedeemReservation,
  type Refused,
  type Reservation,
  shareState,
} from './admission.ts';
import {
  EMPTY_SHARES_DOCUMENT,
  type MembersDocument,
  type SharesDocument,
  type StoredMember,
  type StoredMemberKey,
  type StoredShare,
} from './document.ts';
import type {
  CatalogDirectory,
  CatalogMembersStore,
  CatalogSharesStore,
  MemberAuditSink,
  MemberSessionCloser,
  ShareCodeHasher,
  ShareLinkSource,
} from './ports.ts';
import { CatalogMemberRefusal } from './refusal.ts';
import { sweepMembers, type RemovedKey } from './sweep.ts';
import { listedShares, memberView, shareView } from './views.ts';

export interface CatalogMemberDeps {
  readonly members: CatalogMembersStore;
  readonly shares: CatalogSharesStore;
  readonly hasher: ShareCodeHasher;
  readonly crypto: Pick<RelayCrypto, 'randomBytes'>;
  readonly catalogs: CatalogDirectory;
  readonly links: ShareLinkSource;
  readonly sessions: MemberSessionCloser;
  readonly audit: MemberAuditSink;
  /** Milliseconds since the epoch. */
  readonly now: () => number;
  /** Compares two digests. Defaults to the constant-time compare; a test passes its own to watch the path. */
  readonly compare?: DigestComparison;
}

/** What a browser hands the publisher at a join. The ids and the window are this service's to make. */
export interface NewMemberKey {
  readonly memberKey: string;
  readonly boxKey: string;
  readonly clientName: string;
}

/** What a join leaves behind, for the `joined` answer. */
export interface JoinedMember {
  readonly memberId: string;
  readonly keyId: string;
  readonly label: string;
  readonly catalogCount: number;
  readonly passkeyWindowEndsAt: string;
}

/** Who spent a redeem, so the share can list it. A redeem that adds nothing records nobody. */
export interface RedeemedBy {
  readonly keyId: string;
  readonly clientName: string;
}

export interface RevokedMember {
  readonly memberId: string;
  readonly keysRemoved: number;
  readonly sharesEnded: number;
}

export interface RemovedMemberKey {
  readonly memberId: string;
  readonly keyId: string;
}

export interface RemovedMemberCatalog {
  readonly memberId: string;
  readonly catalogId: string;
}

interface State {
  readonly members: MembersDocument;
  readonly shares: SharesDocument;
}

const instant = (ms: number): string => new Date(ms).toISOString();

function randomText(crypto: Pick<RelayCrypto, 'randomBytes'>): string {
  return btoa(String.fromCharCode(...crypto.randomBytes(16)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

export class CatalogMemberService {
  #queue: Promise<unknown> = Promise.resolve();
  #state: State | undefined;
  #loading: Promise<void> | undefined;
  readonly #pending = new Map<string, JoinReservation>();
  readonly #compare: DigestComparison;

  constructor(private readonly deps: CatalogMemberDeps) {
    this.#compare = deps.compare ?? secretsMatch;
  }

  // ── Loading ────────────────────────────────────────────────────────────────────────────────────

  /**
   * Reads both documents once. A damaged file is an error here, never an empty list. Whoever admits a join
   * awaits this in step 1, because the admission step itself cannot wait.
   */
  async ready(): Promise<void> {
    if (this.#state !== undefined) return;
    this.#loading ??= this.#load().finally(() => {
      this.#loading = undefined;
    });
    await this.#loading;
  }

  async #load(): Promise<void> {
    const [members, shares] = await Promise.all([this.deps.members.read(), this.deps.shares.read()]);
    this.#state ??= { members, shares };
  }

  // ── The admission step (2b-2 calls these) ───────────────────────────────────────────────────────

  /**
   * Step 2 of a join, synchronously: find the code, check it is live, check room and the hourly count, spend
   * it, reserve a key slot. Answers a reservation or ONE refusal. {@link ready} must have resolved.
   */
  admitJoin(codeText: string, now: number): JoinAdmission {
    return this.#admit(codeText, now, probe => admitJoin(probe));
  }

  /** Step 2 of a redeem by a browser that already belongs to `memberId`. */
  admitRedeem(codeText: string, memberId: string, now: number): RedeemAdmission {
    return this.#admit(codeText, now, probe => admitRedeem(probe, memberId));
  }

  #admit<R extends Reservation>(
    codeText: string,
    now: number,
    run: (probe: Probe) => Admitted<R> | Refused,
  ): Admitted<R> | Refused {
    const state = this.#state;
    // Not loaded is a refusal, not a guess: the caller forgot to await `ready`, and nothing is spent.
    if (state === undefined)
      return { ok: false, refusal: 'share_refused', reason: 'unknown', shares: EMPTY_SHARES_DOCUMENT, leftLive: false };
    const decision = run({
      members: state.members,
      shares: state.shares,
      pending: [...this.#pending.values()],
      now,
      digest: this.deps.hasher.hex(codeText),
      compare: this.#compare,
      reservationId: randomText(this.deps.crypto),
    });
    this.#state = { ...state, shares: decision.shares };
    if (decision.ok) {
      if (decision.reservation.kind === 'join')
        this.#pending.set(decision.reservation.reservationId, decision.reservation);
    } else if (decision.crossMember !== undefined) this.#tell(decision.crossMember);
    return decision;
  }

  /**
   * Step 3 of a join: persist the member and the key. The shares are written first, so the spent code is on
   * disk before the key is. A write that fails throws and puts the member side back; the code STAYS SPENT
   * (the admission already burned it) and the caller {@link release}s the slot.
   */
  async commit(reservation: JoinReservation, key: NewMemberKey): Promise<JoinedMember> {
    return await this.#serially(async () => {
      const state = this.#loaded();
      const now = this.deps.now();
      if (state.members.members.some(member => member.keys.some(other => other.memberKey === key.memberKey)))
        throw new CatalogMemberRefusal('share_refused', 'that browser key is already registered here');
      const keyId = `mk_${randomText(this.deps.crypto)}`;
      const windowEnds = instant(now + MEMBER_PASSKEY_WINDOW_SECONDS * 1_000);
      const stored: StoredMemberKey = {
        keyId,
        memberKey: key.memberKey,
        boxKey: key.boxKey,
        clientName: key.clientName,
        joinedAt: instant(now),
        passkeyCount: 0,
        passkeyWindowEndsAt: windowEnds,
      };
      const existing = state.members.members.find(member => member.memberId === reservation.memberId);
      const member: StoredMember =
        existing === undefined
          ? {
              memberId: reservation.memberId,
              label: reservation.memberLabel,
              catalogIds: [...reservation.catalogIds],
              createdAt: instant(now),
              keys: [stored],
            }
          : {
              ...existing,
              catalogIds: [...new Set([...existing.catalogIds, ...reservation.catalogIds])],
              keys: [...existing.keys, stored],
            };
      const members: MembersDocument = {
        ...state.members,
        members:
          existing === undefined
            ? [...state.members.members, member]
            : this.#membersWith(state.members, member).members,
      };
      const shares = this.#usedBy(state.shares, reservation.shareId, {
        clientName: key.clientName,
        keyId,
        at: instant(now),
      });
      this.#pending.delete(reservation.reservationId);
      this.#state = { members, shares };
      try {
        await this.deps.shares.write(shares);
        await this.deps.members.write(members);
      } catch (error) {
        this.#revert(members, shares, state);
        throw error;
      }
      return {
        memberId: member.memberId,
        keyId,
        label: member.label,
        catalogCount: member.catalogIds.length,
        passkeyWindowEndsAt: windowEnds,
      };
    });
  }

  /** Step 3 of a redeem: the catalogs it adds are filed. A redeem that adds nothing writes nothing. */
  async commitRedeem(reservation: RedeemReservation, by: RedeemedBy): Promise<void> {
    await this.#serially(async () => {
      const state = this.#loaded();
      const member = state.members.members.find(entry => entry.memberId === reservation.memberId);
      if (member === undefined) throw new CatalogMemberRefusal('member_unknown', 'that member no longer exists');
      if (reservation.added.length === 0) return;
      const members = this.#membersWith(state.members, {
        ...member,
        catalogIds: [...new Set([...member.catalogIds, ...reservation.added])],
      });
      const shares = this.#usedBy(state.shares, reservation.shareId, {
        clientName: by.clientName,
        keyId: by.keyId,
        at: instant(this.deps.now()),
      });
      this.#state = { members, shares };
      try {
        await this.deps.shares.write(shares);
        await this.deps.members.write(members);
      } catch (error) {
        this.#revert(members, shares, state);
        throw error;
      }
    });
  }

  /**
   * Gives back the slot a join reserved when its persist did not happen. THE CODE STAYS SPENT: the owner sees
   * the share used with no key behind it and mints another. The burn is written best-effort, because the disk
   * that just failed may still take the smaller write.
   */
  async release(reservation: Reservation): Promise<void> {
    this.#pending.delete(reservation.reservationId);
    const state = this.#state;
    if (state === undefined) return;
    await this.deps.shares.write(state.shares).catch(() => undefined);
  }

  // ── The owner: shares ────────────────────────────────────────────────────────────────────────────

  /** Makes a share. The code is in the answer and nowhere else, ever: only its SHA-256 is kept. */
  async mint(request: CatalogShareMintRequest): Promise<CatalogShareMintResponse> {
    await this.ready();
    // The link is checked BEFORE a code is made: a machine with nowhere to point a link spends nothing.
    const target = this.deps.links.target();
    if (target.kind === 'unavailable') throw new CatalogMemberRefusal('share_link_unavailable', target.reason);
    const known = await this.deps.catalogs.knownIds();
    return await this.#serially(async () => {
      const state = this.#loaded();
      const now = this.deps.now();
      const missing = request.catalogIds.filter(id => !known.has(id));
      if (missing.length > 0)
        throw new CatalogMemberRefusal('catalog_unknown', `There is no catalog ${missing.join(', ')} on this machine.`);
      const live = state.shares.shares.filter(share => shareState(share, now) === 'live').length;
      if (live >= CATALOG_MAX_LIVE_SHARES)
        throw new CatalogMemberRefusal(
          'shares_full',
          `${String(CATALOG_MAX_LIVE_SHARES)} shares are live at once. End one, or wait for one to expire.`,
        );
      const existing =
        request.member.kind === 'existing'
          ? state.members.members.find(member => member.memberId === (request.member as { memberId: string }).memberId)
          : undefined;
      if (request.member.kind === 'existing' && existing === undefined)
        throw new CatalogMemberRefusal('member_unknown', 'There is no such member.');
      if (new Set([...(existing?.catalogIds ?? []), ...request.catalogIds]).size > CATALOG_SHARE_MAX_CATALOGS)
        throw new CatalogMemberRefusal(
          'catalogs_full',
          `A member can read at most ${String(CATALOG_SHARE_MAX_CATALOGS)} catalogs.`,
        );
      const code = CatalogShareCodeSchema.parse(`fy_share_${randomText(this.deps.crypto)}`);
      const share: StoredShare = {
        shareId: `shr_${randomText(this.deps.crypto)}`,
        codeSha256: this.deps.hasher.hex(code),
        memberId: existing?.memberId ?? `mbr_${randomText(this.deps.crypto)}`,
        memberLabel: existing?.label ?? (request.member.kind === 'new' ? request.member.label : ''),
        memberKind: request.member.kind,
        catalogIds: [...request.catalogIds],
        createdAt: instant(now),
        expiresAt: instant(now + CATALOG_SHARE_EXPIRY_SECONDS[request.expiresIn] * 1_000),
        uses: request.uses,
        used: 0,
        state: 'live',
        usedBy: [],
        successes: [],
      };
      const before = state.shares;
      const shares: SharesDocument = { ...before, shares: [...before.shares, share] };
      await this.#applyShares(shares, before);
      return {
        share: shareView(share, now),
        code,
        link: shareLinkUrl(target.appOrigin, {
          daemonUrl: target.daemonUrl,
          daemonId: DaemonIdSchema.parse(target.daemonId),
          code,
        }),
      };
    });
  }

  async listShares(): Promise<CatalogShareList> {
    await this.ready();
    return { shares: [...listedShares(this.#loaded().shares.shares, this.deps.now())] };
  }

  /** Ends a share early. A share already over is answered as it is. */
  async endShare(shareId: string): Promise<CatalogShareView> {
    await this.ready();
    return await this.#serially(async () => {
      const state = this.#loaded();
      const now = this.deps.now();
      const share = state.shares.shares.find(entry => entry.shareId === shareId);
      if (share === undefined) throw new CatalogMemberRefusal('share_unknown', 'There is no such share.');
      if (shareState(share, now) !== 'live') return shareView(share, now);
      const ended: StoredShare = { ...share, state: 'ended' };
      await this.#applyShares(this.#sharesWith(state.shares, ended), state.shares);
      return shareView(ended, now);
    });
  }

  // ── The owner: members ───────────────────────────────────────────────────────────────────────────

  async listMembers(): Promise<CatalogMemberList> {
    await this.ready();
    return { members: this.#loaded().members.members.map(memberView) };
  }

  async renameMember(memberId: string, label: string): Promise<CatalogMemberView> {
    await this.ready();
    return await this.#serially(async () => {
      const state = this.#loaded();
      const member = this.#member(state, memberId);
      const next: StoredMember = { ...member, label };
      await this.#applyMembers(this.#membersWith(state.members, next), state.members);
      // The label a not-yet-used share carries is the name the owner gave when minting; it follows the rename.
      const shares: SharesDocument = {
        ...this.#loaded().shares,
        shares: this.#loaded().shares.shares.map(share =>
          share.memberId === memberId ? { ...share, memberLabel: label } : share,
        ),
      };
      await this.#applyShares(shares, this.#loaded().shares);
      return memberView(next);
    });
  }

  /**
   * Removes a person: their record and every browser, and ends the shares that name them. The members file is
   * written first. Asked again after a failure between the two writes, it finishes the job.
   */
  async revokeMember(memberId: string): Promise<RevokedMember> {
    await this.ready();
    const revoked = await this.#serially(async () => {
      const state = this.#loaded();
      const member = state.members.members.find(entry => entry.memberId === memberId);
      const named = state.shares.shares.filter(share => share.memberId === memberId && share.state === 'live');
      if (member === undefined && named.length === 0)
        throw new CatalogMemberRefusal('member_unknown', 'There is no such member.');
      const members: MembersDocument = {
        ...state.members,
        members: state.members.members.filter(entry => entry.memberId !== memberId),
      };
      const shares = this.#ended(state.shares, share => share.memberId === memberId);
      this.#state = { members, shares };
      let failure: unknown;
      try {
        if (member !== undefined) await this.deps.members.write(members);
        if (shares !== state.shares) await this.deps.shares.write(shares);
      } catch (error) {
        failure = error;
      }
      // Closing what is open does not wait on a write: the person's access is already gone in memory.
      await this.deps.sessions.closeMember(memberId);
      if (failure !== undefined) throw failure;
      return { memberId, keysRemoved: member?.keys.length ?? 0, sharesEnded: named.length };
    });
    return revoked;
  }

  /** Removes one browser of a member; the member and the other browsers stay. */
  async removeKey(memberId: string, keyId: string): Promise<RemovedMemberKey> {
    await this.ready();
    return await this.#serially(async () => {
      const state = this.#loaded();
      const member = this.#member(state, memberId);
      if (!member.keys.some(key => key.keyId === keyId))
        throw new CatalogMemberRefusal('member_key_unknown', 'That member has no such browser.');
      const next: StoredMember = { ...member, keys: member.keys.filter(key => key.keyId !== keyId) };
      await this.#applyMembers(this.#membersWith(state.members, next), state.members);
      await this.deps.sessions.closeKey(memberId, keyId);
      return { memberId, keyId };
    });
  }

  /** Takes one catalog away from a member, and from the shares that would give it back. */
  async removeCatalog(memberId: string, catalogId: string): Promise<RemovedMemberCatalog> {
    await this.ready();
    return await this.#serially(async () => {
      const state = this.#loaded();
      const member = this.#member(state, memberId);
      if (!member.catalogIds.includes(catalogId))
        throw new CatalogMemberRefusal('catalog_unknown', 'That member cannot read such a catalog.');
      const next: StoredMember = { ...member, catalogIds: member.catalogIds.filter(id => id !== catalogId) };
      await this.#applyMembers(this.#membersWith(state.members, next), state.members);
      const before = this.#loaded().shares;
      await this.#applyShares(
        this.#withoutCatalog(before, catalogId, share => share.memberId === memberId),
        before,
      );
      return { memberId, catalogId };
    });
  }

  /**
   * A catalog was deleted: it leaves every member and every share. Called BEFORE the catalog's own file is
   * written, so a failure in between leaves people without a catalog that still exists, never with a name for
   * one that is gone.
   */
  async forgetCatalog(catalogId: string): Promise<void> {
    await this.ready();
    await this.#serially(async () => {
      const state = this.#loaded();
      const members: MembersDocument = {
        ...state.members,
        members: state.members.members.map(member =>
          member.catalogIds.includes(catalogId)
            ? { ...member, catalogIds: member.catalogIds.filter(id => id !== catalogId) }
            : member,
        ),
      };
      const changed = members.members.some((member, index) => member !== state.members.members[index]);
      if (changed) await this.#applyMembers(members, state.members);
      const before = this.#loaded().shares;
      const shares = this.#withoutCatalog(before, catalogId, () => true);
      if (shares !== before) await this.#applyShares(shares, before);
    });
  }

  // ── Time ─────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Removes the browsers time has ended: a key with no passkey when its window closed, and a key unused for
   * 90 days. Answers the keys it removed. The sessions of a removed key are closed after the write.
   */
  async sweep(): Promise<readonly RemovedKey[]> {
    await this.ready();
    return await this.#serially(async () => {
      const state = this.#loaded();
      const swept = sweepMembers(state.members, this.deps.now());
      if (swept.members === state.members) return [];
      await this.#applyMembers(swept.members, state.members);
      for (const key of swept.removed) await this.deps.sessions.closeKey(key.memberId, key.keyId);
      return swept.removed;
    });
  }

  // ── Internals ────────────────────────────────────────────────────────────────────────────────────

  #loaded(): State {
    if (this.#state === undefined) throw new CatalogMemberRefusal('store_damaged', 'the member store was not read');
    return this.#state;
  }

  #member(state: State, memberId: string): StoredMember {
    const member = state.members.members.find(entry => entry.memberId === memberId);
    if (member === undefined) throw new CatalogMemberRefusal('member_unknown', 'There is no such member.');
    return member;
  }

  #membersWith(document: MembersDocument, next: StoredMember): MembersDocument {
    return { ...document, members: document.members.map(entry => (entry.memberId === next.memberId ? next : entry)) };
  }

  #sharesWith(document: SharesDocument, next: StoredShare): SharesDocument {
    return { ...document, shares: document.shares.map(entry => (entry.shareId === next.shareId ? next : entry)) };
  }

  /** The shares matching `which` and still live, ended. Same object when none were. */
  #ended(document: SharesDocument, which: (share: StoredShare) => boolean): SharesDocument {
    if (!document.shares.some(share => share.state === 'live' && which(share))) return document;
    return {
      ...document,
      shares: document.shares.map(share =>
        share.state === 'live' && which(share) ? { ...share, state: 'ended' } : share,
      ),
    };
  }

  /** The catalog out of every share `which` picks; a live share left holding nothing is ended. */
  #withoutCatalog(document: SharesDocument, catalogId: string, which: (share: StoredShare) => boolean): SharesDocument {
    if (!document.shares.some(share => which(share) && share.catalogIds.includes(catalogId))) return document;
    return {
      ...document,
      shares: document.shares.map(share => {
        if (!which(share) || !share.catalogIds.includes(catalogId)) return share;
        const catalogIds = share.catalogIds.filter(id => id !== catalogId);
        return {
          ...share,
          catalogIds,
          state: catalogIds.length === 0 && share.state === 'live' ? 'ended' : share.state,
        };
      }),
    };
  }

  /** Memory first, then disk; a failed write puts memory back unless something else has changed it. */
  async #applyMembers(next: MembersDocument, before: MembersDocument): Promise<void> {
    const state = this.#loaded();
    this.#state = { ...state, members: next };
    try {
      await this.deps.members.write(next);
    } catch (error) {
      if (this.#state.members === next) this.#state = { ...this.#state, members: before };
      throw error;
    }
  }

  async #applyShares(next: SharesDocument, before: SharesDocument): Promise<void> {
    const state = this.#loaded();
    this.#state = { ...state, shares: next };
    try {
      await this.deps.shares.write(next);
    } catch (error) {
      if (this.#state.shares === next) this.#state = { ...this.#state, shares: before };
      throw error;
    }
  }

  #usedBy(document: SharesDocument, shareId: string, use: StoredShare['usedBy'][number]): SharesDocument {
    return {
      ...document,
      shares: document.shares.map(share =>
        share.shareId === shareId ? { ...share, usedBy: [...share.usedBy, use] } : share,
      ),
    };
  }

  /** Puts `before` back for each side that is still what a failed write set, so a later change is not undone. */
  #revert(members: MembersDocument, shares: SharesDocument, before: State): void {
    const current = this.#loaded();
    this.#state = {
      members: current.members === members ? before.members : current.members,
      shares: current.shares === shares ? before.shares : current.shares,
    };
  }

  #tell(use: CrossMemberUse): void {
    void this.deps.audit
      .record({
        event: 'catalog.share.cross-member',
        actor: { kind: 'anonymous' },
        subject: use.shareId,
        outcome: 'succeeded',
        detail: { memberId: use.memberId, shareMemberId: use.shareMemberId },
      })
      .catch(() => undefined);
  }

  #serially<T>(run: () => Promise<T>): Promise<T> {
    const result = this.#queue.then(run, run);
    this.#queue = result.catch(() => undefined);
    return result;
  }
}
