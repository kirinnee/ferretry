import { describe, it } from 'bun:test';
import should from 'should';
import { FileCatalogMembersStore, FileCatalogSharesStore } from '../../../src/adapters/catalog-members/file-store.ts';
import {
  EMPTY_MEMBERS_DOCUMENT,
  EMPTY_SHARES_DOCUMENT,
  type MembersDocument,
  type SharesDocument,
} from '../../../src/lib/catalog-members/document.ts';
import { CatalogMemberRefusal } from '../../../src/lib/catalog-members/refusal.ts';
import type { FileSystemPort, FoundationPaths } from '../../../src/lib/index.ts';

/** The three file calls the stores make, held in memory, with the order they were made in. */
class FakeFiles {
  readonly files = new Map<string, string>();
  readonly calls: string[] = [];
  failWriteWith: Error | undefined;

  async readText(path: string): Promise<string | undefined> {
    return this.files.get(path);
  }
  async ensureDirectory(path: string, mode: number): Promise<void> {
    this.calls.push(`ensureDirectory ${path} ${mode.toString(8)}`);
  }
  async writeTextAtomic(path: string, text: string): Promise<void> {
    this.calls.push(`writeTextAtomic ${path}`);
    if (this.failWriteWith !== undefined) throw this.failWriteWith;
    this.files.set(path, text);
  }
  async setMode(path: string, mode: number): Promise<void> {
    this.calls.push(`setMode ${path} ${mode.toString(8)}`);
  }
}

const PATHS = {
  catalogs: '/state/catalogs',
  catalogMembers: '/state/catalogs/members.json',
  catalogShares: '/state/catalogs/shares.json',
  catalogMembersBeforeUniqueNames: '/state/catalogs/members.before-unique-names.json',
} as unknown as FoundationPaths;

const SPKI = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.alloc(32, 1)]).toString('base64url');
const BOX = Buffer.alloc(32, 7).toString('base64url');
const AT = '2026-01-01T00:00:00.000Z';

const MEMBERS: MembersDocument = {
  schemaVersion: 1,
  members: [
    {
      memberId: `mbr_${'m'.repeat(22)}`,
      label: 'Alice',
      catalogIds: [`cat_${'c'.repeat(22)}`],
      createdAt: AT,
      keys: [
        {
          keyId: `mk_${'k'.repeat(22)}`,
          memberKey: SPKI,
          boxKey: BOX,
          clientName: 'Firefox on a Mac',
          joinedAt: AT,
          passkeyCount: 0,
        },
      ],
    },
  ],
};

const SHARES: SharesDocument = {
  schemaVersion: 1,
  shares: [
    {
      shareId: `shr_${'s'.repeat(22)}`,
      codeSha256: 'ab'.repeat(32),
      memberId: `mbr_${'m'.repeat(22)}`,
      memberLabel: 'Alice',
      memberKind: 'new',
      catalogIds: [`cat_${'c'.repeat(22)}`],
      createdAt: AT,
      expiresAt: '2026-01-01T01:00:00.000Z',
      uses: { kind: 'single' },
      used: 0,
      state: 'live',
      usedBy: [],
      successes: [],
    },
  ],
};

function build() {
  const files = new FakeFiles();
  const port = files as unknown as FileSystemPort;
  return {
    files,
    members: new FileCatalogMembersStore(PATHS, port),
    shares: new FileCatalogSharesStore(PATHS, port),
  };
}

