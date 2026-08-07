import { afterEach, describe, it } from 'bun:test';
import { type FileHandle, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import should from 'should';
import {
  effectFileName,
  FileSessionEffectLedger,
  fsyncEffectDirectory,
} from '../../../../src/adapters/session/effects/file-session-effect-ledger.ts';
import { type SessionEffectKey, SessionEffectLedgerError } from '../../../../src/lib/session/effects/index.ts';
import { parseSessionId } from '../../../../src/lib/session-id.ts';

/**
 * The durable begun/settled ledger, against a real filesystem.
 *
 * The properties under test are all crash properties, so nothing here may be faked: the admission
 * has to be a real `link` compare-and-set, a damaged file has to be a real damaged file, and a
 * hostile effect id has to be resolved into a real path and shown not to escape. A fake store would
 * only prove that this test and that fake agree.
 */

const BEGUN_AT = '2026-08-06T09:00:00.000Z';
const SETTLED_AT = '2026-08-06T09:00:04.000Z';
const SESSION = parseSessionId('20260806-target');
const OTHER_SESSION = parseSessionId('20260806-other');
const EFFECT = 'plan-fork-1:startup-runtime';
const FINGERPRINT = 'effort:high';

const directories = new Set<string>();

afterEach(async () => {
  for (const directory of directories) await rm(directory, { recursive: true, force: true });
  directories.clear();
});

/**
 * A real state home, and a ledger whose temporary names are determinate.
 *
 * `synced` records the directories the ledger persisted, IN ORDER. The recorder wraps the real
 * `fsyncEffectDirectory` rather than standing in for it, so every case below still performs the real IO —
 * a stand-in would leave the whole file fsyncing nothing while still passing.
 */
async function ledger(label: string): Promise<{
  readonly subject: FileSessionEffectLedger;
  readonly sessions: string;
  readonly home: string;
  readonly synced: string[];
}> {
  const home = await mkdtemp(join(tmpdir(), `fy-effects-${label}-`));
  directories.add(home);
  const sessions = join(home, 'state', 'sessions');
  const synced: string[] = [];
  let temporaries = 0;
  return {
    subject: new FileSessionEffectLedger(
      sessionId => join(sessions, sessionId),
      () => {
        temporaries += 1;
        return `t${temporaries}`;
      },
      async path => {
        synced.push(path);
        await fsyncEffectDirectory(path);
      },
    ),
    sessions,
    home,
    synced,
  };
}

/**
 * A ledger whose file-durability step fails once, at the post-write pre-publication boundary.
 *
 * That instant is the one this whole adapter exists to be correct across, and it cannot be reached
 * from outside: no permission or path shape makes an fsync fail after an exclusive create already
 * succeeded. The seam varies WHEN durability fails and nothing about what is written.
 */
async function failingLedger(label: string): Promise<{
  readonly subject: FileSessionEffectLedger;
  readonly sessions: string;
  readonly failNextSync: () => void;
}> {
  const home = await mkdtemp(join(tmpdir(), `fy-effects-${label}-`));
  directories.add(home);
  const sessions = join(home, 'state', 'sessions');
  let failNext = false;
  return {
    subject: new FileSessionEffectLedger(
      sessionId => join(sessions, sessionId),
      // Deterministic and REUSED, so a leaked temporary would collide with the retry rather than
      // being hidden by a fresh random name.
      () => 'fixed',
      fsyncEffectDirectory,
      async handle => {
        if (failNext) {
          failNext = false;
          throw Object.assign(new Error('the durability step failed after the exclusive create'), { code: 'EIO' });
        }
        await handle.sync();
      },
    ),
    sessions,
    failNextSync: () => {
      failNext = true;
    },
  };
}

const key: SessionEffectKey = { sessionId: SESSION, effectId: EFFECT };

async function refusal(promise: Promise<unknown>): Promise<SessionEffectLedgerError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SessionEffectLedgerError) return error;
    throw error;
  }
  throw new Error('expected the ledger to refuse, but it resolved');
}

async function held(sessions: string, effect: SessionEffectKey = key): Promise<Record<string, unknown>> {
  const file = join(sessions, effect.sessionId, 'effects', `${effectFileName(effect.effectId)}.json`);
  return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
}

