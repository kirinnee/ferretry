import { expect, it } from 'bun:test';
import { LoginDirectory } from '../../../daemon/lib/logins.ts';
import { CountingSealed, FakeSecretCipher, MemoryLoginIndex, CLOCK, daemonOver, plantSeed, SEED } from './support.ts';
import {
  type AccountIndexDocument,
  AccountIndexDocumentSchema,
  chosenSignIn,
  signInMatches,
} from '../../../contract/routes/index.ts';
import { padInputValue } from '../../../contract/routes/index.ts';
import { TwoFactorSeedStages } from '../../../daemon/lib/two-factor-seeds.ts';

const PASSWORD = 'synthetic-boundary-password';
const place = { kind: 'site', domains: ['example.com'], match: ['work.example'] } as const;
function world() {
  const index = new MemoryLoginIndex();
  const sealed = new CountingSealed();
  const logins = new LoginDirectory(index, sealed, new FakeSecretCipher(), CLOCK);
  return { index, sealed, logins, directory: logins.accounts };
}

it('I138 changing a field identity at the same place drops its old facts in the account store', async () => {
  const w = world();
  await w.directory.putAccount('SITE', { label: 'Site' });
  const si = await w.directory.addSignIn('SITE', { place });
  await w.directory.observeSignIn(si.id, {
    at: 'example.com',
    surface: 'page',
    identity: '0123456789abcdef',
    masked: true,
    navigatedAway: true,
    tapped: true,
  });
  await w.directory.observeSignIn(si.id, {
    at: 'example.com',
    surface: 'page',
    identity: 'fedcba9876543210',
    masked: false,
  });
  const fact = (await w.directory.list()).signIns[0]?.observed?.[0];
  expect(fact?.identity).toBe('fedcba9876543210');
  expect(fact?.navigatedAway).toBeUndefined();
  expect(fact?.tapped).toBeUndefined();
  expect(fact?.masked?.count).toBe(1);
});

it('I147 checks new/update save choices under the production store lock and overwrites nothing after a lost new-account race', async () => {
  const w = world();
  const outcomes = await Promise.allSettled([
    w.logins.saveFields('SITE', 'Site', 'example.com', { username: 'first', password: PASSWORD }, 'new'),
    w.logins.saveFields(
      'SITE',
      'Site',
      'example.com',
      { username: 'other', password: 'another-synthetic-password' },
      'new',
    ),
  ]);
  expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect((await w.directory.list()).accounts[0]?.username).toBe('first');
  await expect(
    w.logins.saveFields(
      'SITE',
      'Site',
      'example.com',
      { username: 'other', password: 'another-synthetic-password' },
      'update',
      'other',
    ),
  ).rejects.toMatchObject({ refusal: 'invalid_change' });
  expect((await w.directory.list()).accounts[0]?.username).toBe('first');
});

it('I151 account writes and card saves share one store-wide read-merge-write queue', async () => {
  const w = world();
  await Promise.all(
    Array.from({ length: 16 }, (_, n) =>
      n % 2 === 0
        ? w.directory.putAccount(`SITE_${n}`, { label: `Site ${n}` })
        : w.logins.saveFields(
            `SITE_${n}`,
            `Site ${n}`,
            'example.com',
            { username: `person${n}`, password: PASSWORD },
            'new',
          ),
    ),
  );
  const listing = await w.directory.list();
  expect(listing.accounts).toHaveLength(16);
  expect(new Set(listing.accounts.map(account => account.id)).size).toBe(16);
  expect(listing.signIns).toHaveLength(8);
});

it('I153 a card username and password commit together, and a failed seal commits neither', async () => {
  const w = world();
  w.sealed.failing = true;
  await expect(
    w.logins.saveFields('SITE', 'Site', 'example.com', { username: 'fixture', password: PASSWORD }, 'new'),
  ).rejects.toThrow();
  expect(w.index.document).toBeUndefined();
  w.sealed.failing = false;
  await w.logins.saveFields('SITE', 'Site', 'example.com', { username: 'fixture', password: PASSWORD }, 'new');
  expect((await w.directory.list()).accounts[0]).toMatchObject({ username: 'fixture', fields: { password: true } });
  const vault = daemonOver(w.index, w.sealed).vault;
  expect(await vault.fill('SITE', 'password', 0)).toBe(PASSWORD);
});

it('I179 editing and renaming an account preserves its sign-in ids and the sealed password name', async () => {
  const w = world();
  await w.directory.putAccount('SITE', { label: 'Site', password: PASSWORD });
  const si = await w.directory.addSignIn('SITE', { place });
  const names = Object.keys((await w.sealed.read())!.entries);
  await w.directory.putSignIn(si.id, { recipe: 'Open the sign-in page' });
  await w.directory.renameAccount('SITE', 'RENAMED');
  const listing = await w.directory.list();
  expect(listing.signIns[0]?.id).toBe(si.id);
  expect(listing.signIns[0]?.account).toBe('RENAMED');
  expect(Object.keys((await w.sealed.read())!.entries)).toEqual(names);
});

it('I180 a site matches its exact login host and never its work-only host, parent, child or look-alike', () => {
  expect(signInMatches(place, 'example.com')).toBe(true);
  for (const key of ['work.example', 'sub.example.com', 'com', 'example.com.attacker.test', 'examplе.com', undefined])
    expect(signInMatches(place, key)).toBe(false);
});

