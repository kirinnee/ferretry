import { describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { RelocateRefused } from '../../daemon/lib/relocation.ts';
import { CheckoutError, type Checkout } from '../../daemon/lib/checkout.ts';
import { verifiedOfferKey } from '../../daemon/lib/seal.ts';
import { CONVERSATION, FERRET } from '../support/fake-ferrets.ts';
import { crypto } from '../support/identity.ts';
import { git, snapshotOf } from '../support/real-git.ts';
import { NEW_FERRET, targetWorld } from '../support/target.ts';
import { world } from '../support/world.ts';
import { openBundle } from '../support/open-bundle.ts';

const refusal = async (work: Promise<unknown>): Promise<RelocateRefused> => {
  try {
    await work;
  } catch (error) {
    if (error instanceof RelocateRefused) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

/** The files a move carries: the source's tree minus what git ignores and what is named like a secret. */
const carried = (source: Map<string, string>): Map<string, string> =>
  new Map(
    [...source].filter(
      ([path]) => !path.startsWith('node_modules/') && !['.env', '.env.local', 'deploy.pem'].includes(path),
    ),
  );

describe('importing a bundle on the target', () => {
  test('the fixture imports to identical files, the same HEAD and the same diff', async () => {
    const w = await world();
    const t = await targetWorld({}, w.fixture.remote);
    const { offerId, header } = await t.carry(w);
    const done = await t.importer.import(offerId, { header, sourceDaemonId: header.sourceDaemonId });

    expect(done.ferretId).toBe(NEW_FERRET);
    expect(git(done.folder, 'rev-parse', 'HEAD')).toBe(git(w.fixture.folder, 'rev-parse', 'HEAD'));
    expect(git(done.folder, 'diff', 'HEAD')).toBe(git(w.fixture.folder, 'diff', 'HEAD'));
    expect(snapshotOf(done.folder)).toEqual(carried(snapshotOf(w.fixture.folder)));
    expect(git(done.folder, 'branch', '--show-current').trim()).toStartWith('main-moved-');
    // the ferret was started in the new working tree, on the conversation the source packed, by the person
    const request = t.started[0];
    expect(request?.folder).toBe(done.folder);
    expect(request?.by).toBe('owner');
    expect(request?.harness).toBe('claude-code');
    expect(request?.runtime).toBe('claude-default');
    expect(request?.name).toBe('Mover');
    expect(request?.relocated?.relPath).toBe(CONVERSATION.relPath);
    expect(new TextDecoder().decode(request?.relocated?.bytes)).toBe(CONVERSATION.text);
    // where it came from is kept
    expect(t.recorded.get(NEW_FERRET)).toMatchObject({ daemonId: w.sourceIdentity.daemonId, ferretId: FERRET });
    expect(done.movedFrom).toEqual({ daemonId: w.sourceIdentity.daemonId, ferretId: FERRET });
  });

  test('no secret value and no ignored file reaches the target', async () => {
    const known = new Map<string, string>();
    const w = await world({ knownSecrets: known });
    Object.values(w.fixture.secrets).forEach((value, i) => {
      known.set(`FIXTURE_${String(i)}`, value);
    });
    // Check the actual transferred session/transcript entries as well as the materialized working files (U16 restores them).
    const audit = await world({ knownSecrets: known });
    const offer = await audit.offer();
    const exported = await audit.relocation.export(FERRET, offer.offer);
    const packed = await openBundle(
      offer.privateKey,
      offer.offer.offerId,
      exported.header,
      Array.from({ length: exported.header.chunks }, (_, i) => audit.relocation.chunk(exported.exportId, i)),
    );
    expect(packed?.files.has('session:turns/turn-001.md')).toBe(true);
    expect(packed?.files.has(`conversation:${CONVERSATION.relPath}`)).toBe(true);
    for (const value of Object.values(w.fixture.secrets))
      expect(Buffer.from(packed?.plaintext ?? []).includes(Buffer.from(value))).toBe(false);
    const t = await targetWorld({}, w.fixture.remote);
    const { offerId, header } = await t.carry(w);
    const done = await t.importer.import(offerId, { header, sourceDaemonId: header.sourceDaemonId });
    const landed = [...snapshotOf(done.folder).values()].join('\n');
    for (const value of Object.values(w.fixture.secrets)) expect(landed).not.toContain(value);
    expect(snapshotOf(done.folder).has('.env')).toBe(false);
  });
});

describe('what is refused before anything is written', () => {
  test('a project with no matching remote and no git account is refused at preflight, and at import', async () => {
    const w = await world();
    const t = await targetWorld({ project: false, accounts: 0 }, w.fixture.remote);
    const needs = (await w.relocation.preflight(FERRET, t.daemonId)).needs;
    const offer = await t.offers.open();
    const looked = await t.importer.preflight(offer.offerId, { needs });
    expect(looked.ok).toBe(false);
    expect(looked.project).toBe('none');
    expect(looked.refusals.join(' ')).toContain('no git account');

    const before = t.shape();
    const second = await targetWorld({ project: false, accounts: 0 }, w.fixture.remote);
    const carriedOver = await second.carry(w);
    const refused = await refusal(
      second.importer.import(carriedOver.offerId, {
        header: carriedOver.header,
        sourceDaemonId: carriedOver.header.sourceDaemonId,
      }),
    );
    expect(refused.status).toBe(409);
    expect(refused.code).toBe('move_refused');
    expect(second.started).toEqual([]);
    expect(t.shape()).toEqual(before);
    expect(second.shape().folders).toEqual(['managed-worktrees']);
  });

  test('with an account but no folder to clone into it says so; with one, the preflight offers the clone', async () => {
    const w = await world();
    const t = await targetWorld({ project: false, accounts: 1 }, w.fixture.remote);
    const needs = (await w.relocation.preflight(FERRET, t.daemonId)).needs;
    const offer = await t.offers.open();
    const asked = await t.importer.preflight(offer.offerId, { needs });
    expect(asked.ok).toBe(false);
    expect(asked.refusals.join(' ')).toContain('choose a folder to clone');
    const clone = await t.importer.preflight(offer.offerId, { needs, cloneInto: join(t.root, 'clones') });
    expect(clone).toMatchObject({ ok: true, project: 'clone' });
  });

  test('a missing ${secret:NAME} is refused at preflight, naming it', async () => {
    const w = await world();
    const needs = { ...(await w.relocation.preflight(FERRET, 'x')).needs, secrets: ['API_TOKEN', 'DB_URL'] };
    const without = await targetWorld({ secrets: ['DB_URL'] }, w.fixture.remote);
    const offer = await without.offers.open();
    const looked = await without.importer.preflight(offer.offerId, { needs });
    expect(looked.ok).toBe(false);
    expect(looked.missingSecrets).toEqual(['API_TOKEN']);
    expect(looked.refusals.join(' ')).toContain('API_TOKEN');
    expect(looked.refusals.join(' ')).not.toContain('DB_URL');
    const having = await targetWorld({ secrets: ['API_TOKEN', 'DB_URL'] }, w.fixture.remote);
    const open = await having.offers.open();
    expect((await having.importer.preflight(open.offerId, { needs })).ok).toBe(true);
  });

  test('a harness that is not installed, and a runtime with no login, are refused', async () => {
    const w = await world();
    const needs = (await w.relocation.preflight(FERRET, 'x')).needs;
    const noHarness = await targetWorld({ harnesses: [] }, w.fixture.remote);
    const a = await noHarness.importer.preflight((await noHarness.offers.open()).offerId, { needs });
    expect(a.refusals.join(' ')).toContain('harness is not installed');
    const noLogin = await targetWorld({ runtimeOk: false }, w.fixture.remote);
    const b = await noLogin.importer.preflight((await noLogin.offers.open()).offerId, { needs });
    expect(b.refusals.join(' ')).toContain('no login is signed in');
  });

  test('a folder with no remote cannot be matched, so it is refused', async () => {
    const w = await world();
    const target = await targetWorld({}, w.fixture.remote);
    const needs = (await w.relocation.preflight(FERRET, 'x')).needs;
    const { remote: _gone, ...bare } = needs;
    const looked = await target.importer.preflight((await target.offers.open()).offerId, { needs: bare });
    expect(looked.ok).toBe(false);
    expect(looked.refusals.join(' ')).toContain('no remote');
  });
});

describe('a failure at any step leaves the target with nothing new', () => {
  const steps = ['importCommits', 'addWorktree', 'applyDiff', 'writeNewFile'] as const;
  for (const step of steps)
    test(`${step} failing`, async () => {
      const w = await world();
      const t = await targetWorld(
        {
          wrapCheckout: (real): Checkout => ({
            ...real,
            [step]: async () => {
              throw new CheckoutError('injected');
            },
          }),
        },
        w.fixture.remote,
      );
      const before = t.shape();
      const { offerId, header } = await t.carry(w);
      const refused = await refusal(t.importer.import(offerId, { header, sourceDaemonId: header.sourceDaemonId }));
      expect(refused.status).toBe(409);
      expect(t.shape()).toEqual(before);
      expect(t.started).toEqual([]);
      expect(t.recorded.size).toBe(0);
    });

  test('the start being refused (the harness would not take the conversation)', async () => {
    const w = await world();
    const t = await targetWorld({ start: 'refuse' }, w.fixture.remote);
    const before = t.shape();
    const { offerId, header } = await t.carry(w);
    const refused = await refusal(t.importer.import(offerId, { header, sourceDaemonId: header.sourceDaemonId }));
    expect(refused).toMatchObject({ status: 409, code: 'start_refused' });
    expect(refused.message).toContain('refused by the harness');
    expect(t.started.length).toBe(1);
    expect(t.shape()).toEqual(before);
    expect(t.recorded.size).toBe(0);
  });

  test('a failed clone-and-start takes back the clone and the project it registered', async () => {
    const w = await world();
    const t = await targetWorld({ project: false, accounts: 1, start: 'refuse' }, w.fixture.remote);
    const cloneInto = join(t.root, 'clones');
    mkdirSync(cloneInto);
    const { offerId, header } = await t.carry(w);
    await refusal(t.importer.import(offerId, { header, sourceDaemonId: header.sourceDaemonId, cloneInto }));
    expect(t.registered).toEqual([]);
    expect(t.removedProjects).toEqual([]);
    expect(await Bun.file(join(cloneInto, 'project', 'README.md')).exists()).toBe(false);
  });

  test('a network clone succeeds in the daemon-owned managed parent', async () => {
    const w = await world();
    const t = await targetWorld({ project: false, accounts: 1 }, w.fixture.remote);
    const cloneInto = join(t.root, 'clones');
    mkdirSync(cloneInto);
    const { offerId, header } = await t.carry(w);
    const done = await t.importer.import(offerId, { header, sourceDaemonId: header.sourceDaemonId, cloneInto });
    expect(done.folder.startsWith(`${join(t.root, 'managed-worktrees', 'project')}-main-`)).toBe(true);
    expect(git(done.folder, 'rev-parse', 'HEAD')).toBe(git(w.fixture.folder, 'rev-parse', 'HEAD'));
  });

  test('a received ferret with an unwritable provenance ledger returns a recovery receipt', async () => {
    const w = await world();
    const t = await targetWorld({ recordFails: true }, w.fixture.remote);
    const { offerId, header } = await t.carry(w);
    const done = await t.importer.import(offerId, { header, sourceDaemonId: w.sourceIdentity.daemonId });
    expect(done.recovery).toMatchObject({ code: 'provenance_unrecorded', state: 'stopped' });
    expect(t.stopped).toEqual([]);
    expect(await Bun.file(join(done.folder, 'new.txt')).exists()).toBe(true);
  });
});

describe('an offer opens one bundle, once', () => {
  test('a replayed offer is refused, with nothing written the second time', async () => {
    const w = await world();
    const t = await targetWorld({}, w.fixture.remote);
    const { offerId, header } = await t.carry(w);
    await t.importer.import(offerId, { header, sourceDaemonId: header.sourceDaemonId });
    const shape = t.shape();
    const again = await refusal(t.importer.import(offerId, { header, sourceDaemonId: header.sourceDaemonId }));
    expect(again).toMatchObject({ status: 409, code: 'offer_spent' });
    expect(t.started.length).toBe(1);
    expect(t.shape()).toEqual(shape);
  });

  test('a refused import still spends the offer', async () => {
    const w = await world();
    const t = await targetWorld({ start: 'refuse' }, w.fixture.remote);
    const { offerId, header } = await t.carry(w);
    await refusal(t.importer.import(offerId, { header, sourceDaemonId: header.sourceDaemonId }));
    expect(await refusal(t.importer.import(offerId, { header, sourceDaemonId: header.sourceDaemonId }))).toMatchObject({
      code: 'offer_spent',
    });
  });

  test('an offer that timed out is gone, and so are its key and chunks', async () => {
    const w = await world();
    const t = await targetWorld({}, w.fixture.remote);
    const { offerId, header } = await t.carry(w);
    t.now += 6 * 60_000;
    expect(await refusal(t.importer.import(offerId, { header, sourceDaemonId: header.sourceDaemonId }))).toMatchObject({
      status: 404,
      code: 'offer_unknown',
    });
    expect(t.started).toEqual([]);
  });

  test('only one offer is open at a time, and the signed offer is the one the source accepts', async () => {
    const w = await world();
    const t = await targetWorld({}, w.fixture.remote);
    const offer = await t.offers.open();
    await expect(t.offers.open()).rejects.toMatchObject({ code: 'offer_busy' });
    expect(offer.daemonId).toBe(t.daemonId);
    await verifiedOfferKey(crypto, offer, w.sourceIdentity.daemonId, t.now);
    t.now += 6 * 60_000;
    expect((await t.offers.open()).offerId).not.toBe(offer.offerId);
  });
});

describe('a bundle that cannot be trusted writes nothing', () => {
  test('one altered chunk is refused', async () => {
    const w = await world();
    const t = await targetWorld({}, w.fixture.remote);
    const before = t.shape();
    const { offerId, header, chunks } = await t.carry(w, { upload: false });
    for (const [index, chunk] of chunks.entries()) {
      const copy = chunk.slice();
      if (index === 0) copy[copy.length - 1] = (copy[copy.length - 1] ?? 0) ^ 1;
      t.importer.receive(offerId, index, copy);
    }
    expect(await refusal(t.importer.import(offerId, { header, sourceDaemonId: header.sourceDaemonId }))).toMatchObject({
      status: 400,
      code: 'bundle_refused',
    });
    expect(t.started).toEqual([]);
    expect(t.shape()).toEqual(before);
  });

  test('a missing chunk is refused', async () => {
    const w = await world();
    const t = await targetWorld({}, w.fixture.remote);
    const { offerId, header, chunks } = await t.carry(w, { upload: false });
    expect(header.chunks).toBeGreaterThan(0);
    for (const [index, chunk] of chunks.entries()) if (index > 0) t.importer.receive(offerId, index, chunk);
    if (header.chunks === 1) t.importer.receive(offerId, 5, chunks[0] ?? new Uint8Array(1));
    expect(await refusal(t.importer.import(offerId, { header, sourceDaemonId: header.sourceDaemonId }))).toMatchObject({
      code: 'bundle_refused',
    });
    expect(t.started).toEqual([]);
  });

  test('a header that is not the one the bundle was sealed with is refused', async () => {
    const w = await world();
    const t = await targetWorld({}, w.fixture.remote);
    const { offerId, header } = await t.carry(w);
    const other = { ...header, bytes: header.bytes + 1 };
    expect(
      await refusal(t.importer.import(offerId, { header: other, sourceDaemonId: header.sourceDaemonId })),
    ).toMatchObject({ code: 'bundle_refused' });
  });

  test('a bundle sealed for another machine is refused', async () => {
    const w = await world();
    const t = await targetWorld({}, w.fixture.remote);
    const { offerId, header } = await t.carry(w);
    const other = { ...header, targetDaemonId: w.sourceIdentity.daemonId };
    expect(
      await refusal(t.importer.import(offerId, { header: other, sourceDaemonId: header.sourceDaemonId })),
    ).toMatchObject({ code: 'bundle_refused' });
  });
});
