import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { SystemMillisecondClock } from '../../../src/adapters/daemon/clock.ts';
import { DaemonLifecycleBusyError, FileDaemonLifecycleLock } from '../../../src/adapters/daemon/lifecycle-lock.ts';
import type { CommandOutcome, IDaemonProcessPort } from '../../../src/lib/daemon/ports.ts';

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
}

function lock(processes: IDaemonProcessPort = new ScriptedProcesses()): FileDaemonLifecycleLock {
  return new FileDaemonLifecycleLock(processes, new SystemMillisecondClock(), { pollMs: 1 });
}

/** Nothing is expected to contend in most of these, so a notice is a failure the test should see. */
const neverWaits = (holder: string): void => {
  throw new Error(`did not expect to wait for ${holder}`);
};

/**
 * A contender in its own invocation: acquires, journals its window, then releases.
 *
 * Written to disk and run through a separate `bun` because that is the shape of the defect — the CLI
 * has no long-lived task, so every lifecycle command is a fresh invocation that knows nothing about
 * any other.
 */
const CONTENDER = (adapters: string): string => `
import { appendFileSync } from 'node:fs';
import { FileDaemonLifecycleLock } from '${adapters}/lifecycle-lock.ts';
import { BunDaemonProcess } from '${adapters}/process.ts';
import { SystemMillisecondClock } from '${adapters}/clock.ts';

const [lockPath, journal, name, holdMs, waitMs, rendezvous] = Bun.argv.slice(2);
const lock = new FileDaemonLifecycleLock(new BunDaemonProcess(), new SystemMillisecondClock(), { pollMs: 5 });
try {
  const claim = await lock.acquire({
    lockPath,
    verb: 'start',
    waitMs: Number(waitMs),
    waiting: holder => appendFileSync(journal, \`waiting \${name}: \${holder}\\n\`),
  });
  appendFileSync(journal, \`enter \${name}\\n\`);
  if (rendezvous === undefined) {
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
    // Arrange — two independent invocations, each holding for long enough that an unserialized pair
    // would certainly overlap.
    const root = await createTemporaryRoot();
    const script = await contenderScript(root);
    const lockPath = join(root, 'lifecycle', 'fyd.lock');
    const journal = join(root, 'journal.txt');
    await writeFile(journal, '');

    // Act
    const [first, second] = await Promise.all([
      contend(script, [lockPath, journal, 'first', '300', '30000']),
      contend(script, [lockPath, journal, 'second', '300', '30000']),
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
    const claim = await lock().acquire({ lockPath, verb: 'restart', waitMs: 0, waiting: neverWaits });

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
    const held = await lock().acquire({ lockPath, verb: 'start', waitMs: 0, waiting: neverWaits });
    const notices: string[] = [];

    // Act — the successor queues, the holder releases, and the successor gets in.
    const successor = lock().acquire({
      lockPath,
      verb: 'stop',
      waitMs: 30_000,
      waiting: holder => notices.push(holder),
    });
    await Bun.sleep(20);
    const residue = await held.release();
    const second = await successor;

    // Assert — and the notice named the verb that was holding it, not just that something was.
    should(residue).be.undefined();
    should(notices).have.length(1);
    should(notices[0]).match(/held by start \(owner \d+/u);
    should(await second.release()).be.undefined();
    should(await readdir(join(root, 'lifecycle'))).be.empty();
  });

  it('should report a non-visible owner without declaring its live claim abandoned', async () => {
    // Arrange — the crash case, stated out loud: a killed lifecycle command leaves its claim behind,
    // and nothing takes it over automatically. Exact-name unlink plus rmdir would be race-safe; the
    // unsafe input is the liveness verdict, because a live owner in another PID namespace can look
    // dead here. Availability loses until a person independently rules out a live holder.
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
    });

    // Assert
    await should(refusal).be.rejectedWith(DaemonLifecycleBusyError);
    await should(refusal).be.rejectedWith(/owner 4242, since 2026-08-06T00:00:00.000Z/u);
    await should(refusal).be.rejectedWith(/not visible from this invocation's PID namespace/u);
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
    await should(lock().acquire({ lockPath, verb: 'start', waitMs: 0, waiting: neverWaits })).be.rejectedWith(
      /that owner is still running/u,
    );
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
    await should(lock().acquire({ lockPath, verb: 'start', waitMs: 0, waiting: neverWaits })).be.rejectedWith(
      /could not be read, so it may have been released in the meantime/u,
    );
  });

  it('should treat a file sitting on the claim name as contention, not as a free name', async () => {
    // Arrange — a regular file there is a different error code and the same answer: something holds
    // the name and this attempt must not remove it.
    const root = await createTemporaryRoot();
    const lockPath = join(root, 'lifecycle', 'fyd.lock');
    await mkdir(join(root, 'lifecycle'), { recursive: true });
    await writeFile(lockPath, 'left by something else');

    // Act + Assert
    await should(lock().acquire({ lockPath, verb: 'start', waitMs: 0, waiting: neverWaits })).be.rejectedWith(
      DaemonLifecycleBusyError,
    );
    should(await readFile(lockPath, 'utf8')).equal('left by something else');
  });

  it('should take a name left empty by an interrupted release', async () => {
    // Arrange — an empty directory is residue, not a claim: a claim is published whole in one rename
    // and is never observed empty, so refusing this would block every later lifecycle command.
    const root = await createTemporaryRoot();
    const lockPath = join(root, 'lifecycle', 'fyd.lock');
    await mkdir(lockPath, { recursive: true });

    // Act
    const claim = await lock().acquire({ lockPath, verb: 'start', waitMs: 0, waiting: neverWaits });

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
      }),
    ).be.rejectedWith(/EEXIST/u);
  });

  it('should leave a successor alone when the claim it held was cleared and re-taken', async () => {
    // Arrange — the sequence the refusal itself invites: a person clears an abandoned claim and
    // somebody else takes the freed name. The superseded holder must not delete theirs.
    const root = await createTemporaryRoot();
    const lockPath = join(root, 'lifecycle', 'fyd.lock');
    const superseded = await lock().acquire({ lockPath, verb: 'start', waitMs: 0, waiting: neverWaits });
    await rm(lockPath, { recursive: true, force: true });
    const successor = await lock().acquire({ lockPath, verb: 'restart', waitMs: 0, waiting: neverWaits });

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
    const claim = await lock().acquire({ lockPath, verb: 'start', waitMs: 0, waiting: neverWaits });
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
    const claim = await lock().acquire({ lockPath, verb: 'start', waitMs: 0, waiting: neverWaits });
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
    const claim = await lock().acquire({ lockPath, verb: 'start', waitMs: 0, waiting: neverWaits });
    await rm(lockPath, { recursive: true, force: true });

    // Act + Assert
    should(await claim.release()).be.undefined();
  });

  it('should use the shipped poll cadence when none is configured', async () => {
    // Arrange
    const root = await createTemporaryRoot();
    const subject = new FileDaemonLifecycleLock(new ScriptedProcesses(), new SystemMillisecondClock());

    // Act
    const claim = await subject.acquire({
      lockPath: join(root, 'lifecycle', 'fyd.lock'),
      verb: 'snapshot promote',
      waitMs: 0,
      waiting: neverWaits,
    });

    // Assert
    should(await claim.release()).be.undefined();
  });
});
