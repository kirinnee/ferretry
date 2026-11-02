import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CatalogShareMintRequest } from '@ferretry/protocol';
import should from 'should';
import {
  FileCatalogMembersStore,
  FileCatalogSharesStore,
  NodeShareCodeHasher,
} from '../../../src/adapters/catalog-members/index.ts';
import { StateFileSystem } from '../../../src/adapters/filesystem/state-file-system.ts';
import {
  CatalogMemberRefusal,
  CatalogMemberService,
  type NewMemberKey,
} from '../../../src/lib/catalog-members/index.ts';
import type { JoinReservation } from '../../../src/lib/catalog-members/admission.ts';
import { createFoundationPaths, resolveStateHome } from '../../../src/lib/index.ts';
import { crypto } from '../../unit/shared-catalogs/support.ts';

/**
 * Sharing under a real state home: the two files' modes, an atomic write, a restart that finds the same
 * people and the same spent code, a damaged file that is refused rather than emptied, and a code that is
 * never written to disk.
 */

const homes = new Set<string>();

afterEach(async () => {
  for (const home of homes) await rm(home, { recursive: true, force: true });
  homes.clear();
});

const CAT = `cat_${'c'.repeat(22)}`;
const OTHER_CAT = `cat_${'d'.repeat(22)}`;
const NOW = Date.UTC(2026, 0, 1);
const SPKI = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.alloc(32, 1)]).toString('base64url');
const BOX = Buffer.alloc(32, 7).toString('base64url');
const KEY: NewMemberKey = { memberKey: SPKI, boxKey: BOX, clientName: 'Firefox on a Mac' };
const MINT: CatalogShareMintRequest = {
  catalogIds: [CAT],
  member: { kind: 'new', label: 'Alice' },
  expiresIn: '1h',
  uses: { kind: 'single' },
};

const mode = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'ferretry-members-'));
  homes.add(home);
  const paths = createFoundationPaths(resolveStateHome({ fyHome: home, homeDirectory: home }));
  const files = new StateFileSystem(paths);
  const audited: unknown[] = [];
  const notices: unknown[] = [];
  /** A fresh service over the same disk: what a daemon restart builds. */
  const boot = () =>
    new CatalogMemberService({
      members: new FileCatalogMembersStore(paths, files),
      shares: new FileCatalogSharesStore(paths, files),
      hasher: new NodeShareCodeHasher(),
      crypto,
      catalogs: { knownIds: async () => new Set([CAT, OTHER_CAT]) },
      links: {
        target: () => ({
          kind: 'ready',
          appOrigin: 'https://app.example',
          daemonUrl: 'https://studio.example:8443',
          daemonId: `fy_daemon_${'D'.repeat(43)}`,
        }),
      },
      sessions: { closeMember: async () => undefined, closeKey: async () => undefined },
      audit: {
        record: async entry => {
          audited.push(entry);
        },
      },
      now: () => NOW,
      onRenamed: renames => {
        notices.push(renames);
      },
    });
  return { paths, audited, notices, boot };
}

/** Mints for a new person and joins one browser, as the admission step and the commit would. */
async function mintAndJoin(service: CatalogMemberService) {
  const minted = await service.mint(MINT);
  await service.ready();
  const admission = service.admitJoin(minted.code, NOW);
  if (!admission.ok) throw new Error(`the code was refused: ${admission.refusal}`);
  const joined = await service.commit(admission.reservation as JoinReservation, KEY);
  return { minted, joined };
}

