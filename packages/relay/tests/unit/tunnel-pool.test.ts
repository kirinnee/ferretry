import { describe, it } from 'bun:test';
import {
  DEFAULT_TUNNEL_SETTINGS,
  issueTunnelChallenge,
  NONCE_BYTES,
  parseTunnelAccountPool,
  spendTunnelChallenge,
  TUNNEL_CHALLENGE_LIMITS,
  TUNNEL_DAY_MILLISECONDS,
  TUNNEL_INCOMPLETE_RECLAIM_MILLISECONDS,
  TUNNEL_LABEL_BYTES,
  TUNNEL_ZONE_CHECK_FAILED_MILLISECONDS,
  TUNNEL_ZONE_CHECK_PASSED_MILLISECONDS,
  type TunnelAccount,
  TunnelAccountSchema,
  type TunnelChallengeBook,
  TunnelLabelSchema,
  TunnelOperatorStatusSchema,
  type TunnelPoolState,
  type TunnelRefusalCode,
  type TunnelRow,
  TunnelRowSchema,
  type TunnelZoneVerdict,
  toBase64Url,
  tunnelAccountStanding,
  tunnelCnameTarget,
  tunnelLabel,
  tunnelName,
  tunnelOperatorStatus,
  tunnelPlacementRefusal,
  tunnelRefusalStatus,
  tunnelRowAccount,
  tunnelRowComplete,
  tunnelRowVerdict,
  tunnelServiceAvailable,
  tunnelZoneCheck,
  tunnelZoneMatches,
} from '@ferretry/relay';
import should from 'should';

const SECRET = 'cf-api-token-that-must-never-appear';
const daemonA = `fy_daemon_${'a'.repeat(43)}`;
const daemonB = `fy_daemon_${'b'.repeat(43)}`;

function account(overrides: Partial<TunnelAccount> = {}): TunnelAccount {
  return TunnelAccountSchema.parse({
    name: 'pool-a',
    accountId: 'a'.repeat(32),
    apiToken: SECRET,
    zoneId: 'b'.repeat(32),
    zone: 'tunnels-a.example.com',
    ...overrides,
  });
}

function row(overrides: Partial<TunnelRow> = {}): TunnelRow {
  return TunnelRowSchema.parse({
    label: 'abcdefghijklmnop',
    daemonId: daemonA,
    account: 'pool-a',
    accountId: 'a'.repeat(32),
    hostname: 'abcdefghijklmnop.tunnels-a.example.com',
    tunnelId: 'tunnel-1',
    configuredPort: 4000,
    dnsRecordId: 'record-1',
    originPort: 4000,
    createdAt: 0,
    lastSeenAt: 0,
    ...overrides,
  });
}

function verdict(passed: boolean, checkedAt: number, target = account()): TunnelZoneVerdict {
  return { accountId: target.accountId, zoneId: target.zoneId, zone: target.zone, passed, checkedAt };
}

