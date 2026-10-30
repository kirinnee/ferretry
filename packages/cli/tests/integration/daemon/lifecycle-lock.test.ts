import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { SystemMillisecondClock } from '../../../src/adapters/daemon/clock.ts';
import { DaemonLifecycleBusyError, FileDaemonLifecycleLock } from '../../../src/adapters/daemon/lifecycle-lock.ts';
import { BunDaemonProcess } from '../../../src/adapters/daemon/process.ts';
import { HostProcessIncarnations } from '../../../src/adapters/daemon/process-incarnation.ts';
import type {
  IProcessIncarnationPort,
  ObservedProcess,
  ProcessScope,
} from '../../../src/adapters/daemon/process-incarnation.ts';
import type { CommandOutcome, IDaemonProcessPort } from '../../../src/lib/daemon/ports.ts';
import { waitFor } from '../support/wait-for.ts';

/**
 * The claim that serializes one daemon's mutating lifecycle commands.
 *
 * **The exclusion tests below run genuinely independent invocations**, because that is the only thing
 * that can prove this. Two lock objects inside one test share a scheduler, a filesystem cache and a
 * heap, so an implementation that serialized nothing at all could still look ordered; the defect this
 * exists for is two `fy daemon` commands typed into two terminals. The in-process tests that follow
 * them are about the *answers* — what a refusal says, what a release leaves behind — which is
 * exactly the part a subprocess can only report second-hand.
 */

const roots = new Set<string>();

async function createTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fy-lifecycle-lock-'));
  roots.add(root);
  return root;
}

afterEach(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
  roots.clear();
});

/** A process port whose liveness answer is scripted, so both verdicts can be shown. */
class ScriptedProcesses implements IDaemonProcessPort {
  constructor(private readonly living = true) {}

  run(): Promise<CommandOutcome> {
    return Promise.reject(new Error('the lifecycle claim never runs a command'));
  }

  spawnDetached(): Promise<never> {
    return Promise.reject(new Error('the lifecycle claim never launches anything'));
  }

  signal(): boolean {
    return false;
  }

  alive(): boolean {
    return this.living;
  }

  holdsOpen(): Promise<boolean | undefined> {
    return Promise.resolve(this.living);
  }
}

/**
 * A process-identity port whose answers are scripted, so every verdict can be reached on any host.
 *
 * The default knows nothing — no scope, every pid unknown — which is what a host with neither `/proc`
 * nor the macOS sources offers, and it leaves the liveness answer to `ScriptedProcesses` as before.
 */
class ScriptedIncarnations implements IProcessIncarnationPort {
  constructor(
    private readonly here: ProcessScope | undefined = undefined,
    private readonly seen: ReadonlyMap<number, ObservedProcess> = new Map(),
  ) {}

  scope(): Promise<ProcessScope | undefined> {
    return Promise.resolve(this.here);
  }

  observe(pid: number): Promise<ObservedProcess> {
    return Promise.resolve(this.seen.get(pid) ?? { kind: 'unknown' });
  }
}

function lock(
  processes: IDaemonProcessPort = new ScriptedProcesses(),
  incarnations: IProcessIncarnationPort = new ScriptedIncarnations(),
): FileDaemonLifecycleLock {
  return new FileDaemonLifecycleLock(processes, incarnations, new SystemMillisecondClock(), { pollMs: 1 });
}

/** Nothing is expected to contend in most of these, so a notice is a failure the test should see. */
const neverWaits = (holder: string): void => {
  throw new Error(`did not expect to wait for ${holder}`);
};

/** Nothing in most of these was left by a dead holder, so a removal is a failure the test should see. */
const neverReclaims = (holder: string): void => {
  throw new Error(`did not expect to remove a claim left by ${holder}`);
};

/**
 * A contender in its own invocation: acquires, journals its window, then releases.
 *
 * Written to disk and run through a separate `bun` because that is the shape of the defect — the CLI
 * has no long-lived task, so every lifecycle command is a fresh invocation that knows nothing about
 * any other.
 */