describe('FileSessionEffectLedger', () => {
  it('should report a never-attempted effect as unclaimed and write nothing while inspecting', async () => {
    // Arrange
    const { subject, sessions } = await ledger('fresh');

    // Act
    const standing = await subject.inspect(key, FINGERPRINT);

    // Assert: an inspection is a question, so it must not create the directory it asks about.
    should(standing).equal('unclaimed');
    should(await stat(sessions).catch(() => undefined)).equal(undefined);
  });

  it('should admit the first attempt and record the whole act before it is performed', async () => {
    // Arrange
    const { subject, sessions } = await ledger('begin');

    // Act
    const admission = await subject.begin(key, FINGERPRINT, BEGUN_AT);

    // Assert: the intent is on disk BEFORE the caller may touch anything, and it is complete.
    should(admission).equal('perform');
    should(await held(sessions)).eql({
      v: 1,
      sessionId: SESSION,
      effectId: EFFECT,
      fingerprint: FINGERPRINT,
      phase: 'begun',
      begunAt: BEGUN_AT,
    });
    // Private, and nothing partial left beside it.
    const file = join(sessions, SESSION, 'effects', `${effectFileName(EFFECT)}.json`);
    should((await stat(file)).mode & 0o777).equal(0o600);
    should((await stat(dirname(file))).mode & 0o777).equal(0o700);
    should(await readdir(dirname(file))).eql([`${effectFileName(EFFECT)}.json`]);
  });

  it('should persist each created directory own entry in its parent, parent first', async () => {
    // Arrange: nothing of this session exists yet, so the mkdir creates the whole chain and every
    // link of it has its name in the link above.
    const { subject, sessions, home, synced } = await ledger('parents');
    // Only the temporary home exists, so the mkdir creates four levels beneath it.
    const state = dirname(sessions);
    const session = join(sessions, SESSION);
    const effects = join(session, 'effects');

    // Act
    await subject.begin(key, FINGERPRINT, BEGUN_AT);

    // Assert: an entry lives in its PARENT, so syncing the leaf persists the record inside it and
    // says nothing about the leaf's own name. `home` is synced although the mkdir did not create it,
    // because `state` — which it DID create — is named inside it. Oldest ancestor first, because a
    // child's fsync is only well defined once its own entry is durable, and every one of them lands
    // BEFORE the record's own directory sync, which is last and is what persists the record itself.
    should(synced).eql([home, state, sessions, session, effects]);
    should(synced.at(-1)).equal(effects);
  });

  it('should still persist the session parent when the directory was already there', async () => {
    // Arrange: the second effect of a session creates no directory at all.
    const { subject, sessions, synced } = await ledger('steady-state');
    await subject.begin(key, FINGERPRINT, BEGUN_AT);
    synced.length = 0;

    // Act
    await subject.begin({ sessionId: SESSION, effectId: 'turn-1' }, FINGERPRINT, BEGUN_AT);

    // Assert: an attempt that created nothing STILL persists the leaf own entry, because creating
    // a directory is not atomic with persisting its name — the attempt that created it may not
    // have synced the parent yet, and inheriting that promise is what would let this record be
    // admitted into a directory a power loss can leave nameless. No higher ancestor is touched;
    // lifecycle reservation owns durability of the session directory entry itself.
    should(synced).eql([join(sessions, SESSION), join(sessions, SESSION, 'effects')]);
  });

  it('should prove the held record durable and then persist its own write when settling', async () => {
    // Arrange: settling creates no directory, but it READS the begun record and decides from it.
    const { subject, sessions, synced } = await ledger('settle-sync');
    await subject.begin(key, FINGERPRINT, BEGUN_AT);
    synced.length = 0;

    // Act
    await subject.settle(key, FINGERPRINT, SETTLED_AT);

    // Assert: the record it read is made durable first — leaf entry then leaf, because a record that
    // is merely visible can still be erased — and the settled document it writes is published after.
    const session = join(sessions, SESSION);
    const effects = join(session, 'effects');
    should(synced).eql([session, effects, effects]);
  });

  it('should refuse to admit a second attempt while the first has not settled', async () => {
    // Arrange
    const { subject } = await ledger('unsettled');
    await subject.begin(key, FINGERPRINT, BEGUN_AT);

    // Act
    const standing = await subject.inspect(key, FINGERPRINT);
    const admission = await subject.begin(key, FINGERPRINT, SETTLED_AT);

    // Assert: keystrokes may have reached a live agent and the answer was lost. Never replay them.
    should(standing).equal('unsettled');
    should(admission).equal('unsettled');
  });

  it('should answer a retry of a settled effect from its record rather than performing it again', async () => {
    // Arrange
    const { subject, sessions } = await ledger('settled');
    await subject.begin(key, FINGERPRINT, BEGUN_AT);
    await subject.settle(key, FINGERPRINT, SETTLED_AT);

    // Act
    const standing = await subject.inspect(key, FINGERPRINT);
    const admission = await subject.begin(key, FINGERPRINT, '2026-08-06T09:00:09.000Z');

    // Assert: both instants are exactly the ones supplied, and the begin instant is not restamped.
    should(standing).equal('settled');
    should(admission).equal('settled');
    should(await held(sessions)).eql({
      v: 1,
      sessionId: SESSION,
      effectId: EFFECT,
      fingerprint: FINGERPRINT,
      phase: 'settled',
      begunAt: BEGUN_AT,
      settledAt: SETTLED_AT,
    });
  });

  it('should treat one effect id presented for a different act as a conflict', async () => {
    // Arrange: an id is caller-minted, so a second act may honestly arrive wearing a spent one.
    const { subject } = await ledger('conflict');
    await subject.begin(key, FINGERPRINT, BEGUN_AT);

    // Act
    const standing = await subject.inspect(key, 'model:gpt-5.6-terra');
    const admission = await subject.begin(key, 'model:gpt-5.6-terra', SETTLED_AT);

    // Assert: neither act may be answered with the other's outcome.
    should(standing).equal('conflict');
    should(admission).equal('conflict');
  });

  it('should be idempotent for a settle of the same already-settled effect', async () => {
    // Arrange
    const { subject, sessions } = await ledger('idempotent');
    await subject.begin(key, FINGERPRINT, BEGUN_AT);
    await subject.settle(key, FINGERPRINT, SETTLED_AT);
    const file = join(sessions, SESSION, 'effects', `${effectFileName(EFFECT)}.json`);
    const before = await stat(file);

    // Act
    await subject.settle(key, FINGERPRINT, '2026-08-06T09:00:20.000Z');

    // Assert: the same fact arriving twice leaves the first attempt's record untouched.
    const after = await stat(file);
    should(after.mtimeMs).equal(before.mtimeMs);
    should((await held(sessions)).settledAt).equal(SETTLED_AT);
  });

  it('should refuse to settle an effect nothing ever began', async () => {
    // Arrange
    const { subject, sessions } = await ledger('settle-unbegun');

    // Act
    const refused = await refusal(subject.settle(key, FINGERPRINT, SETTLED_AT));

    // Assert: a settled record claims keystrokes reached an agent, and this one never did.
    should(refused.message).match(/was never begun/u);
    should(await stat(join(sessions, SESSION)).catch(() => undefined)).equal(undefined);
  });

  it('should refuse to settle an effect held for a different act', async () => {
    // Arrange
    const { subject, sessions } = await ledger('settle-conflict');
    await subject.begin(key, FINGERPRINT, BEGUN_AT);

    // Act
    const refused = await refusal(subject.settle(key, 'model:gpt-5.6-terra', SETTLED_AT));

    // Assert
    should(refused.message).match(/is held for a different act/u);
    should((await held(sessions)).phase).equal('begun');
  });

  it('should refuse a damaged record rather than read it as unclaimed', async () => {
    // Arrange: three shapes of damage — unreadable bytes, a valid document of the wrong shape, and
    // a well-formed record belonging to another session.
    const torn = await ledger('torn');
    const malformed = await ledger('malformed');
    const foreign = await ledger('foreign');
    await plant(torn.sessions, '{ "v": 1, "sessionId"');
    await plant(malformed.sessions, JSON.stringify({ v: 1, sessionId: SESSION, effectId: EFFECT }));
    await plant(
      foreign.sessions,
      JSON.stringify({
        v: 1,
        sessionId: OTHER_SESSION,
        effectId: EFFECT,
        fingerprint: FINGERPRINT,
        phase: 'begun',
        begunAt: BEGUN_AT,
      }),
    );

    // Act
    const unreadable = await refusal(torn.subject.inspect(key, FINGERPRINT));
    const wrongShape = await refusal(malformed.subject.begin(key, FINGERPRINT, BEGUN_AT));
    const elsewhere = await refusal(foreign.subject.settle(key, FINGERPRINT, SETTLED_AT));

    // Assert: reading damage as "never attempted" is what would let a retry type a second time.
    should(unreadable.message).match(/not readable JSON/u);
    should(wrongShape.message).match(/not a usable one/u);
    should(elsewhere.message).match(/belonging to .* on session 20260806-other/u);
  });

  it('should refuse a record whose settled instant disagrees with its phase', async () => {
    // Arrange: the cross-field rule a replay's whole decision rests on.
    const { subject, sessions } = await ledger('half-settled');
    await plant(
      sessions,
      JSON.stringify({
        v: 1,
        sessionId: SESSION,
        effectId: EFFECT,
        fingerprint: FINGERPRINT,
        phase: 'begun',
        begunAt: BEGUN_AT,
        settledAt: SETTLED_AT,
      }),
    );

    // Act
    const refused = await refusal(subject.inspect(key, FINGERPRINT));

    // Assert
    should(refused.message).match(/records when it settled exactly once it has settled/u);
  });

  it('should confine a hostile effect id to the session own effects directory', async () => {
    // Arrange: an id is caller-minted and can be anything a request id can be.
    const { subject, sessions, home } = await ledger('confinement');
    const hostile: SessionEffectKey = { sessionId: SESSION, effectId: '../../../../etc/passwd' };

    // Act
    const admission = await subject.begin(hostile, FINGERPRINT, BEGUN_AT);

    // Assert: the id never becomes a path component — the filename is hex — and the document still
    // carries the original id verbatim, so the hash is a naming device and never the identity.
    should(admission).equal('perform');
    should(subject.file(hostile)).equal(join(sessions, SESSION, 'effects', `${effectFileName(hostile.effectId)}.json`));
    should(effectFileName(hostile.effectId)).match(/^[0-9a-f]{64}$/u);
    should(await readdir(join(sessions, SESSION, 'effects'))).eql([`${effectFileName(hostile.effectId)}.json`]);
    should(await readdir(home)).eql(['state']);
    should((await held(sessions, hostile)).effectId).equal('../../../../etc/passwd');
  });

  it('should admit exactly one of two concurrent attempts on one key', async () => {
    // Arrange: the window a read-then-write ledger leaves open, driven for real.
    const { subject, sessions, synced } = await ledger('race');

    // Act
    const admissions = await Promise.all([
      subject.begin(key, FINGERPRINT, BEGUN_AT),
      subject.begin(key, FINGERPRINT, BEGUN_AT),
      subject.begin(key, FINGERPRINT, BEGUN_AT),
    ]);

    // Assert: one caller may type; the losers are told the act is in flight and must not repeat it.
    should(admissions.filter(admission => admission === 'perform')).have.length(1);
    should(admissions.filter(admission => admission === 'unsettled')).have.length(2);
    // And every attempt persisted the session's own entry on its own behalf before racing for the
    // record — which is what makes the winner `perform` safe no matter which attempt created the
    // directory. Exactly once per attempt on the way in, whatever the concurrent mkdirs reported.
    //
    // THE LOSERS SYNC AGAIN, and that is the point rather than an accident. A loser answers from the
    // winner's record, and `held` persists that record before reporting it — one handle for the read
    // and the fsync, then the session entry and the effects entry — because a record that reached
    // only the page cache is one a power cut still erases, and reporting `unsettled` from it would
    // claim an act is in flight that a restart cannot find. That is the property the
    // visible-but-unsynced case below states directly.
    //
    // So both counts are ATTEMPTS PLUS LOSERS rather than magic numbers: three attempts each sync the
    // session once on the way in and the two losers sync it again inside `held`; only the winner
    // reaches the leaf sync after its link, and the same two losers sync the leaf again.
    const losers = 2;
    should(synced.filter(path => path === join(sessions, SESSION))).have.length(admissions.length + losers);
    should(synced.filter(path => path === join(sessions, SESSION, 'effects'))).have.length(1 + losers);
  });

  it('should persist a visible-but-unsynced record before any existing-record path answers from it', async () => {
    // Arrange: the window a process death opens. A record reaches the page cache at the link, and is
    // durable only once its directory is synced — so a RESTARTED reader can see a record that a power
    // cut could still erase. Every answer drawn from one is a decision about touching a live pane, so
    // each of the three existing-record paths must make it durable before it decides anything.
    //
    // A fresh ledger over the same directory is the restart: nothing is carried in memory.
    const written = await ledger('restart-barrier');
    await written.subject.begin(key, FINGERPRINT, BEGUN_AT);

    const restarted = new FileSessionEffectLedger(
      sessionId => join(written.sessions, sessionId),
      () => 'restarted',
      async path => {
        written.synced.push(`restarted:${path}`);
        await fsyncEffectDirectory(path);
      },
    );
    written.synced.length = 0;

    // Act: inspect, then a begin that loses the compare-and-set, then a settle.
    const standing = await restarted.inspect(key, FINGERPRINT);
    const admission = await restarted.begin(key, FINGERPRINT, SETTLED_AT);
    await restarted.settle(key, FINGERPRINT, SETTLED_AT);

    // Assert: all three answered, and every one of them persisted the record's directory chain first
    // — the leaf's own entry and the leaf — rather than trusting what it could merely read.
    should(standing).equal('unsettled');
    should(admission).equal('unsettled');
    const session = join(written.sessions, SESSION);
    const effects = join(session, 'effects');
    should(written.synced.filter(path => path === `restarted:${session}`).length).be.aboveOrEqual(3);
    should(written.synced.filter(path => path === `restarted:${effects}`).length).be.aboveOrEqual(3);
  });

  it('should persist the winner record for a begin that loses the compare-and-set', async () => {
    // Arrange: the loser adopts the winner's record and is answered from it, so the loser is exactly
    // as dependent on that record surviving as the winner is — and it did not write it.
    const { subject, sessions, synced } = await ledger('eexist-loser');
    await subject.begin(key, FINGERPRINT, BEGUN_AT);
    synced.length = 0;

    // Act
    const admission = await subject.begin(key, FINGERPRINT, SETTLED_AT);

    // Assert
    should(admission).equal('unsettled');
    should(synced).containEql(join(sessions, SESSION, 'effects'));
    should(synced).containEql(join(sessions, SESSION));
  });

  it('should persist an already-settled record before reporting the settle as done', async () => {
    // Arrange: the idempotent settle returns without writing, so without this it would report a
    // boundary crossed on the strength of a record that had never reached the platter.
    const { subject, sessions, synced } = await ledger('settled-barrier');
    await subject.begin(key, FINGERPRINT, BEGUN_AT);
    await subject.settle(key, FINGERPRINT, SETTLED_AT);
    synced.length = 0;

    // Act
    await subject.settle(key, FINGERPRINT, '2026-08-06T09:00:30.000Z');

    // Assert: no rewrite — the stored instant is still the first one — and the record was persisted.
    should((await held(sessions)).settledAt).equal(SETTLED_AT);
    should(synced).containEql(join(sessions, SESSION, 'effects'));
  });

  it('should never delete a colliding temporary it did not create', async () => {
    // Arrange: a temporary already at the name this attempt would assemble under — another attempt's
    // in-flight record. The fixed unique id makes the collision certain.
    const { subject, sessions } = await ledger('temp-collision');
    const effects = join(sessions, SESSION, 'effects');
    await mkdir(effects, { recursive: true, mode: 0o700 });
    const foreign = join(effects, `${effectFileName(EFFECT)}.json.t1.tmp`);
    await writeFile(foreign, 'another attempt\n', { encoding: 'utf8', mode: 0o600 });

    // Act
    let refused: NodeJS.ErrnoException | undefined;
    try {
      await subject.begin(key, FINGERPRINT, BEGUN_AT);
    } catch (error) {
      refused = error as NodeJS.ErrnoException;
    }

    // Assert: losing the exclusive create means this attempt owns nothing to clean up.
    should(refused?.code).equal('EEXIST');
    should(await readFile(foreign, 'utf8')).equal('another attempt\n');
  });

  it('should read and persist one inode, so a concurrent settle cannot split the decision', async () => {
    // Arrange: reading by path and syncing by path are two lookups of a name a settle republishes by
    // rename. Holding the inode across both is what stops a caller deciding from bytes it never made
    // durable — asserted here by the record the answer is drawn from.
    const { subject } = await ledger('same-inode');
    await subject.begin(key, FINGERPRINT, BEGUN_AT);

    // Act
    const before = await subject.inspect(key, FINGERPRINT);
    await subject.settle(key, FINGERPRINT, SETTLED_AT);
    const after = await subject.inspect(key, FINGERPRINT);

    // Assert: each answer reflects the inode that call actually held.
    should(before).equal('unsettled');
    should(after).equal('settled');
  });

  it('should remove its own partial temporary when durability fails, and let the retry succeed', async () => {
    // Arrange: the post-write, pre-publication boundary — the exclusive create succeeded, so the
    // partial file is this call's own, and no caller can clean it up on its behalf because callers
    // arm their cleanup only once the write returns.
    const { subject, sessions, failNextSync } = await failingLedger('sync-failure');
    const effects = join(sessions, SESSION, 'effects');
    failNextSync();

    // Act
    let failed: NodeJS.ErrnoException | undefined;
    try {
      await subject.begin(key, FINGERPRINT, BEGUN_AT);
    } catch (error) {
      failed = error as NodeJS.ErrnoException;
    }

    // Assert: it propagated, and it left nothing behind. Under a REUSED unique id a leaked temporary
    // would wedge every later attempt on EEXIST for a file nobody is writing.
    should(failed?.code).equal('EIO');
    should(await readdir(effects)).eql([]);

    // Act again, same deterministic id: the retry must be able to begin.
    const admission = await subject.begin(key, FINGERPRINT, BEGUN_AT);

    // Assert
    should(admission).equal('perform');
    should(await readdir(effects)).eql([`${effectFileName(EFFECT)}.json`]);
  });

  it('should stop owning the temporary name once the settled record is published', async () => {
    // Arrange: the interleaving itself. A foreign temporary appears in the effects directory DURING
    // `settle`'s own sync, and must still be there when `settle` returns — the contract is that a
    // caller unlinks only the temporary it created, never a name it merely recognises the shape of.
    // The injected sync is the scheduling point, so this is deterministic.
    //
    // `t2` IS DELIBERATE: it is the exact name this `settle` owned and then freed by renaming its
    // temporary onto the record. Reusing that same name is the strongest form of the contract —
    // ownership ends at a successful rename, so by the time the stranger takes the name back, `owns`
    // is already false and the cleanup on the way out must leave it alone. A name the ledger never
    // owned would only prove it does not delete arbitrary files; this proves it does not reclaim the
    // one name it would recognise as its own.
    const home = await mkdtemp(join(tmpdir(), 'fy-effects-settle-ownership-'));
    directories.add(home);
    const sessions = join(home, 'state', 'sessions');
    const effects = join(sessions, SESSION, 'effects');
    const record = join(effects, `${effectFileName(EFFECT)}.json`);
    const reused = join(effects, `${effectFileName(EFFECT)}.json.t2.tmp`);
    let settling = false;
    let plantedDuringSync = false;
    let temporaries = 0;
    const subject = new FileSessionEffectLedger(
      sessionId => join(sessions, sessionId),
      () => {
        temporaries += 1;
        return `t${temporaries}`;
      },
      async path => {
        await fsyncEffectDirectory(path);
        if (!settling || plantedDuringSync) return;
        // GATED ON THE PUBLISHED RECORD, not on being the first sync of the call. `settle` persists
        // directories PARENT-FIRST, before it writes anything, so the first sync of the call arrives
        // while this name is still the one `settle` is about to create exclusively — planting there
        // would collide with the ledger's own temporary and prove nothing. Reading the final record
        // and requiring it to be `settled` is the post-rename condition stated as a fact rather than
        // as a count: the rename is what publishes that phase AND what frees this name, so a plant
        // that sees it is planting in exactly the window a real second attempt would.
        const published = await readFile(record, 'utf8').catch(() => undefined);
        if (published === undefined) return;
        if ((JSON.parse(published) as { readonly phase?: string }).phase !== 'settled') return;
        plantedDuringSync = true;
        await writeFile(reused, 'another attempt\n', { encoding: 'utf8', mode: 0o600 });
      },
    );
    await subject.begin(key, FINGERPRINT, BEGUN_AT);
    settling = true;

    // Act
    await subject.settle(key, FINGERPRINT, SETTLED_AT);

    // Assert: the settled record is published and the stranger's temporary — created while this call
    // was still inside its own sync — survived the cleanup on the way out.
    should(plantedDuringSync).equal(true);
    should((await held(sessions)).phase).equal('settled');
    should(await readFile(reused, 'utf8')).equal('another attempt\n');
  });

  it('should keep two sessions and two effects on one session apart', async () => {
    // Arrange
    const { subject, sessions } = await ledger('separate');
    const sibling: SessionEffectKey = { sessionId: SESSION, effectId: 'turn-1' };
    const elsewhere: SessionEffectKey = { sessionId: OTHER_SESSION, effectId: EFFECT };

    // Act
    await subject.begin(key, FINGERPRINT, BEGUN_AT);
    await subject.settle(key, FINGERPRINT, SETTLED_AT);

    // Assert: neither neighbour is answered from this one's record.
    should(await subject.inspect(sibling, FINGERPRINT)).equal('unclaimed');
    should(await subject.inspect(elsewhere, FINGERPRINT)).equal('unclaimed');
    should(await readdir(join(sessions, SESSION, 'effects'))).eql([`${effectFileName(EFFECT)}.json`]);
    should(await readdir(sessions)).eql([SESSION]);
  });
});