describe('the tunnel pool secret', () => {
  it('should read an unset or blank secret as no pool at all', () => {
    should(parseTunnelAccountPool(undefined)).eql({ kind: 'absent' });
    should(parseTunnelAccountPool('  ')).eql({ kind: 'absent' });
  });

  it('should parse a pool and fill the defaults', () => {
    const pool = parseTunnelAccountPool(JSON.stringify([account()]));
    should(pool.kind).equal('ready');
    if (pool.kind !== 'ready') return;
    should(pool.accounts[0]?.maxTunnels).equal(1000);
    should(pool.accounts[0]?.accepting).be.true();
  });

  it('should refuse text that is not JSON without quoting any of it', () => {
    const pool = parseTunnelAccountPool(`[{"apiToken": "${SECRET}"`);
    should(pool).eql({ kind: 'invalid', reason: 'TUNNEL_ACCOUNTS is not JSON' });
  });

  it('should name the failing paths and codes of a mis-shaped pool and never a value', () => {
    const pool = parseTunnelAccountPool(JSON.stringify([{ ...account(), accountId: SECRET }, { apiToken: SECRET }]));
    should(pool.kind).equal('invalid');
    if (pool.kind !== 'invalid') return;
    should(pool.reason).match(/^TUNNEL_ACCOUNTS does not match the pool schema \(0\.accountId: invalid_format/);
    should(pool.reason).not.containEql(SECRET);
    const root = parseTunnelAccountPool('{}');
    should(root.kind === 'invalid' && root.reason).match(/\(root\): invalid_type/);
  });

  it('should find a row only on the pool entry with the same name AND account id', () => {
    const pool: TunnelPoolState = { kind: 'ready', accounts: [account()] };
    should(tunnelRowAccount(pool, row())?.name).equal('pool-a');
    should(tunnelRowAccount(pool, row({ accountId: 'c'.repeat(32) }))).be.null();
    should(tunnelRowAccount(pool, row({ account: 'pool-b' }))).be.null();
    should(tunnelRowAccount({ kind: 'absent' }, row())).be.null();
  });
});

describe('tunnel hostnames', () => {
  it('should spell 80 random bits as one lowercase base32 label', () => {
    const label = tunnelLabel(new Uint8Array(TUNNEL_LABEL_BYTES).fill(255));
    should(label).equal('7777777777777777');
    should(tunnelLabel(new Uint8Array(TUNNEL_LABEL_BYTES))).equal('aaaaaaaaaaaaaaaa');
    should(
      TunnelLabelSchema.safeParse(tunnelLabel(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))).success,
    ).be.true();
    should(() => tunnelLabel(new Uint8Array(4))).throw(RangeError);
  });

  it('should name the tunnel and its CNAME target from the label and id', () => {
    should(tunnelName('abc')).equal('fy-abc');
    should(tunnelCnameTarget('tunnel-1')).equal('tunnel-1.cfargotunnel.com');
  });

  it('should call a row complete only when every step is recorded for its current port', () => {
    should(tunnelRowComplete(row())).be.true();
    should(tunnelRowComplete(row({ tunnelId: null }))).be.false();
    should(tunnelRowComplete(row({ originPort: 4001 }))).be.false();
    should(tunnelRowComplete(row({ dnsRecordId: null }))).be.false();
  });
});

describe('tunnel placement', () => {
  it('should trust a zone verdict only for its own triple and only while fresh', () => {
    const target = account();
    should(tunnelZoneCheck(target, null, 0)).equal('unchecked');
    should(tunnelZoneCheck(target, verdict(true, 0), TUNNEL_ZONE_CHECK_PASSED_MILLISECONDS - 1)).equal('passed');
    should(tunnelZoneCheck(target, verdict(true, 0), TUNNEL_ZONE_CHECK_PASSED_MILLISECONDS)).equal('unchecked');
    should(tunnelZoneCheck(target, verdict(false, 0), TUNNEL_ZONE_CHECK_FAILED_MILLISECONDS - 1)).equal('failed');
    should(tunnelZoneCheck(target, verdict(false, 0), TUNNEL_ZONE_CHECK_FAILED_MILLISECONDS)).equal('unchecked');
    should(tunnelZoneCheck(account({ accountId: 'c'.repeat(32) }), verdict(true, 0), 1)).equal('unchecked');
    should(tunnelZoneCheck(account({ zoneId: 'c'.repeat(32) }), verdict(true, 0), 1)).equal('unchecked');
    should(tunnelZoneCheck(account({ zone: 'other.example.com' }), verdict(true, 0), 1)).equal('unchecked');
  });

  it('should match a zone only when Cloudflare places it in the same account under the same name', () => {
    const target = account();
    should(tunnelZoneMatches(target, { accountId: target.accountId, name: target.zone })).be.true();
    should(tunnelZoneMatches(target, { accountId: 'c'.repeat(32), name: target.zone })).be.false();
    should(tunnelZoneMatches(target, { accountId: target.accountId, name: 'other.example.com' })).be.false();
  });

  it('should stand an account by draining, zone, room and check, in that order', () => {
    should(tunnelAccountStanding(account({ accepting: false }), 0, 'passed')).equal('draining');
    should(tunnelAccountStanding(account(), 0, 'failed')).equal('misconfigured');
    should(tunnelAccountStanding(account({ maxTunnels: 2 }), 2, 'passed')).equal('full');
    should(tunnelAccountStanding(account(), 999, 'passed')).equal('eligible');
    should(tunnelAccountStanding(account(), 0, 'unchecked')).equal('needs-zone-check');
  });

  it('should refuse capacity only when an accepting account is full', () => {
    should(tunnelPlacementRefusal(['draining', 'full'])).equal('tunnel_capacity');
    should(tunnelPlacementRefusal(['draining', 'misconfigured'])).equal('tunnel_unavailable');
    should(tunnelPlacementRefusal([])).equal('tunnel_unavailable');
  });

  it('should advertise only a parsed pool with an accepting account whose zone has not failed', () => {
    const target = account();
    const ready: TunnelPoolState = { kind: 'ready', accounts: [target] };
    should(tunnelServiceAvailable({ kind: 'absent' }, new Map(), 0)).be.false();
    should(tunnelServiceAvailable({ kind: 'invalid', reason: 'x' }, new Map(), 0)).be.false();
    should(tunnelServiceAvailable(ready, new Map(), 0)).be.true();
    should(tunnelServiceAvailable(ready, new Map([[target.accountId, verdict(false, 0)]]), 1)).be.false();
    should(
      tunnelServiceAvailable({ kind: 'ready', accounts: [account({ accepting: false })] }, new Map(), 0),
    ).be.false();
    should(tunnelServiceAvailable({ kind: 'ready', accounts: [] }, new Map(), 0)).be.false();
  });
});

