import { afterEach, describe, it } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { StateFileSystem } from '../../src/adapters/filesystem/state-file-system.ts';
import { createFoundationPaths } from '../../src/lib/paths.ts';
import { resolveStateHome } from '../../src/lib/state-home.ts';

const temporaryDirectories: string[] = [];

async function fixture(): Promise<{
  readonly root: string;
  readonly paths: ReturnType<typeof createFoundationPaths>;
  readonly files: StateFileSystem;
}> {
  const root = await mkdtemp(join(tmpdir(), 'fy-state-fleet-links-'));
  temporaryDirectories.push(root);
  const paths = createFoundationPaths(
    resolveStateHome({ fyHome: join(root, 'fy-home'), homeDirectory: join(root, 'user') }),
  );
  return { root, paths, files: new StateFileSystem(paths) };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('StateFileSystem fleet history links', () => {
  it('should read through a provisioner-owned account link into this daemon shared pool', async () => {
    const subject = await fixture();
    const pooled = join(subject.paths.fleet, 'shared', 'claude', 'projects');
    const linked = join(subject.paths.fleet, 'homes', 'work', 'projects');
    await mkdir(pooled, { recursive: true });
    await mkdir(join(subject.paths.fleet, 'homes', 'work'), { recursive: true });
    await writeFile(join(pooled, 'conversation.jsonl'), '{"type":"user"}\n');
    await symlink(pooled, linked);

    const actual = await subject.files.readText(join(linked, 'conversation.jsonl'));

    should(actual).equal('{"type":"user"}\n');
  });

  it('should refuse an account-home link whose resolved target leaves the shared pool', async () => {
    const subject = await fixture();
    const outside = join(subject.root, 'outside');
    const linked = join(subject.paths.fleet, 'homes', 'work', 'projects');
    await mkdir(outside, { recursive: true });
    await mkdir(join(subject.paths.fleet, 'homes', 'work'), { recursive: true });
    await writeFile(join(outside, 'conversation.jsonl'), 'outside\n');
    await symlink(outside, linked);

    const error = await subject.files.readText(join(linked, 'conversation.jsonl')).catch(value => value);

    should(String(error)).match(/symbolic links are not allowed inside the state home/u);
  });

  it('should keep refusing a shared-pool link everywhere outside fleet homes', async () => {
    const subject = await fixture();
    const pooled = join(subject.paths.fleet, 'shared', 'codex', 'sessions');
    const linked = join(subject.paths.index, 'sessions');
    await mkdir(pooled, { recursive: true });
    await mkdir(subject.paths.index, { recursive: true });
    await writeFile(join(pooled, 'rollout.jsonl'), 'pooled\n');
    await symlink(pooled, linked);

    const error = await subject.files.readText(join(linked, 'rollout.jsonl')).catch(value => value);

    should(String(error)).match(/symbolic links are not allowed inside the state home/u);
  });

  it('should reject an escaping link nested behind an allowed fleet-history link', async () => {
    const subject = await fixture();
    const pooled = join(subject.paths.fleet, 'shared', 'claude', 'projects');
    const linked = join(subject.paths.fleet, 'homes', 'work', 'projects');
    const outside = join(subject.root, 'outside');
    await mkdir(pooled, { recursive: true });
    await mkdir(outside, { recursive: true });
    await mkdir(join(subject.paths.fleet, 'homes', 'work'), { recursive: true });
    await writeFile(join(outside, 'secret'), 'not fleet state\n');
    await symlink(outside, join(pooled, 'escape'));
    await symlink(pooled, linked);

    const error = await subject.files.readText(join(linked, 'escape', 'secret')).catch(value => value);

    should(String(error)).match(/symbolic links are not allowed inside the state home/u);
  });
});
