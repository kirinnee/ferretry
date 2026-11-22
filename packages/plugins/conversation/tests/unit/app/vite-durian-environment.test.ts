/**
 * The stylesheet child sees `PATH` and nothing else (r12 H8, Opus review of H1). Durian's `scripts/build-css.ts` arrives from a git
 * dependency and runs as code in every Vite build; the build's environment (tokens, credentials) is not its business.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStyleBuild, styleBuildEnvironment } from '../../../app/vite-durian.ts';

const scratch = mkdtempSync(join(tmpdir(), 'fy-durian-env-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('the stylesheet build environment', () => {
  it('is PATH alone, however much the build was started with', () => {
    expect(
      styleBuildEnvironment({ PATH: '/bin', HOME: '/home/x', GITHUB_TOKEN: 't', NPM_TOKEN: 'n', FY_SECRET: 's' }),
    ).toEqual({ PATH: '/bin' });
  });

  it('is empty when the build has no PATH, never an undefined entry', () => {
    expect(styleBuildEnvironment({ HOME: '/home/x' })).toEqual({});
  });

  it('is all the child is given: a canary in the build’s environment never reaches it', () => {
    // A `bun` that only records what it was started with; the real one would print CSS.
    const record = join(scratch, 'seen.txt');
    const shim = join(scratch, 'bun');
    writeFileSync(shim, `#!/bin/sh\n/usr/bin/env > ${JSON.stringify(record)}\n`);
    chmodSync(shim, 0o755);
    runStyleBuild('/nowhere', {
      PATH: `${scratch}:${process.env.PATH ?? ''}`,
      FY_H8_CANARY: 'must-not-arrive',
      GITHUB_TOKEN: 'must-not-arrive',
      HOME: '/home/must-not-arrive',
    });
    const seen = readFileSync(record, 'utf8');
    expect(seen).not.toContain('must-not-arrive');
    expect(seen).not.toContain('FY_H8_CANARY');
    expect(seen).toContain(`PATH=${scratch}:`);
  });
});