describe('tunnel challenges', () => {
  const nonce = (fill: number) => new Uint8Array(NONCE_BYTES).fill(fill);

  it('should issue a nonce, spend it once, and refuse it a second time', () => {
    const issued = issueTunnelChallenge([], daemonA, nonce(1), 1_000);
    should(issued.ok).be.true();
    if (!issued.ok) return;
    should(issued.nonce).equal(toBase64Url(nonce(1)));
    const first = spendTunnelChallenge(issued.book, daemonA, issued.nonce, 2_000);
    should(first.valid).be.true();
    should(spendTunnelChallenge(first.book, daemonA, issued.nonce, 2_000).valid).be.false();
  });

  it('should refuse a nonce issued to another daemon, or one past its deadline', () => {
    const issued = issueTunnelChallenge([], daemonA, nonce(1), 0);
    if (!issued.ok) throw new Error('expected a nonce');
    should(spendTunnelChallenge(issued.book, daemonB, issued.nonce, 1).valid).be.false();
    const late = spendTunnelChallenge(issued.book, daemonA, issued.nonce, 60_000);
    should(late).eql({ valid: false, book: [] });
  });

  it('should drop entries from the future, which a clock that stepped back would otherwise keep for ever', () => {
    const book: TunnelChallengeBook = [{ daemonId: daemonA, nonce: 'x', issuedAt: 10_000, spent: false }];
    should(spendTunnelChallenge(book, daemonA, 'x', 5_000).book).eql([]);
  });

  it('should bound outstanding nonces per daemon', () => {
    let book: TunnelChallengeBook = [];
    for (let index = 0; index < TUNNEL_CHALLENGE_LIMITS.outstandingPerDaemon; index += 1) {
      const issued = issueTunnelChallenge(book, daemonA, nonce(index), 0);
      should(issued.ok).be.true();
      book = issued.book;
    }
    const refused = issueTunnelChallenge(book, daemonA, nonce(9), 0);
    should(refused.ok === false && refused.reason).equal('this machine holds too many unspent challenges');
    should(issueTunnelChallenge(book, daemonB, nonce(9), 0).ok).be.true();
  });

  it('should bound issues per daemon per window even when every nonce was spent', () => {
    const book: TunnelChallengeBook = Array.from(
      { length: TUNNEL_CHALLENGE_LIMITS.issuedPerDaemonPerWindow },
      (_, at) => ({
        daemonId: daemonA,
        nonce: `n${at}`,
        issuedAt: 0,
        spent: true,
      }),
    );
    const refused = issueTunnelChallenge(book, daemonA, nonce(1), 1);
    should(refused.ok === false && refused.reason).match(/this machine asked for too many challenges/);
    should(issueTunnelChallenge(book, daemonA, nonce(1), 60_000).ok).be.true();
  });

  it('should bound issues across the whole service per window', () => {
    const book: TunnelChallengeBook = Array.from(
      { length: TUNNEL_CHALLENGE_LIMITS.issuedGlobalPerWindow },
      (_, at) => ({
        daemonId: `fy_daemon_${String(at).padStart(43, 'c')}`,
        nonce: `n${at}`,
        issuedAt: 0,
        spent: false,
      }),
    );
    const refused = issueTunnelChallenge(book, daemonA, nonce(1), 1);
    should(refused.ok === false && refused.reason).match(/the tunnel service is issuing too many challenges/);
  });
});

