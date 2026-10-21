import {
  DEFAULT_TUNNEL_SETTINGS,
  type TunnelChallengeBook,
  type TunnelRow,
  type TunnelRowPage,
  type TunnelSettings,
  type TunnelStore,
  type TunnelZoneVerdict,
} from '../../src/lib/index.ts';

/**
 * The provisioner's storage port in memory, for the unit tier. Pages are ordered by key the way
 * Durable Object storage orders them, so paging behaves as it does in production.
 */
export class MemoryTunnelStore implements TunnelStore {
  readonly active = new Map<string, TunnelRow>();
  readonly retired = new Map<string, TunnelRow>();
  readonly verdicts = new Map<string, TunnelZoneVerdict>();
  book: TunnelChallengeBook = [];
  stored: TunnelSettings = DEFAULT_TUNNEL_SETTINGS;
  /** Rows a page reports as unreadable, keyed by kind, to exercise the damaged-row path. */
  damaged = { active: 0, retired: 0 };

  async activeRow(daemonId: string) {
    return this.active.get(daemonId) ?? null;
  }

  async saveActive(row: TunnelRow) {
    this.active.set(row.daemonId, row);
  }

  async retire(row: TunnelRow) {
    this.active.delete(row.daemonId);
    this.retired.set(row.label, row);
  }

  async saveRetired(row: TunnelRow) {
    this.retired.set(row.label, row);
  }

  async forget(row: TunnelRow) {
    this.retired.delete(row.label);
  }

  async activeRows(after: string | null, limit: number) {
    return page(this.active, after, limit, this.damaged.active);
  }

  async retiredRows(after: string | null, limit: number) {
    return page(this.retired, after, limit, this.damaged.retired);
  }

  async countOnAccount(accountId: string, limit: number) {
    const all = [...this.active.values(), ...this.retired.values()];
    return Math.min(all.filter(row => row.accountId === accountId).length, limit);
  }

  async zoneVerdicts() {
    return new Map(this.verdicts);
  }

  async saveZoneVerdict(verdict: TunnelZoneVerdict) {
    this.verdicts.set(verdict.accountId, verdict);
  }

  async challengeBook() {
    return this.book;
  }

  async saveChallengeBook(book: TunnelChallengeBook) {
    this.book = book;
  }

  async settings() {
    return this.stored;
  }

  async saveSettings(settings: TunnelSettings) {
    this.stored = settings;
  }

  /** Every tunnel row of either kind. */
  rows(): TunnelRow[] {
    return [...this.active.values(), ...this.retired.values()];
  }
}

function page(
  rows: ReadonlyMap<string, TunnelRow>,
  after: string | null,
  limit: number,
  damaged: number,
): TunnelRowPage {
  const keys = [...rows.keys()].sort().filter(key => after === null || key > after);
  const slice = keys.slice(0, limit);
  return {
    rows: slice.map(key => rows.get(key) as TunnelRow),
    damaged: after === null ? damaged : 0,
    next: keys.length > limit ? (slice.at(-1) ?? null) : null,
  };
}
