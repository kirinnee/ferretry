import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import {
  PsProcessIncarnation,
  ProcStatProcessIncarnation,
  processIncarnationFor,
  procStatStartTicks,
  psStartSeconds,
  UnsupportedProcessIncarnation,
} from '../../../../src/adapters/index.ts';

const cleanups = new Set<string>();

afterEach(async () => {
  for (const path of cleanups) await rm(path, { recursive: true, force: true });
  cleanups.clear();
});

async function scratch(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'ferretry-incarnation-'));
  cleanups.add(path);
  return path;
}

/** A stand-in `ps` that answers with whatever the test hands it, so the macOS path runs on Linux. */
async function fakePs(body: string): Promise<string> {
  const path = join(await scratch(), 'ps');
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

function hostPs(): string {
  const found = Bun.which('ps');
  if (found === null) throw new Error('ps is required for process-incarnation integration coverage');
  return found;
}

function stat(command: string, startTicks: string): string {
  const after = ['S', ...Array.from({ length: 18 }, (_, index) => String(index + 1)), startTicks, '0'];
  return `4242 (${command}) ${after.join(' ')}\n`;
}

describe('procStatStartTicks', () => {
  it('reads field 22 even when the command name holds spaces and parentheses', () => {
    should(procStatStartTicks(stat('a (b) c', '987654'))).equal(987654);
  });

  it('refuses text with no command name, too few fields, or a non-positive start', () => {
    should(procStatStartTicks('no parenthesis here')).be.undefined();
    should(procStatStartTicks('4242 (sh) S 1 2')).be.undefined();
    should(procStatStartTicks(stat('sh', '0'))).be.undefined();
    should(procStatStartTicks(stat('sh', 'x'))).be.undefined();
  });
});

describe('ProcStatProcessIncarnation', () => {
  it('reads a stat file under the configured root and answers undefined for a pid that has none', async () => {
    const root = await scratch();
    await mkdir(join(root, '77'));
    await writeFile(join(root, '77', 'stat'), stat('sleep', '31337'));
    const incarnation = new ProcStatProcessIncarnation(root);
    should(await incarnation.startOf(77)).equal(31337);
    should(await incarnation.startOf(78)).be.undefined();
  });
});

describe('psStartSeconds', () => {
  it('reads the C-locale lstart text as UTC epoch seconds, including a space-padded day', () => {
    should(psStartSeconds('Sat Sep 26 18:48:09 2026\n')).equal(Date.UTC(2026, 8, 26, 18, 48, 9) / 1000);
    should(psStartSeconds('  Sun Sep  6 01:02:03 2026')).equal(Date.UTC(2026, 8, 6, 1, 2, 3) / 1000);
  });

  it('refuses localised, unknown-month, empty or epoch text', () => {
    should(psStartSeconds('sam. 26 sept. 18:48:09 2026')).be.undefined();
    should(psStartSeconds('Sat Xyz 26 18:48:09 2026')).be.undefined();
    should(psStartSeconds('')).be.undefined();
    should(psStartSeconds('Thu Jan  1 00:00:00 1970')).be.undefined();
  });
});

describe('PsProcessIncarnation', () => {
  it('gives one live process the same identity on every read and a missing pid none', async () => {
    const incarnation = new PsProcessIncarnation(hostPs());
    const first = await incarnation.startOf(process.pid);
    should(first).be.a.Number();
    should(await incarnation.startOf(process.pid)).equal(first);
    // 2^22 is above Linux's pid_max ceiling and macOS's 99999, so nothing can hold it.
    should(await incarnation.startOf(4_194_304)).be.undefined();
  });

  it('pins the C locale and UTC so the text cannot drift with the environment', async () => {
    const ps = await fakePs(
      '[ "$LC_ALL" = C ] && [ "$TZ" = UTC0 ] && [ "$1 $2 $3 $4" = "-o lstart= -p 9" ] && echo "Sat Sep 26 18:48:09 2026"',
    );
    should(await new PsProcessIncarnation(ps).startOf(9)).equal(Date.UTC(2026, 8, 26, 18, 48, 9) / 1000);
  });

  it('answers undefined for a failed ps, an unreadable answer, a bad pid, or a ps that cannot run', async () => {
    should(await new PsProcessIncarnation(await fakePs('exit 1')).startOf(9)).be.undefined();
    should(await new PsProcessIncarnation(await fakePs('echo garbage')).startOf(9)).be.undefined();
    const ps = new PsProcessIncarnation(await fakePs('echo "Sat Sep 26 18:48:09 2026"'));
    should(await ps.startOf(0)).be.undefined();
    should(await ps.startOf(1.5)).be.undefined();
    should(await new PsProcessIncarnation(join(await scratch(), 'absent-ps')).startOf(9)).be.undefined();
  });

  it('refuses a relative executable so a minimal PATH can never pick one', () => {
    should(() => new PsProcessIncarnation('ps')).throw(/absolute path/u);
  });
});

describe('processIncarnationFor', () => {
  it('picks /proc on Linux, ps on macOS, and a refusal that names the platform elsewhere', async () => {
    should(processIncarnationFor('linux')).be.instanceOf(ProcStatProcessIncarnation);
    should(processIncarnationFor('darwin')).be.instanceOf(PsProcessIncarnation);
    should(processIncarnationFor().constructor).equal(processIncarnationFor(process.platform).constructor);
    const other = processIncarnationFor('freebsd');
    should(other).be.instanceOf(UnsupportedProcessIncarnation);
    await should(other.startOf(1)).be.rejectedWith(/sessions cannot start on freebsd.*Linux and macOS/u);
  });
});