describe('the sharing files on disk', () => {
  it('should list nobody and no shares on a machine that has never shared, and write nothing for it', async () => {
    const { boot, paths } = await fixture();

    const service = boot();

    should(await service.listMembers()).deepEqual({ members: [] });
    should(await service.listShares()).deepEqual({ shares: [] });
    should(await readdir(paths.catalogs).catch(() => [])).deepEqual([]);
  });

  it('should write both files 0600 in a 0700 folder, with no temporary file left behind', async () => {
    const { boot, paths } = await fixture();

    await mintAndJoin(boot());

    should(await mode(paths.catalogMembers)).equal(0o600);
    should(await mode(paths.catalogShares)).equal(0o600);
    should(await mode(paths.catalogs)).equal(0o700);
    should((await readdir(paths.catalogs)).filter(name => name.includes('tmp'))).deepEqual([]);
  });

  it('should never write the code, or a link to it, into either file', async () => {
    const { boot, paths } = await fixture();

    const { minted } = await mintAndJoin(boot());
    const members = await readFile(paths.catalogMembers, 'utf8');
    const shares = await readFile(paths.catalogShares, 'utf8');

    should(minted.code).match(/^fy_share_[A-Za-z0-9_-]{22}$/u);
    for (const text of [members, shares]) {
      should(text).not.containEql(minted.code);
      should(text).not.containEql('fy_share_');
      should(text).not.containEql('/join');
    }
    should(JSON.parse(shares).shares[0].codeSha256).equal(new NodeShareCodeHasher().hex(minted.code));
  });

  it('should hold the same person and the same spent code after a restart', async () => {
    const { boot } = await fixture();
    const first = boot();
    const { minted, joined } = await mintAndJoin(first);

    const restarted = boot();
    const members = await restarted.listMembers();
    const shares = await restarted.listShares();
    await restarted.ready();
    const again = restarted.admitJoin(minted.code, NOW);

    should(members.members).have.length(1);
    should(members.members[0]?.memberId).equal(joined.memberId);
    should(members.members[0]?.label).equal('Alice');
    should(members.members[0]?.catalogIds).deepEqual([CAT]);
    should(members.members[0]?.keys.map(key => key.keyId)).deepEqual([joined.keyId]);
    should(members.members[0]?.keys[0]?.clientName).equal('Firefox on a Mac');
    should(shares.shares[0]?.state).equal('spent');
    should(again.ok).equal(false);
  });

  it('should keep a code spent even though the join that spent it never committed', async () => {
    const { boot, paths } = await fixture();
    const first = boot();
    const minted = await first.mint(MINT);
    await first.ready();
    const admission = first.admitJoin(minted.code, NOW);
    if (!admission.ok) throw new Error('the code was refused');
    await first.release(admission.reservation);

    const restarted = boot();
    await restarted.ready();

    should(restarted.admitJoin(minted.code, NOW).ok).equal(false);
    should(JSON.parse(await readFile(paths.catalogShares, 'utf8')).shares[0].used).equal(1);
  });

  it('should remember an ended share across a restart', async () => {
    const { boot } = await fixture();
    const first = boot();
    const minted = await first.mint(MINT);
    await first.endShare(minted.share.shareId);

    const restarted = boot();
    await restarted.ready();

    should((await restarted.listShares()).shares[0]?.state).equal('ended');
    should(restarted.admitJoin(minted.code, NOW).ok).equal(false);
  });

  it('should forget a deleted catalog in both files, and keep the person', async () => {
    const { boot, paths } = await fixture();
    const first = boot();
    const minted = await first.mint({ ...MINT, catalogIds: [CAT, OTHER_CAT] });
    await first.mint({ ...MINT, member: { kind: 'new', label: 'Bob' }, catalogIds: [CAT, OTHER_CAT] });
    await first.ready();
    const admission = first.admitJoin(minted.code, NOW);
    if (!admission.ok) throw new Error('the code was refused');
    const joined = await first.commit(admission.reservation as JoinReservation, KEY);

    await first.forgetCatalog(OTHER_CAT);
    const members = JSON.parse(await readFile(paths.catalogMembers, 'utf8'));
    const shares = JSON.parse(await readFile(paths.catalogShares, 'utf8'));

    should(joined.catalogCount).equal(2);
    should(members.members).have.length(1);
    should(members.members[0].catalogIds).deepEqual([CAT]);
    should(shares.shares.length).be.above(0);
    for (const share of shares.shares) should(share.catalogIds).not.containEql(OTHER_CAT);
  });

  it('should take a revoked person off disk, with their browsers and the shares that named them', async () => {
    const { boot, paths } = await fixture();
    const first = boot();
    const { joined } = await mintAndJoin(first);

    const revoked = await first.revokeMember(joined.memberId);
    const restarted = boot();

    should(revoked).deepEqual({ memberId: joined.memberId, keysRemoved: 1, sharesEnded: 0 });
    should((await restarted.listMembers()).members).deepEqual([]);
    should(JSON.parse(await readFile(paths.catalogMembers, 'utf8')).members).deepEqual([]);
  });

  it('should refuse a members file that is not JSON, leave it alone, and not call it empty', async () => {
    const { boot, paths } = await fixture();
    await mintAndJoin(boot());
    await writeFile(paths.catalogMembers, '{ not json');

    const failure = await boot()
      .listMembers()
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    should(failure).be.instanceOf(CatalogMemberRefusal);
    should(failure).have.property('refusal', 'store_damaged');
    should((failure as Error).message).containEql('members.json cannot be read');
    should(await readFile(paths.catalogMembers, 'utf8')).equal('{ not json');
  });

  it('should refuse a shares file the schema does not accept, and mint nothing on top of it', async () => {
    const { boot, paths } = await fixture();
    await mintAndJoin(boot());
    await writeFile(paths.catalogShares, JSON.stringify({ schemaVersion: 99, shares: [] }));

    const failure = await boot()
      .mint(MINT)
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    should(failure).have.property('refusal', 'store_damaged');
    should((failure as Error).message).containEql('shares.json cannot be read');
    should(JSON.parse(await readFile(paths.catalogShares, 'utf8')).schemaVersion).equal(99);
  });

  it('should write nothing when the owner only looks', async () => {
    const { boot, paths } = await fixture();
    await mintAndJoin(boot());
    const before = [await readFile(paths.catalogMembers, 'utf8'), await readFile(paths.catalogShares, 'utf8')];

    const looking = boot();
    await looking.listMembers();
    await looking.listShares();

    should([await readFile(paths.catalogMembers, 'utf8'), await readFile(paths.catalogShares, 'utf8')]).deepEqual(
      before,
    );
  });

  it('should keep the code out of every audit record the service wrote', async () => {
    const { boot, audited } = await fixture();

    const { minted } = await mintAndJoin(boot());

    should(JSON.stringify(audited)).not.containEql(minted.code);
  });
});

