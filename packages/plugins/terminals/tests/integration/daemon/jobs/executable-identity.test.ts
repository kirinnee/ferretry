import { afterEach, describe, it } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  executableIdentityOf,
  fileIdentity,
  scriptWord,
  trustedExecutables,
} from '../../../../daemon/adapters/jobs/executable-identity.ts';
import { keeper, type Keeper } from '../support/job-keeper.ts';
import { waitForValue } from '../support/wait-for.ts';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const undo of cleanups.splice(0).reverse()) await undo();
});

const person = { by: 'person' } as const;
const noLsof = async () => ({ exitCode: 1, stdout: '' });
const reads = { platform: 'linux', lsof: noLsof } as const;

/**
 * A scratch folder holding a copy of `bash` named `fy`: the stand-in for the real executable. (`sleep` is one multi-call
 * binary here, so a copy of it refuses to run under another name.) `sleep` in the result is the ORIGINAL bash: another file.
 */
function standIn(): { dir: string; fy: string; sleep: string } {
  const dir = mkdtempSync(join(tmpdir(), 'fy-exe-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const sleep = Bun.which('bash');
  if (sleep === null) throw new Error('bash is required');
  const fy = join(dir, 'fy');
  copyFileSync(sleep, fy);
  return { dir, fy, sleep };
}

/** Starts `exec -a "<argv0>" <program> -c 'sleep 60; true'` under bash, so its command line says what the test wants and its file is the program. */
async function spawnAs(argv0: string, program: string): Promise<number> {
  const bash = Bun.which('bash');
  if (bash === null) throw new Error('bash is required');
  const child = Bun.spawn([bash, '-c', `exec -a "${argv0}" "${program}" -c 'sleep 60; true'`], {
    stdout: 'ignore',
    stderr: 'ignore',
  });
  cleanups.push(() => child.kill('SIGKILL'));
  // `exec` replaces bash in place, so the pid is the child's own; wait until the new image is what runs.
  await waitForValue(async () => {
    const text = await Bun.file(`/proc/${child.pid}/cmdline`)
      .text()
      .catch(() => '');
    return text.startsWith(argv0) ? true : undefined;
  }, 'the stand-in to exec');
  return child.pid;
}

describe('which file a process runs (Linux procfs)', () => {
  it('should tell a copy of fy from the program that only says it is fy', async () => {
    // Arrange
    const { fy, sleep } = standIn();
    const real = await spawnAs('fy job attach x', fy);
    const forged = await spawnAs('fy job attach x', sleep);

    // Act
    const realId = await executableIdentityOf(real, reads);
    const forgedId = await executableIdentityOf(forged, reads);

    // Assert
    should(realId).equal(await fileIdentity(fy));
    should(forgedId).equal(await fileIdentity(sleep));
    should(realId).not.equal(forgedId);
  });

  it('should answer unknown for a process it cannot read, and on a platform it cannot read', async () => {
    should(await executableIdentityOf(2_147_483_000, reads)).equal('unknown');
    should(await executableIdentityOf(process.pid, { platform: 'freebsd', lsof: noLsof })).equal('unknown');
  });

  it('should name the script a runtime runs, so the runtime alone proves nothing', async () => {
    // Arrange — `bun <dir>/fy.ts job attach x` is the source-checkout shape.
    const dir = mkdtempSync(join(tmpdir(), 'fy-script-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const script = join(dir, 'fy.ts');
    writeFileSync(script, 'setInterval(() => undefined, 1000);\n');
    const child = Bun.spawn([process.execPath, script, 'job', 'attach', 'x'], { stdout: 'ignore', stderr: 'ignore' });
    cleanups.push(() => child.kill('SIGKILL'));
    await waitForValue(
      async () => ((await executableIdentityOf(child.pid, reads)) === 'unknown' ? undefined : true),
      'bun',
    );

    // Act
    const identity = await executableIdentityOf(child.pid, reads);

    // Assert
    should(identity).equal(`${await fileIdentity(process.execPath)}#${realpathSync(script)}`);
  });
});

describe('the fy executables the daemon knows', () => {
  it('should trust the fy beside the daemon and the one on its search path, and nothing else', async () => {
    const { dir, fy, sleep } = standIn();
    const elsewhere = join(dir, 'elsewhere');
    mkdirSync(elsewhere);
    const onPath = join(elsewhere, 'fy');
    symlinkSync(fy, onPath);
    const trusted = await trustedExecutables({
      execPath: join(dir, 'fyd'),
      which: async () => onPath,
      binaryName: 'fy',
    });
    should(trusted).deepEqual([(await fileIdentity(fy)) as string]);
    should(trusted).not.containEql(await fileIdentity(sleep));
  });

  it('should never trust a bare JavaScript runtime, even when something named fy links to it', async () => {
    const { dir } = standIn();
    const link = join(dir, 'fy');
    rmSync(link);
    symlinkSync(process.execPath, link);
    const trusted = await trustedExecutables({ execPath: join(dir, 'fyd'), which: async () => link, binaryName: 'fy' });
    should(trusted).deepEqual([]);
  });

  it('should trust the runtime only together with the checkout’s own entry script', async () => {
    const { dir } = standIn();
    const entry = join(dir, 'bin-fy.ts');
    writeFileSync(entry, '');
    const trusted = await trustedExecutables({
      execPath: process.execPath,
      which: async () => undefined,
      sourceEntry: entry,
      binaryName: 'fy',
    });
    should(trusted).deepEqual([`${await fileIdentity(process.execPath)}#${realpathSync(entry)}`]);
  });

  it('should read the script word the way a runtime is invoked', () => {
    should(scriptWord(['bun', 'run', '--silent', '/w/fy.ts', 'job'])).equal('/w/fy.ts');
    should(scriptWord(['bun'])).be.undefined();
  });
});

describe('the keeper refuses a process that only reads like `fy job attach` (real processes)', () => {
  const started: Keeper[] = [];
  afterEach(async () => {
    for (const each of started.splice(0)) await each.dispose();
  });

  it('should refuse the forged argv at the registry and list only the real one', async () => {
    // Arrange
    const { fy, sleep } = standIn();
    const k = await keeper({ realProof: true });
    started.push(k);
    k.proof.trusted = [(await fileIdentity(fy)) as string];
    const service = k.service();
    const job = await service.start('ferret-a', { command: 'sleep 60' }, person);
    const forged = await spawnAs('fy job attach x', sleep);
    const real = await spawnAs('fy job attach x', fy);

    // Act
    const refusal = await service.registerAttachment('ferret-a', { jobId: job.id, pid: forged }).then(
      () => undefined,
      (error: unknown) => error,
    );
    const accepted = await service.registerAttachment('ferret-a', { jobId: job.id, pid: real });

    // Assert
    should(String(refusal)).match(/does not run the `fy` executable this daemon knows/u);
    should(accepted.pid).equal(real);
    should((await service.keptAttachments('ferret-a')).map(entry => entry.pid)).deepEqual([real]);
  });
});