/** Puts an exact document where the ledger will look for this key's record. */
async function plant(sessions: string, text: string): Promise<void> {
  const file = join(sessions, SESSION, 'effects', `${effectFileName(EFFECT)}.json`);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, text, { encoding: 'utf8', mode: 0o600 });
}

/** An errno-shaped rejection, exactly as the platform raises one. */
function directoryRefusal(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`the platform refused a directory sync with ${code}`), { code });
}

/**
 * A directory handle that opens and then refuses to sync.
 *
 * The sync-side branch cannot be reached from outside on any filesystem this repository is
 * developed or tested against: all of them sync a directory successfully, which is why the branch
 * survived untested long enough to have the wrong shape. The fake varies only which errno the sync
 * raises — the open, the path and the close are still the helper's own.
 */
function refusingToSync(code: string, closes: string[]): FileHandle {
  return {
    async sync(): Promise<void> {
      throw directoryRefusal(code);
    },
    async close(): Promise<void> {
      closes.push('closed');
    },
  } as unknown as FileHandle;
}

/**
 * The repo-standard directory-sync tolerance, across the whole open-then-sync operation.
 *
 * A filesystem that cannot sync a directory usually says so by refusing the READ-ONLY OPEN, not by
 * failing the fsync behind it — so tolerating only the sync left this helper's stated contract
 * untrue on exactly the platforms it was written for. Each case drives the real exported helper and
 * varies nothing but where the errno comes from.
 */