const failure = async (work: () => Promise<unknown>): Promise<CatalogMemberRefusal> => {
  try {
    await work();
  } catch (error) {
    if (error instanceof CatalogMemberRefusal) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

describe('the members store', () => {
  it('reads as nobody on a machine that has never shared', async () => {
    const { members } = build();

    should(await members.read()).deepEqual(EMPTY_MEMBERS_DOCUMENT);
  });

  it('writes the folder 0700, the file atomically, then 0600, and reads back what it wrote', async () => {
    const { files, members } = build();

    await members.write(MEMBERS);

    should(files.calls).deepEqual([
      'ensureDirectory /state/catalogs 700',
      'writeTextAtomic /state/catalogs/members.json',
      'setMode /state/catalogs/members.json 600',
    ]);
    should(files.files.get(PATHS.catalogMembers)?.endsWith('}\n')).equal(true);
    should(await members.read()).deepEqual(MEMBERS);
  });

  it('refuses a file that is not JSON, naming it, and does not call it empty', async () => {
    const { files, members } = build();
    files.files.set(PATHS.catalogMembers, '{ not json');

    const refusal = await failure(async () => await members.read());

    should(refusal.refusal).equal('store_damaged');
    should(refusal.message).startWith('members.json cannot be read: it is not JSON.');
    should(refusal.message).containEql('Nothing was changed.');
    should(files.files.get(PATHS.catalogMembers)).equal('{ not json');
  });

  it('refuses JSON the schema does not accept, saying what and where', async () => {
    const { files, members } = build();
    files.files.set(PATHS.catalogMembers, JSON.stringify({ schemaVersion: 99, members: [] }));

    const refusal = await failure(async () => await members.read());

    should(refusal.refusal).equal('store_damaged');
    should(refusal.message).startWith('members.json cannot be read: ');
    should(refusal.message).containEql('(at schemaVersion)');
  });

  it('refuses a member listed twice by its cross-check, not a silent grant', async () => {
    const { files, members } = build();
    const twice = { ...MEMBERS, members: [MEMBERS.members[0], MEMBERS.members[0]] };
    files.files.set(PATHS.catalogMembers, JSON.stringify(twice));

    const refusal = await failure(async () => await members.read());

    should(refusal.message).containEql('is listed twice');
  });

  it('lets a failed write through as it is and leaves the old file', async () => {
    const { files, members } = build();
    await members.write(MEMBERS);
    files.failWriteWith = new Error('read-only file system');

    const thrown = await members.write(EMPTY_MEMBERS_DOCUMENT).then(
      () => undefined,
      (error: unknown) => error,
    );

    should((thrown as Error).message).equal('read-only file system');
    should(await members.read()).deepEqual(MEMBERS);
    should(files.calls.filter(call => call.startsWith('setMode'))).have.length(1);
  });
});

describe('the members store: names that were not yet IDs', () => {
  const twin = (label: string, createdAt: string) => ({
    ...MEMBERS.members[0],
    memberId: `mbr_${label === 'Alice' ? 'a' : 'b'}${'m'.repeat(21)}`,
    keys: [],
    label,
    createdAt,
  });
  const OLD = JSON.stringify({ ...MEMBERS, members: [twin('alice', '2026-02-01T00:00:00.000Z'), twin('Alice', AT)] });

  it('reads a file with two people of one name as the later one renamed, and writes nothing yet', async () => {
    const { files, members } = build();
    files.files.set(PATHS.catalogMembers, OLD);

    const document = await members.read();

    should(document.members.map(member => member.label)).deepEqual(['alice (2)', 'Alice']);
    should(files.calls).deepEqual([]);
    should(files.files.get(PATHS.catalogMembers)).equal(OLD);
  });

  it('hands over the rename once, and commits it with the original put aside first', async () => {
    const { files, members } = build();
    files.files.set(PATHS.catalogMembers, OLD);
    await members.read();

    const upgrade = members.takeUpgrade();
    await upgrade?.commit();

    should(upgrade?.renames.map(rename => rename.to)).deepEqual(['alice (2)']);
    should(members.takeUpgrade()).equal(undefined);
    should(files.calls.filter(call => call.startsWith('writeTextAtomic'))).deepEqual([
      'writeTextAtomic /state/catalogs/members.before-unique-names.json',
      'writeTextAtomic /state/catalogs/members.json',
    ]);
    should(files.files.get(PATHS.catalogMembersBeforeUniqueNames)).equal(OLD);
    should((await members.read()).members.map(member => member.label)).deepEqual(['alice (2)', 'Alice']);
    should(members.takeUpgrade()).equal(undefined);
  });

  it('repeats the rename when the write never happened, and the file on disk is still the old one', async () => {
    const { files, members } = build();
    files.files.set(PATHS.catalogMembers, OLD);
    await members.read();
    files.failWriteWith = new Error('read-only file system');
    const crash = await members
      .takeUpgrade()
      ?.commit()
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    should((crash as Error).message).equal('read-only file system');
    should(files.files.get(PATHS.catalogMembers)).equal(OLD);
    files.failWriteWith = undefined;
    await members.read();
    should(members.takeUpgrade()?.renames).have.length(1);
  });

  it('has nothing to hand over for a file whose names were already unique', async () => {
    const { files, members } = build();
    files.files.set(PATHS.catalogMembers, JSON.stringify(MEMBERS));

    await members.read();

    should(members.takeUpgrade()).equal(undefined);
  });

  it('still refuses a file that is wrong in any other way', async () => {
    const { files, members } = build();
    files.files.set(PATHS.catalogMembers, JSON.stringify({ ...MEMBERS, members: [{ memberId: 'x' }] }));

    const refusal = await failure(async () => await members.read());

    should(refusal.refusal).equal('store_damaged');
  });
});

describe('the shares store', () => {
  it('reads as no shares on a machine that has never shared', async () => {
    const { shares } = build();

    should(await shares.read()).deepEqual(EMPTY_SHARES_DOCUMENT);
  });

  it('writes the folder 0700, the file atomically, then 0600, and reads back what it wrote', async () => {
    const { files, shares } = build();

    await shares.write(SHARES);

    should(files.calls).deepEqual([
      'ensureDirectory /state/catalogs 700',
      'writeTextAtomic /state/catalogs/shares.json',
      'setMode /state/catalogs/shares.json 600',
    ]);
    should(await shares.read()).deepEqual(SHARES);
  });

  it('refuses a file that is not JSON', async () => {
    const { files, shares } = build();
    files.files.set(PATHS.catalogShares, 'nope');

    const refusal = await failure(async () => await shares.read());

    should(refusal.refusal).equal('store_damaged');
    should(refusal.message).startWith('shares.json cannot be read: it is not JSON.');
  });

  it('refuses JSON the schema does not accept', async () => {
    const { files, shares } = build();
    files.files.set(PATHS.catalogShares, JSON.stringify({ schemaVersion: 1, shares: [{ shareId: 'x' }] }));

    const refusal = await failure(async () => await shares.read());

    should(refusal.refusal).equal('store_damaged');
    should(refusal.message).startWith('shares.json cannot be read: ');
  });

  it('refuses two shares with the same code hash', async () => {
    const { files, shares } = build();
    const second = { ...SHARES.shares[0], shareId: `shr_${'t'.repeat(22)}` };
    files.files.set(PATHS.catalogShares, JSON.stringify({ ...SHARES, shares: [SHARES.shares[0], second] }));

    const refusal = await failure(async () => await shares.read());

    should(refusal.message).containEql('has the same code as another share');
  });

  it('keeps no code: a share is its hash and nothing it could be spent with', async () => {
    const { files, shares } = build();

    await shares.write(SHARES);

    should(files.files.get(PATHS.catalogShares)).not.containEql('fy_share_');
  });
});