const CONTENDER = (adapters: string): string => `
import { appendFileSync, readFileSync } from 'node:fs';
import { FileDaemonLifecycleLock } from '${adapters}/lifecycle-lock.ts';
import { BunDaemonProcess } from '${adapters}/process.ts';
import { HostProcessIncarnations } from '${adapters}/process-incarnation.ts';
import { SystemMillisecondClock } from '${adapters}/clock.ts';

const [lockPath, journal, name, holdMs, waitMs, rendezvous, until] = Bun.argv.slice(2);
const processes = new BunDaemonProcess();
const lock = new FileDaemonLifecycleLock(processes, new HostProcessIncarnations(processes), new SystemMillisecondClock(), { pollMs: 5 });
try {
  const claim = await lock.acquire({
    lockPath,
    verb: 'start',
    waitMs: Number(waitMs),
    waiting: holder => appendFileSync(journal, \`waiting \${name}: \${holder}\\n\`),
    reclaimed: holder => appendFileSync(journal, \`reclaimed \${name}: \${holder}\\n\`),
  });
  appendFileSync(journal, \`enter \${name}\\n\`);
  if (until === 'queued') {
    // Held until a rival is seen to be queued behind (or to have walked in beside), however late its
    // process starts; the bound only stops a claim that excludes nothing from holding for ever.
    const deadline = Date.now() + Number(holdMs);
    const rivalSeen = () => {
      const lines = readFileSync(journal, 'utf8').split('\\n');
      return lines.some(line => line.startsWith('waiting')) || lines.filter(line => line.startsWith('enter')).length > 1;
    };
    while (Date.now() < deadline && !rivalSeen()) await Bun.sleep(5);
  } else if (rendezvous === undefined) {
    await Bun.sleep(Number(holdMs));
  } else {
    // Held at the same time on purpose: two DIFFERENT daemons must not wait for each other, and only
    // an overlap they both observe can show that.
    appendFileSync(\`\${rendezvous}.\${name}\`, 'held');
    const deadline = Date.now() + Number(holdMs);
    while (Date.now() < deadline && (await Array.fromAsync(new Bun.Glob('*').scan({ cwd: journal + '.d' }))).length < 2) {
      await Bun.sleep(5);
    }
  }
  appendFileSync(journal, \`exit \${name}\\n\`);
  const residue = await claim.release();
  console.log(JSON.stringify({ ok: true, residue }));
} catch (error) {
  appendFileSync(journal, \`refused \${name}\\n\`);
  console.log(JSON.stringify({ ok: false, message: error.message }));
  process.exit(3);
}
`;

interface Contender {
  readonly code: number;
  readonly report: { ok: boolean; residue?: string; message?: string };
}

async function contenderScript(root: string): Promise<string> {
  const script = join(root, 'contender.ts');
  await writeFile(script, CONTENDER(join(import.meta.dir, '..', '..', '..', 'src', 'adapters', 'daemon')));
  return script;
}