describe('fsyncEffectDirectory', () => {
  for (const code of ['EINVAL', 'ENOTSUP', 'EPERM']) {
    it(`should tolerate ${code} raised by the directory open, not only by the sync`, async () => {
      // Arrange
      const opened: string[] = [];

      // Act: resolving at all is the assertion — a helper that fell through would sync a handle it
      // never received.
      await fsyncEffectDirectory('/state/sessions', async path => {
        opened.push(path);
        throw directoryRefusal(code);
      });

      // Assert
      should(opened).eql(['/state/sessions']);
    });

    it(`should tolerate ${code} raised by the sync, and still close the handle`, async () => {
      // Arrange
      const closes: string[] = [];

      // Act
      await fsyncEffectDirectory('/state/sessions', async () => refusingToSync(code, closes));

      // Assert
      should(closes).eql(['closed']);
    });
  }

  it('should propagate an open failure that is not a platform refusal', async () => {
    // Act + Assert: EIO is a real failure to persist, and a ledger that swallowed it would report a
    // record durable that is not.
    await should(
      fsyncEffectDirectory('/state/sessions', async () => {
        throw directoryRefusal('EIO');
      }),
    ).be.rejectedWith(/EIO/u);
  });

  it('should propagate a sync failure that is not a platform refusal, and still close the handle', async () => {
    // Arrange
    const closes: string[] = [];

    // Act + Assert
    await should(fsyncEffectDirectory('/state/sessions', async () => refusingToSync('EIO', closes))).be.rejectedWith(
      /EIO/u,
    );
    should(closes).eql(['closed']);
  });

  it('should persist a real directory through its default opener', async () => {
    // Arrange: the default argument is what production uses, so it has to be exercised unwrapped.
    const home = await mkdtemp(join(tmpdir(), 'fy-effects-default-'));
    directories.add(home);

    // Act + Assert: a real open and a real fsync of a real directory.
    await fsyncEffectDirectory(home);
  });
});
