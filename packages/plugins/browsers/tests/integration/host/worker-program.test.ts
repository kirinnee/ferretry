import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { processHost } from '../../../daemon/adapters/host.ts';
import { BROWSER_WORKER_NAME } from '../../../daemon/worker/program.ts';

/**
 * `processHost().workerProgram()` against the real file system and the real `process.execPath`: where the compiled
 * worker is looked for (beside the daemon as invoked AND as resolved through a symlink, the Homebrew / Nix layout) and
 * what happens when the daemon's own executable cannot be resolved. The daemon's executable is the one thing a test
 * can move, so each case points `process.execPath` at a temp folder and puts it back.
 */

const roots: string[] = [];
const realExecPath = process.execPath;

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ferretry-worker-program-'));
  roots.push(root);
  return root;
}

async function executable(path: string): Promise<void> {
  await writeFile(path, '#!/bin/sh\n');
  await chmod(path, 0o700);
}

afterEach(async () => {
  process.execPath = realExecPath;
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('browsers host — the worker program beside the daemon', () => {
  it('should find the compiled worker beside the real executable a symlink points at', async () => {
    const root = await workspace();
    await mkdir(join(root, 'real'));
    await mkdir(join(root, 'link'));
    await executable(join(root, 'real', 'fyd'));
    await executable(join(root, 'real', BROWSER_WORKER_NAME));
    await symlink(join(root, 'real', 'fyd'), join(root, 'link', 'fyd'));
    process.execPath = join(root, 'link', 'fyd');

    const program = processHost({}).workerProgram();

    should(program).eql({ kind: 'executable', path: join(await realpath(root), 'real', BROWSER_WORKER_NAME) });
  });

  it('should find the compiled worker beside the executable as it was invoked', async () => {
    const root = await workspace();
    await executable(join(root, 'fyd'));
    await executable(join(root, BROWSER_WORKER_NAME));
    process.execPath = join(root, 'fyd');

    const program = processHost({}).workerProgram();

    should(program.kind).equal('executable');
    should(program.kind === 'executable' ? program.path.endsWith(`/${BROWSER_WORKER_NAME}`) : false).equal(true);
  });

  it('should search where the daemon was invoked when its executable cannot be resolved', async () => {
    const root = await workspace();
    await executable(join(root, BROWSER_WORKER_NAME));
    process.execPath = join(root, 'fyd');

    const program = processHost({}).workerProgram();

    should(program).eql({ kind: 'executable', path: join(root, BROWSER_WORKER_NAME) });
  });

  it('should run the source worker from a checkout when no compiled worker sits beside the daemon', async () => {
    const root = await workspace();
    process.execPath = join(root, 'fyd');

    const program = processHost({}).workerProgram();

    should(program.kind).equal('source');
    should(program.kind === 'source' ? program.entry.endsWith('/worker/adapters/main.ts') : false).equal(true);
  });

  it('should take the operator overrides over anything beside the daemon', async () => {
    const root = await workspace();
    process.execPath = join(root, 'fyd');

    should(processHost({ FY_BROWSER_WORKER_BIN: '/opt/fyd-browser-worker' }).workerProgram()).eql({
      kind: 'executable',
      path: '/opt/fyd-browser-worker',
    });
    should(processHost({ FY_BROWSER_WORKER_SOURCE: '/src/main.ts' }).workerProgram()).eql({
      kind: 'source',
      entry: '/src/main.ts',
    });
  });
});
