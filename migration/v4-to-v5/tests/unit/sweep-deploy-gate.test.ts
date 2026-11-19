import { describe, expect, test } from 'bun:test';
import {
  decidePush,
  deployJobSucceeded,
  PREVIEW_APPEAR_MS,
  PREVIEW_REF,
  PREVIEW_TOTAL_MS,
  previewRunsFor,
  waitVerdict,
} from '../../fixtures/sweep/deploy-gate.ts';

const sha = 'a'.repeat(40);
const other = 'b'.repeat(40);
const run = (
  databaseId: number,
  headBranch: string,
  conclusion = 'success',
  headSha = sha,
  status: string | undefined = 'completed',
) => ({ databaseId, headSha, conclusion, headBranch, ...(status === undefined ? {} : { status }) });

describe('the preview ref', () => {
  test('is the one dedicated ref, not a branch a merge lands on', () => {
    expect(PREVIEW_REF).toBe('rebuild/preview');
  });
});

describe('which preview Pages runs belong to a commit', () => {
  test('a run of the exact commit on the preview ref is one; its state is pending, success or how it ended', () => {
    const runs = [
      run(4, PREVIEW_REF, '', sha, 'in_progress'),
      run(3, PREVIEW_REF),
      run(2, PREVIEW_REF, 'failure'),
      run(1, PREVIEW_REF, 'cancelled'),
    ];
    expect(previewRunsFor(runs, sha)).toEqual([
      { id: 4, state: 'pending' },
      { id: 3, state: 'success' },
      { id: 2, state: { ended: 'failure' } },
      { id: 1, state: { ended: 'cancelled' } },
    ]);
  });

  test('the old merge branches, another branch, another commit and a prefix of the ref name are not', () => {
    const runs = [
      run(1, 'rebuild/5.0'),
      run(2, 'rebuild/5.0-after'),
      run(3, 'main'),
      run(4, `${PREVIEW_REF}2`),
      run(5, `${PREVIEW_REF}/x`),
      run(6, PREVIEW_REF, 'success', other),
    ];
    expect(previewRunsFor(runs, sha)).toEqual([]);
  });

  test('anything that is not a list of runs yields none', () => {
    expect(previewRunsFor(undefined, sha)).toEqual([]);
    expect(previewRunsFor({ runs: [run(1, PREVIEW_REF)] }, sha)).toEqual([]);
    expect(previewRunsFor([null, 'x', { headSha: sha }], sha)).toEqual([]);
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

describe('moving the preview ref (never backwards)', () => {
  test('a ref that does not exist is created; one already at the commit is left; a descendant is fast-forwarded', () => {
    expect(decidePush(undefined, sha, undefined)).toBe('create');
    expect(decidePush(sha, sha, undefined)).toBe('already');
    expect(decidePush(other, sha, true)).toBe('fast-forward');
  });

  test('an older or diverged commit, and a relation git could not tell, are refused', () => {
    expect(decidePush(other, sha, false)).toBe('refuse');
    expect(decidePush(other, sha, undefined)).toBe('refuse');
  });
});

describe('what the observed runs say', () => {
  test('a run whose deploy job succeeded is live, even beside a failed one', () => {
    expect(
      waitVerdict(
        [
          { id: 2, state: { ended: 'failure' } },
          { id: 1, state: 'deployed' },
        ],
        0,
      ),
    ).toEqual({ kind: 'live' });
  });

  test('a run still going waits; no run yet waits until the appearance window ends, then refuses', () => {
    expect(waitVerdict([{ id: 1, state: 'pending' }], 60_000)).toEqual({ kind: 'wait' });
    expect(waitVerdict([], 1000)).toEqual({ kind: 'wait' });
    expect(waitVerdict([], PREVIEW_APPEAR_MS + 1).kind).toBe('refuse');
  });

  test('a run that is still going past the total window refuses', () => {
    expect(waitVerdict([{ id: 1, state: 'pending' }], PREVIEW_TOTAL_MS + 1).kind).toBe('refuse');
  });

  test('a failed run, a cancelled run and a green run whose deploy was skipped refuse, saying which', () => {
    const failed = waitVerdict([{ id: 7, state: { ended: 'failure' } }], 0);
    expect(failed).toMatchObject({ kind: 'refuse' });
    expect(JSON.stringify(failed)).toContain('run 7 ended failure');
    const skipped = waitVerdict([{ id: 8, state: 'skipped' }], 0);
    expect(skipped).toMatchObject({ kind: 'refuse' });
    expect(JSON.stringify(skipped)).toContain('green but its \\"Deploy PWA\\" job did not succeed');
  });
});