async function contend(script: string, argv: readonly string[]): Promise<Contender> {
  const child = Bun.spawn([process.execPath, script, ...argv], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return { code, report: JSON.parse(stdout.trim() || '{"ok":false}') as Contender['report'] };
}

async function journalOf(path: string): Promise<string[]> {
  return (await readFile(path, 'utf8')).trim().split('\n');
}

describe('daemon lifecycle claim across invocations', () => {
  it('should let only one invocation at a time inside the claim', async () => {
    // Arrange — two independent invocations. Whoever gets in first holds until the other is seen
    // queued, so the overlap this exists to forbid is always on offer, however the two start up.
    const root = await createTemporaryRoot();
    const script = await contenderScript(root);
    const lockPath = join(root, 'lifecycle', 'fyd.lock');
    const journal = join(root, 'journal.txt');
    await writeFile(journal, '');

    // Act
    const [first, second] = await Promise.all([
      contend(script, [lockPath, journal, 'first', '20000', '30000', '-', 'queued']),
      contend(script, [lockPath, journal, 'second', '20000', '30000', '-', 'queued']),
    ]);

    // Assert — both got in, and neither entered while the other held it. The waiting notice proves
    // the second one actually had to queue rather than the two simply missing each other.
    should(first.report.ok).be.true();
    should(second.report.ok).be.true();
    const windows = (await journalOf(journal)).filter(line => !line.startsWith('waiting'));
    should(windows[1]).equal(windows[0]?.replace('enter', 'exit'));
    should(windows[3]).equal(windows[2]?.replace('enter', 'exit'));
    should((await journalOf(journal)).some(line => line.startsWith('waiting'))).be.true();
  });

  it('should refuse an invocation that cannot have the claim, naming the command that holds it', async () => {
    // Arrange — this test process holds the claim, and the contender is given no time to wait.
    const root = await createTemporaryRoot();
    const script = await contenderScript(root);
    const lockPath = join(root, 'lifecycle', 'fyd.lock');
    const journal = join(root, 'journal.txt');
    await writeFile(journal, '');
    const claim = await lock().acquire({
      lockPath,
      verb: 'restart',
      waitMs: 0,
      waiting: neverWaits,
      reclaimed: neverReclaims,
    });

    // Act
    const refused = await contend(script, [lockPath, journal, 'late', '0', '0']);

    // Assert — refused rather than run beside the holder, and the message names the verb, the owner
    // and that the owner is alive, which is what tells a person to wait rather than to clear it.
    should(refused.code).equal(3);
    should(refused.report.message).match(/still holds/u);
    should(refused.report.message).match(/held by restart \(owner \d+/u);
    should(refused.report.message).containEql('that owner is still running');
    should(await claim.release()).be.undefined();
  });

  it('should let a different daemon proceed at the same time', async () => {
    // Arrange — the claim is daemon-keyed, so two daemons on one host never wait for each other. Each
    // contender waits for the other to be inside its own claim, which cannot happen if they share one.
    const root = await createTemporaryRoot();
    const script = await contenderScript(root);
    const journal = join(root, 'journal.txt');
    await writeFile(journal, '');
    await mkdir(`${journal}.d`);

    // Act
    const [first, second] = await Promise.all([
      contend(script, [join(root, 'lifecycle', 'one.lock'), journal, 'one', '60000', '0', `${journal}.d/held`]),
      contend(script, [join(root, 'lifecycle', 'two.lock'), journal, 'two', '60000', '0', `${journal}.d/held`]),
    ]);

    // Assert — both held their own claim simultaneously, so the journal interleaves rather than pairs.
    should([first.report.ok, second.report.ok]).deepEqual([true, true]);
    const windows = await journalOf(journal);
    should(windows.slice(0, 2).every(line => line.startsWith('enter'))).be.true();
  });
});

describe('daemon lifecycle claim', () => {
  it('should hand the claim over once the holder gives it up', async () => {
    // Arrange
    const root = await createTemporaryRoot();
    const lockPath = join(root, 'lifecycle', 'fyd.lock');
    const held = await lock().acquire({
      lockPath,
      verb: 'start',
      waitMs: 0,
      waiting: neverWaits,
      reclaimed: neverReclaims,
    });
    const notices: string[] = [];

    // Act — the successor queues, the holder releases, and the successor gets in.
    const successor = lock().acquire({
      lockPath,
      verb: 'stop',
      waitMs: 30_000,
      waiting: holder => notices.push(holder),
      reclaimed: neverReclaims,
    });
    await waitFor(() => notices.length > 0, 'the successor to queue behind the holder');
    const residue = await held.release();
    const second = await successor;

    // Assert — and the notice named the verb that was holding it, not just that something was.
    should(residue).be.undefined();
    should(notices).have.length(1);
    should(notices[0]).match(/held by start \(owner \d+/u);
    should(await second.release()).be.undefined();
    should(await readdir(join(root, 'lifecycle'))).be.empty();
  });

  it('should report an owner it cannot see without declaring a claim that proves nothing abandoned', async () => {
    // Arrange — a claim an older release wrote: an owner number and nothing saying which process it
    // is. A missing number could be a live holder in another namespace, so availability loses until a
    // person independently rules out a live holder.
    const root = await createTemporaryRoot();
    const lockPath = join(root, 'lifecycle', 'fyd.lock');
    await mkdir(lockPath, { recursive: true });
    const claim = { owner: 4_242, token: 'abandoned', verb: 'install', at: 1_785_974_400_000 };
    await writeFile(join(lockPath, 'claim-abandoned.json'), JSON.stringify(claim));

    // Act
    const refusal = lock(new ScriptedProcesses(false)).acquire({
      lockPath,
      verb: 'start',
      waitMs: 0,
      waiting: neverWaits,
      reclaimed: neverReclaims,
    });

    // Assert
    await should(refusal).be.rejectedWith(DaemonLifecycleBusyError);
    await should(refusal).be.rejectedWith(/owner 4242, since 2026-08-06T00:00:00.000Z/u);
    await should(refusal).be.rejectedWith(/does not record enough to prove it has exited/u);
    await should(refusal).be.rejectedWith(/verify independently that no lifecycle command is running/u);
  });

  it("should not treat numeric pid equality as proof that a claim is this invocation's leak", async () => {
    // Arrange — two PID namespaces may assign the same number to different live processes sharing
    // this filesystem. Equality is not identity proof, so it must delay in the safe direction.
    const root = await createTemporaryRoot();
    const lockPath = join(root, 'lifecycle', 'fyd.lock');
    await mkdir(lockPath, { recursive: true });
    const claim = { owner: process.pid, token: 'leaked', verb: 'stop', at: 1_785_974_400_000 };
    await writeFile(join(lockPath, 'claim-leaked.json'), JSON.stringify(claim));

    // Act + Assert
    await should(
      lock().acquire({ lockPath, verb: 'start', waitMs: 0, waiting: neverWaits, reclaimed: neverReclaims }),
    ).be.rejectedWith(/that owner is still running/u);
  });

  it.each([
    { name: 'nothing this code could have published', file: 'claim-junk.json', contents: 'not json at all' },
    {
      name: 'a document whose token disagrees with its filename',
      file: 'claim-one.json',
      contents: JSON.stringify({ owner: 1, token: 'two', verb: 'start', at: 1 }),
    },
    { name: 'an entry that is not a claim', file: 'something-else', contents: 'residue' },
  ])('should describe $name as unreadable rather than invent a holder', async ({ file, contents }) => {
    // Arrange
    const root = await createTemporaryRoot();
    const lockPath = join(root, 'lifecycle', 'fyd.lock');
    await mkdir(lockPath, { recursive: true });
    await writeFile(join(lockPath, file), contents);

    // Act + Assert — an unreadable claim and one that was just released are reported as one thing,
    // because telling them apart needs an observation a filesystem cannot give atomically and both
    // lead a person to the same two actions.
    await should(
      lock().acquire({ lockPath, verb: 'start', waitMs: 0, waiting: neverWaits, reclaimed: neverReclaims }),
    ).be.rejectedWith(/could not be read, so it may have been released in the meantime/u);
  });

  it('should treat a file sitting on the claim name as contention, not as a free name', async () => {
    // Arrange — a regular file there is a different error code and the same answer: something holds
    // the name and this attempt must not remove it.
    const root = await createTemporaryRoot();
    const lockPath = join(root, 'lifecycle', 'fyd.lock');
    await mkdir(join(root, 'lifecycle'), { recursive: true });
    await writeFile(lockPath, 'left by something else');

    // Act + Assert
    await should(
      lock().acquire({ lockPath, verb: 'start', waitMs: 0, waiting: neverWaits, reclaimed: neverReclaims }),
    ).be.rejectedWith(DaemonLifecycleBusyError);
    should(await readFile(lockPath, 'utf8')).equal('left by something else');
  });

  it('should take a name left empty by an interrupted release', async () => {
    // Arrange — an empty directory is residue, not a claim: a claim is published whole in one rename
    // and is never observed empty, so refusing this would block every later lifecycle command.
    const root = await createTemporaryRoot();
    const lockPath = join(root, 'lifecycle', 'fyd.lock');
    await mkdir(lockPath, { recursive: true });

    // Act
    const claim = await lock().acquire({
      lockPath,
      verb: 'start',
      waitMs: 0,
      waiting: neverWaits,
      reclaimed: neverReclaims,
    });

    // Assert
    should(await claim.release()).be.undefined();
  });

  it('should not throw an operational failure away as if the name were taken', async () => {
    // Arrange — a FILE where the claim's parent directory belongs. Looping on this until the deadline
    // would report "another lifecycle command holds this" about a claim nobody holds.
    const root = await createTemporaryRoot();
    await writeFile(join(root, 'lifecycle'), 'not a directory');

    // Act + Assert
    await should(
      lock().acquire({
        lockPath: join(root, 'lifecycle', 'fyd.lock'),
        verb: 'start',
        waitMs: 0,
        waiting: neverWaits,
        reclaimed: neverReclaims,
      }),
    ).be.rejectedWith(/EEXIST/u);
  });

  it('should leave a successor alone when the claim it held was cleared and re-taken', async () => {
    // Arrange — the sequence the refusal itself invites: a person clears an abandoned claim and
    // somebody else takes the freed name. The superseded holder must not delete theirs.
    const root = await createTemporaryRoot();
    const lockPath = join(root, 'lifecycle', 'fyd.lock');
    const superseded = await lock().acquire({
      lockPath,
      verb: 'start',
      waitMs: 0,
      waiting: neverWaits,
      reclaimed: neverReclaims,
    });
    await rm(lockPath, { recursive: true, force: true });
    const successor = await lock().acquire({
      lockPath,
      verb: 'restart',
      waitMs: 0,
      waiting: neverWaits,
      reclaimed: neverReclaims,
    });

    // Act
    const residue = await superseded.release();

    // Assert — nothing reported, because nothing of the superseded holder's is left, and the
    // successor's claim is untouched.
    should(residue).be.undefined();
    should((await readdir(lockPath)).some(name => name.startsWith('claim-'))).be.true();
    should(await successor.release()).be.undefined();
  });

  it('should report a claim it cannot leave empty, because the next command will be blocked by it', async () => {
    // Arrange
    const root = await createTemporaryRoot();
    const lockPath = join(root, 'lifecycle', 'fyd.lock');
    const claim = await lock().acquire({
      lockPath,
      verb: 'start',
      waitMs: 0,
      waiting: neverWaits,
      reclaimed: neverReclaims,
    });
    await writeFile(join(lockPath, 'occupied'), 'something nobody published');

    // Act
    const residue = await claim.release();

    // Assert — named rather than removed: that read describes, it never authorises a removal.
    should(residue).equal(lockPath);
    should(await readdir(lockPath)).deepEqual(['occupied']);
  });

  it('should report a claim name it cannot even look at', async () => {
    // Arrange — the claim directory replaced by a file while the work ran.
    const root = await createTemporaryRoot();
    const lockPath = join(root, 'lifecycle', 'fyd.lock');
    const claim = await lock().acquire({
      lockPath,
      verb: 'start',
      waitMs: 0,
      waiting: neverWaits,
      reclaimed: neverReclaims,
    });
    await rm(lockPath, { recursive: true, force: true });
    await writeFile(lockPath, 'not a directory any more');

    // Act
    const residue = await claim.release();

    // Assert
    should(residue).equal(lockPath);
  });

  it('should treat a claim a person has already cleared as released', async () => {
    // Arrange — clearing it is exactly what the refusal invites, and calling that residue would send
    // somebody back to look at nothing.
    const root = await createTemporaryRoot();
    const lockPath = join(root, 'lifecycle', 'fyd.lock');
    const claim = await lock().acquire({
      lockPath,
      verb: 'start',
      waitMs: 0,
      waiting: neverWaits,
      reclaimed: neverReclaims,
    });
    await rm(lockPath, { recursive: true, force: true });

    // Act + Assert
    should(await claim.release()).be.undefined();
  });

  it('should use the shipped poll cadence when none is configured', async () => {
    // Arrange
    const root = await createTemporaryRoot();
    const subject = new FileDaemonLifecycleLock(
      new ScriptedProcesses(),
      new ScriptedIncarnations(),
      new SystemMillisecondClock(),
    );

    // Act
    const claim = await subject.acquire({
      lockPath: join(root, 'lifecycle', 'fyd.lock'),
      verb: 'restart',
      waitMs: 0,
      waiting: neverWaits,
      reclaimed: neverReclaims,
    });

    // Assert
    should(await claim.release()).be.undefined();
  });
});

describe('a claim whose holder has exited', () => {
  const HERE: ProcessScope = { boot: 'boot-a', namespace: 'pid:[4026531836]' };
  const OWNER = 4_242;
  const claimed = (holder: ProcessScope & { readonly start: string }) => ({
    owner: OWNER,
    token: 'abandoned',
    verb: 'start',
    at: 1_785_974_400_000,
    holder,
  });

  async function abandonedClaim(holder: ProcessScope & { readonly start: string }): Promise<string> {
    const root = await createTemporaryRoot();
    const lockPath = join(root, 'lifecycle', 'fyd.lock');
    await mkdir(lockPath, { recursive: true });
    await writeFile(join(lockPath, 'claim-abandoned.json'), JSON.stringify(claimed(holder)));
    return lockPath;
  }

  it.each([
    { name: 'no process of that number is left', seen: { kind: 'gone' } as const, scope: HERE },
    {
      name: 'the number now belongs to a process that started later',
      seen: { kind: 'running', start: '999' } as const,
      scope: HERE,
    },
    {
      name: 'the claim was made on an earlier boot',
      seen: { kind: 'running', start: '100' } as const,
      scope: { ...HERE, boot: 'boot-b' },
    },
  ])('should remove it and say so when $name', async ({ seen, scope }) => {
    // Arrange — the e2e defect: a killed `fy daemon start` left this behind, and every mutating verb
    // on the host waited 140 seconds and then blamed "another PID namespace" for a process that had
    // simply died. Inside the holder's own scope that verdict is a proof, not a guess.
    const lockPath = await abandonedClaim({ ...HERE, start: '100' });
    const removed: string[] = [];

    // Act
    const claim = await lock(
      new ScriptedProcesses(seen.kind === 'running'),
      new ScriptedIncarnations(scope, new Map([[OWNER, seen]])),
    ).acquire({
      lockPath,
      verb: 'stop',
      waitMs: 0,
      waiting: neverWaits,
      reclaimed: holder => removed.push(holder),
    });

    // Assert — taken at once, with the removal named, and the dead holder's proof is gone.
    should(removed).deepEqual(['start (owner 4242, since 2026-08-06T00:00:00.000Z), which is no longer running']);
    should((await readdir(lockPath)).includes('claim-abandoned.json')).be.false();
    should(await claim.release()).be.undefined();
  });

  it('should leave a live holder in its own scope alone', async () => {
    // Arrange — same scope, same start time: this is the very process that took the claim.
    const lockPath = await abandonedClaim({ ...HERE, start: '100' });
    const incarnations = new ScriptedIncarnations(HERE, new Map([[OWNER, { kind: 'running', start: '100' }]]));

    // Act + Assert — and the PROCESS port is told the owner is dead, to show it is not what decided.
    await should(
      lock(new ScriptedProcesses(false), incarnations).acquire({
        lockPath,
        verb: 'stop',
        waitMs: 0,
        waiting: neverWaits,
        reclaimed: neverReclaims,
      }),
    ).be.rejectedWith(/held by start \(owner 4242, since 2026-08-06T00:00:00.000Z\): that owner is still running/u);
  });

  it('should name another PID namespace only when the claim proves the holder was in one', async () => {
    // Arrange — a container sharing this /tmp: its pid numbers mean nothing here.
    const lockPath = await abandonedClaim({ ...HERE, namespace: 'pid:[4026532999]', start: '100' });
    const incarnations = new ScriptedIncarnations(HERE, new Map([[OWNER, { kind: 'gone' }]]));

    // Act
    const refusal = lock(new ScriptedProcesses(false), incarnations).acquire({
      lockPath,
      verb: 'stop',
      waitMs: 0,
      waiting: neverWaits,
      reclaimed: neverReclaims,
    });

    // Assert
    await should(refusal).be.rejectedWith(/that owner runs in another PID namespace/u);
    await should(refusal).be.rejectedWith(/verify independently that no lifecycle command is running/u);
    should(await readdir(lockPath)).deepEqual(['claim-abandoned.json']);
  });

  it('should decide nothing when this invocation cannot say which scope it is in', async () => {
    // Arrange — a recorded holder, read on a host that offers neither source.
    const lockPath = await abandonedClaim({ ...HERE, start: '100' });

    // Act + Assert
    await should(
      lock(new ScriptedProcesses(false), new ScriptedIncarnations()).acquire({
        lockPath,
        verb: 'stop',
        waitMs: 0,
        waiting: neverWaits,
        reclaimed: neverReclaims,
      }),
    ).be.rejectedWith(/does not record enough to prove it has exited/u);
  });

  it('should fall back to the liveness answer when its own scope cannot see the owner', async () => {
    // Arrange — same scope, but this host would not answer for that pid.
    const lockPath = await abandonedClaim({ ...HERE, start: '100' });

    // Act + Assert
    await should(
      lock(new ScriptedProcesses(true), new ScriptedIncarnations(HERE)).acquire({
        lockPath,
        verb: 'stop',
        waitMs: 0,
        waiting: neverWaits,
        reclaimed: neverReclaims,
      }),
    ).be.rejectedWith(/that owner is still running/u);
  });

  it('should try a removal once and then say the claim could not be removed', async () => {
    // Arrange — a claim directory nobody may write into, so the dead holder's proof cannot be unlinked.
    const lockPath = await abandonedClaim({ ...HERE, start: '100' });
    await chmod(lockPath, 0o500);
    const removed: string[] = [];

    // Act
    const refusal = lock(
      new ScriptedProcesses(false),
      new ScriptedIncarnations(HERE, new Map([[OWNER, { kind: 'gone' }]])),
    ).acquire({
      lockPath,
      verb: 'stop',
      waitMs: 0,
      waiting: neverWaits,
      reclaimed: holder => removed.push(holder),
    });

    // Assert — one attempt, one notice, then the refusal names the directory to clear.
    await should(refusal).be.rejectedWith(
      /that owner is no longer running, but its claim could not be removed; remove /u,
    );
    should(removed).have.length(1);
    await chmod(lockPath, 0o700);
  });

  it('should recognise a real invocation that was killed while holding the claim', async () => {
    // Arrange — the shape of the e2e repro with nothing scripted: a separate `bun` takes the claim
    // with the shipped adapters and is SIGKILLed inside it, so it never releases.
    const root = await createTemporaryRoot();
    const script = await contenderScript(root);
    const lockPath = join(root, 'lifecycle', 'fyd.lock');
    const journal = join(root, 'journal.txt');
    await writeFile(journal, '');
    const holder = Bun.spawn([process.execPath, script, lockPath, journal, 'killed', '60000', '0'], {
      stdout: 'ignore',
      stderr: 'ignore',
    });
    await waitFor(
      async () => (await readFile(journal, 'utf8')).includes('enter killed'),
      'the holder to enter the claim',
    );
    holder.kill('SIGKILL');
    await holder.exited;
    const processes = new BunDaemonProcess();
    const removed: string[] = [];

    // Act
    const claim = await lock(processes, new HostProcessIncarnations(processes)).acquire({
      lockPath,
      verb: 'start',
      waitMs: 0,
      waiting: neverWaits,
      reclaimed: notice => removed.push(notice),
    });

    // Assert — no wait, no refusal, and the removal says whose claim it was.
    should(removed).have.length(1);
    should(removed[0]).match(
      new RegExp(`^start \\(owner ${String(holder.pid)}, since .*\\), which is no longer running$`, 'u'),
    );
    should(await claim.release()).be.undefined();
  });
});
