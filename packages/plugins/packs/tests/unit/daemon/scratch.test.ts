import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scratchDecision } from '../../../daemon/lib/hooks.ts';
import {
  COMMON_SCRATCH_ROOTS,
  isScratchPath,
  resolveScratchRoots,
  scratchRefusal,
} from '../../../daemon/lib/scratch.ts';

const ROOTS = [...COMMON_SCRATCH_ROOTS, '/var/tmp/own'];

describe('a folder a helper may not start in (today’s scratch.ts)', () => {
  test('a temporary root and everything under it is scratch, a trailing slash or not', () => {
    for (const path of ['/tmp', '/tmp/', '/tmp/claude-1000/x', '/private/var/folders/ab/cd', '/var/tmp/own/y'])
      expect(isScratchPath(path, ROOTS)).toBe(true);
  });

  test('a project folder, and a name that only starts like a root, is not', () => {
    for (const path of ['/home/me/work', '/tmpfoo', '/tmp-work/x', '/var/tmpx', '/'])
      expect(isScratchPath(path, ROOTS)).toBe(false);
  });

  test('an empty or root-only entry in the roots never matches everything', () => {
    expect(isScratchPath('/home/me/work', ['', '/', '//'])).toBe(false);
  });

  test('the refusal names the folder and both ways out', () => {
    const sentence = scratchRefusal('/tmp/claude-1/x');
    expect(sentence).toContain('/tmp/claude-1/x is a temporary folder, not a project');
    expect(sentence).toContain('--cwd');
    expect(sentence).toContain('--allow-scratch');
  });
});

describe('start.decide’s temporary-folder check', () => {
  const scratch = { folder: '/tmp/w', by: 'ferret' } as const;

  test('a start that asked the check (allowScratch false) in a temporary folder is refused with the sentence', () => {
    expect(scratchDecision({ ...scratch, allowScratch: false }, ROOTS)).toEqual({
      allow: false,
      reason: scratchRefusal('/tmp/w'),
    });
  });

  test('--allow-scratch (true), no check asked (absent, as `fy start`), a relaunch and a project folder are none of its business', () => {
    expect(scratchDecision({ ...scratch, allowScratch: true }, ROOTS)).toBeUndefined();
    expect(scratchDecision(scratch, ROOTS)).toBeUndefined();
    expect(scratchDecision({ ...scratch, by: 'resume', allowScratch: false }, ROOTS)).toBeUndefined();
    expect(scratchDecision({ folder: '/home/me/work', by: 'owner', allowScratch: false }, ROOTS)).toBeUndefined();
  });
});

describe('the check judges the directory the start will REALLY be in, not its spelling (v4 realpathed both sides)', () => {
  const base = mkdtempSync(join(tmpdir(), 'packs-scratch-'));
  const scratch = join(base, 'scratch');
  const project = join(base, 'project');
  mkdirSync(scratch);
  mkdirSync(project);
  // A link spelled inside the temporary root that leads to a normal project; a link inside the project that leads out to it.
  symlinkSync(project, join(scratch, 'project-link'));
  symlinkSync(scratch, join(project, 'to-scratch'));
  // The temporary root itself spelled through a link (`/tmp` -> `/private/tmp` on a Mac).
  symlinkSync(scratch, join(base, 'root-link'));
  afterAll(() => rmSync(base, { recursive: true, force: true }));
  const asked = (spelled: string) =>
    ({ folder: spelled, realFolder: realpathSync(spelled), by: 'ferret', allowScratch: false }) as const;

  test('a link spelled in the temporary root, leading to a normal project, is allowed', async () => {
    const roots = await resolveScratchRoots([scratch], realpath);
    expect(scratchDecision(asked(join(scratch, 'project-link')), roots)).toBeUndefined();
  });

  test('a link in the project, leading into the temporary root, is refused (naming the real folder)', async () => {
    const roots = await resolveScratchRoots([scratch], realpath);
    const decision = scratchDecision(asked(join(project, 'to-scratch')), roots);
    expect(decision).toEqual({ allow: false, reason: scratchRefusal(realpathSync(scratch)) });
  });

  test('a root that is itself spelled through a link still holds what is really inside it', async () => {
    const roots = await resolveScratchRoots([join(base, 'root-link')], realpath);
    mkdirSync(join(scratch, 'inside'));
    expect(scratchDecision(asked(join(scratch, 'inside')), roots)).toMatchObject({ allow: false });
  });

  test('a root that cannot be resolved stays as spelled; nothing throws', async () => {
    const roots = await resolveScratchRoots(['/no/such/root-xyz'], realpath);
    expect(roots).toEqual(['/no/such/root-xyz']);
  });
});