describe('names that were not yet IDs, on a real disk', () => {
  const AT = '2026-01-01T00:00:00.000Z';
  const person = (letter: string, label: string, createdAt: string) => ({
    memberId: `mbr_${letter.repeat(22)}`,
    label,
    catalogIds: [CAT],
    createdAt,
    keys: [],
  });
  const legacy = (): string =>
    JSON.stringify({
      schemaVersion: 1,
      members: [person('a', 'alice', AT), person('b', 'Alice', '2026-02-01T00:00:00.000Z')],
    });
  const labelsOn = async (path: string): Promise<string[]> =>
    (JSON.parse(await readFile(path, 'utf8')).members as { label: string }[]).map(member => member.label);

  async function legacyFixture(text: string = legacy()) {
    const made = await fixture();
    await mkdir(made.paths.catalogs, { recursive: true, mode: 0o700 });
    await writeFile(made.paths.catalogMembers, text);
    return made;
  }

  it('should rename the later person once, put the original aside first, and tell the owner and the audit once', async () => {
    const { boot, paths, audited, notices } = await legacyFixture();
    const before = legacy();

    const service = boot();
    await service.ready();
    const restarted = boot();
    await restarted.ready();

    should(await labelsOn(paths.catalogMembers)).deepEqual(['alice', 'Alice (2)']);
    should(await readFile(paths.catalogMembersBeforeUniqueNames, 'utf8')).equal(before);
    should(await mode(paths.catalogMembers)).equal(0o600);
    should(await mode(paths.catalogMembersBeforeUniqueNames)).equal(0o600);
    should(notices).have.length(1);
    should(audited).have.length(1);
    should(JSON.stringify(audited)).not.containEql('Alice');
  });

  it('should keep the first original when a second file of duplicates is upgraded later', async () => {
    const { boot, paths } = await legacyFixture();
    const first = legacy();
    await boot().ready();
    const later = JSON.stringify({
      schemaVersion: 1,
      members: [person('c', 'Sam', AT), person('d', 'sam', '2026-03-01T00:00:00.000Z')],
    });
    await writeFile(paths.catalogMembers, later);

    await boot().ready();

    should(await readFile(paths.catalogMembersBeforeUniqueNames, 'utf8')).equal(first);
    should(await readFile(paths.catalogMembersBeforeUniqueNames.replace(/\.json$/u, '.2.json'), 'utf8')).equal(later);
    should(await labelsOn(paths.catalogMembers)).deepEqual(['Sam', 'sam (2)']);
  });

  it('should not load, and leave the file as it was, when the original cannot be put aside', async () => {
    const { boot, paths, audited, notices } = await legacyFixture();
    await mkdir(paths.catalogMembersBeforeUniqueNames);

    const failure = await boot()
      .ready()
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    should(failure).be.instanceOf(Error);
    should(await readFile(paths.catalogMembers, 'utf8')).equal(legacy());
    should(notices).deepEqual([]);
    should(audited).deepEqual([]);
  });
});