it('I183 a hint or default cannot select an unmatched sign-in, and competing default lines choose neither', () => {
  const candidates = [
    { id: 'si_0000000000000001', account: 'ONE', place },
    { id: 'si_0000000000000002', account: 'TWO', place },
    {
      id: 'si_0000000000000003',
      account: 'ELSEWHERE',
      place: { kind: 'site', domains: ['elsewhere.test'], match: [] },
    },
  ] as const;
  expect(
    chosenSignIn('example.com', candidates, { hint: 'ELSEWHERE', defaults: { sites: { 'example.com': 'ELSEWHERE' } } }),
  ).toBeUndefined();
  const competing = [candidates[0], { ...candidates[1], place: { ...place, match: ['another.work'] } }];
  const defaults = { sites: { 'work.example': 'ONE', 'another.work': 'TWO' } };
  expect(chosenSignIn('example.com', competing, { defaults })).toBeUndefined();
  expect(chosenSignIn('example.com', [...competing].reverse(), { defaults })).toBeUndefined();
  expect(chosenSignIn(undefined, candidates, { hint: 'ONE' })).toBeUndefined();
});

it('I187 the index refuses excess keys/seeds, reused ids/seals, foreign-account seals and orphaned seed parameters', async () => {
  const w = world();
  await w.directory.putAccount('SITE', { label: 'Site', password: PASSWORD });
  await plantSeed(w.directory, 'SITE', SEED);
  const original = w.index.accounts;
  const factor = original.accounts.SITE!.factors![0]!;
  const mutate = (change: (document: AccountIndexDocument) => void) => {
    const document = structuredClone(original);
    change(document);
    expect(AccountIndexDocumentSchema.safeParse(document).success).toBe(false);
  };
  mutate(doc => {
    doc.accounts.SITE!.factors = Array.from({ length: 9 }, (_, n) => ({
      id: `tf_${n.toString(16).padStart(12, '0')}`,
      kind: 'sms',
      label: `Key ${n}`,
      addedAt: 't',
      addedBy: 'owner',
    }));
  });
  mutate(doc => {
    doc.accounts.SITE!.factors = [factor, { ...factor, label: 'Duplicate' }];
  });
  mutate(doc => {
    doc.accounts.SITE!.factors = [{ ...factor, id: 'tf_00000000000f', label: 'Other' }, factor];
  });
  mutate(doc => {
    doc.accounts.SITE!.factors = [{ ...factor, seal: 'LAAAAAAAAAAAAAAAAAAAAAAAA_TOTP_00000000' } as never];
  });
  mutate(doc => {
    const f = doc.accounts.SITE!.factors![0]!;
    if (f.kind === 'totp') delete f.seal;
  });
  mutate(doc => {
    const f = doc.accounts.SITE!.factors![0]!;
    if (f.kind === 'totp') delete f.params;
  });
  mutate(doc => {
    doc.accounts.SITE!.factors = Array.from(
      { length: 5 },
      (_, n) =>
        ({
          ...factor,
          id: `tf_${n.toString(16).padStart(12, '0')}`,
          label: `Seed ${n}`,
          seal: `${doc.accounts.SITE!.key}_TOTP_${n.toString(16).toUpperCase().padStart(8, '0')}`,
        }) as never,
    );
  });
});

it('I188 a sweep keeps the password and every seed still named by the account', async () => {
  const w = world();
  await w.directory.putAccount('SITE', { label: 'Site', password: PASSWORD });
  await plantSeed(w.directory, 'SITE', SEED);
  const key = (await w.directory.seedTarget('SITE')).key;
  await w.directory.addSeed(key, 'GEZDGNBVGY3TQOJQ', {
    params: { algorithm: 'SHA1', digits: 6, period: 30 },
    label: 'Backup',
  });
  const before = Object.keys((await w.sealed.read())!.entries).sort();
  await w.directory.prepare();
  expect(Object.keys((await w.sealed.read())!.entries).sort()).toEqual(before);
  expect(before).toHaveLength(3);
});

it('S95 the production stage ledger enforces caller, non-device and daemon limits while reserving a paired-device slot', async () => {
  const w = world();
  await w.directory.putAccount('SITE', { label: 'Site' });
  const stages = new TwoFactorSeedStages({
    accounts: w.directory,
    cipher: new FakeSecretCipher(),
    clock: { nowMs: () => 0 },
    anyPasskey: async () => true,
    hostName: 'fixture',
  });
  const request = { padded: padInputValue(SEED), totpAcknowledged: true as const };
  const first = { key: 'host-one', device: false };
  const second = { key: 'host-two', device: false };
  const device = { key: 'device:paired', device: true };
  await stages.stage('SITE', request, first);
  await stages.stage('SITE', request, first);
  await expect(stages.stage('SITE', request, first)).rejects.toMatchObject({ status: 429 });
  await stages.stage('SITE', request, second);
  await expect(stages.stage('SITE', request, second)).rejects.toMatchObject({ status: 429 });
  await stages.stage('SITE', request, device);
  await expect(stages.stage('SITE', request, device)).rejects.toMatchObject({ status: 429 });
});