describe('tunnel reclaim verdicts', () => {
  const settings = DEFAULT_TUNNEL_SETTINGS;
  const window = settings.reclaimAfterDays * TUNNEL_DAY_MILLISECONDS;

  it('should keep a renewed row, retire a stale one, and leave an orphan alone', () => {
    should(tunnelRowVerdict(row(), account(), settings, window - 1)).equal('keep');
    should(tunnelRowVerdict(row(), account(), settings, window)).equal('retire');
    should(tunnelRowVerdict(row(), null, settings, window * 10)).equal('orphaned');
    should(tunnelRowVerdict(row(), account(), { reclaimAfterDays: 1 }, TUNNEL_DAY_MILLISECONDS)).equal('retire');
  });

  it('should retire an unfinished row after a day', () => {
    const unfinished = row({ dnsRecordId: null });
    should(tunnelRowVerdict(unfinished, account(), settings, TUNNEL_INCOMPLETE_RECLAIM_MILLISECONDS - 1)).equal('keep');
    should(tunnelRowVerdict(unfinished, account(), settings, TUNNEL_INCOMPLETE_RECLAIM_MILLISECONDS)).equal('retire');
  });
});

describe('the operator tunnel status', () => {
  it('should project accounts, orphans and damage, and never a token', () => {
    const live = account();
    const draining = account({ name: 'pool-b', accountId: 'c'.repeat(32), accepting: false, maxTunnels: 5 });
    const status = tunnelOperatorStatus(
      { kind: 'ready', accounts: [live, draining] },
      DEFAULT_TUNNEL_SETTINGS,
      new Map([[live.accountId, verdict(true, 0)]]),
      {
        liveByAccountId: new Map([[live.accountId, 3]]),
        orphanedRows: [
          { account: 'gone', accountId: 'd'.repeat(32) },
          { account: 'gone', accountId: 'd'.repeat(32) },
          { account: 'other', accountId: 'e'.repeat(32) },
        ],
        pendingDeletions: 1,
        damagedRows: 2,
      },
      1,
    );
    should(TunnelOperatorStatusSchema.parse(status)).eql(status);
    should(status.available).be.true();
    should(status.accounts).eql([
      { name: 'pool-a', zone: live.zone, accepting: true, maxTunnels: 1000, liveTunnels: 3, zoneCheck: 'passed' },
      { name: 'pool-b', zone: draining.zone, accepting: false, maxTunnels: 5, liveTunnels: 0, zoneCheck: 'unchecked' },
    ]);
    should(status.orphaned).eql([
      { account: 'gone', accountId: 'd'.repeat(32), tunnels: 2 },
      { account: 'other', accountId: 'e'.repeat(32), tunnels: 1 },
    ]);
    should(JSON.stringify(status)).not.containEql(SECRET);
  });

  it('should say why an unusable pool is off', () => {
    const census = { liveByAccountId: new Map(), orphanedRows: [], pendingDeletions: 0, damagedRows: 0 };
    const status = tunnelOperatorStatus(
      { kind: 'invalid', reason: 'bad' },
      DEFAULT_TUNNEL_SETTINGS,
      new Map(),
      census,
      0,
    );
    should(status).match({ available: false, pool: 'invalid', poolProblem: 'bad', accounts: [] });
    should(
      tunnelOperatorStatus({ kind: 'absent' }, DEFAULT_TUNNEL_SETTINGS, new Map(), census, 0).poolProblem,
    ).be.null();
  });

  it('should map every refusal code to the status §15 gives it', () => {
    const statuses: Record<TunnelRefusalCode, number> = {
      tunnel_bad_request: 400,
      tunnel_claim_rejected: 401,
      tunnel_challenge_expired: 401,
      tunnel_rate_limited: 429,
      tunnel_upstream_failed: 502,
      tunnel_unavailable: 503,
      tunnel_capacity: 503,
    };
    for (const [code, status] of Object.entries(statuses)) {
      should(tunnelRefusalStatus(code as TunnelRefusalCode)).equal(status);
    }
  });
});
