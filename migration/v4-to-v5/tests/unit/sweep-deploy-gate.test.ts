import { describe, expect, test } from 'bun:test';
import { candidateRunIds, deployJobSucceeded, PREVIEW_BRANCHES } from '../../fixtures/sweep/deploy-gate.ts';

const sha = 'a'.repeat(40);
const other = 'b'.repeat(40);
const run = (databaseId: number, headBranch: string, conclusion = 'success', headSha = sha) => ({
  databaseId,
  headSha,
  conclusion,
  headBranch,
});

describe('which preview Pages runs can be a live deploy of a commit', () => {
  test('the two preview branches, and no other', () => {
    expect([...PREVIEW_BRANCHES]).toEqual(['rebuild/5.0', 'rebuild/5.0-after']);
  });

  test('a successful run of the exact commit on rebuild/5.0 or rebuild/5.0-after is a candidate', () => {
    const runs = [run(3, 'rebuild/5.0-after'), run(2, 'rebuild/5.0')];
    expect(candidateRunIds(runs, sha)).toEqual([3, 2]);
  });

  test('another branch, another commit, a failed or cancelled run and a prefix of a name are not', () => {
    const runs = [
      run(1, 'main'),
      run(2, 'rebuild/5.0-after2'),
      run(3, 'rebuild/5.0/x'),
      run(4, 'rebuild/5.0', 'failure'),
      run(5, 'rebuild/5.0-after', 'cancelled'),
      run(6, 'rebuild/5.0', 'success', other),
      run(7, 'rebuild/5.0', 'skipped'),
    ];
    expect(candidateRunIds(runs, sha)).toEqual([]);
  });

  test('anything that is not a list of runs yields no candidate', () => {
    expect(candidateRunIds(undefined, sha)).toEqual([]);
    expect(candidateRunIds({ runs: [run(1, 'rebuild/5.0')] }, sha)).toEqual([]);
    expect(candidateRunIds([null, 'x', { headSha: sha }], sha)).toEqual([]);
  });
});

describe('the deploy job itself must have run', () => {
  test('a Deploy PWA job that succeeded counts', () => {
    expect(
      deployJobSucceeded({
        jobs: [
          { name: 'Does this ref feed the preview', conclusion: 'success' },
          { name: 'Build PWA release', conclusion: 'success' },
          { name: 'Deploy PWA', conclusion: 'success' },
        ],
      }),
    ).toBe(true);
  });

  test('the never-backwards skip (a green run whose build, sign and deploy were skipped) does not count', () => {
    expect(
      deployJobSucceeded({
        jobs: [
          { name: 'Does this ref feed the preview', conclusion: 'success' },
          { name: 'Build PWA release', conclusion: 'skipped' },
          { name: 'Sign PWA release', conclusion: 'skipped' },
          { name: 'Deploy PWA', conclusion: 'skipped' },
        ],
      }),
    ).toBe(false);
  });

  test('a failed deploy, a missing deploy job, another job that succeeded and a malformed view do not count', () => {
    expect(deployJobSucceeded({ jobs: [{ name: 'Deploy PWA', conclusion: 'failure' }] })).toBe(false);
    expect(deployJobSucceeded({ jobs: [{ name: 'Build PWA release', conclusion: 'success' }] })).toBe(false);
    expect(deployJobSucceeded({ jobs: [] })).toBe(false);
    expect(deployJobSucceeded({})).toBe(false);
    expect(deployJobSucceeded(null)).toBe(false);
  });
});
