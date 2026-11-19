import { describe, expect, test } from 'bun:test';
import { PREVIEW_TOTAL_MS } from '../../fixtures/sweep/deploy-gate.ts';
import {
  ensurePreviewDeployed,
  PreviewRefusal,
  type PreviewPorts,
  type Ran,
} from '../../fixtures/sweep/preview-ref.ts';

const X = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const ref = 'refs/heads/rebuild/preview';
const ok = (out = ''): Ran => ({ code: 0, out, err: '' });
const bad = (code: number, err = 'boom'): Ran => ({ code, out: '', err });

/** A fake git and gh. Nothing is spawned and nothing is pushed: every call is recorded and answered from this table. */
function harness(setup: {
  head?: string | undefined | Ran;
  ancestor?: number;
  fetch?: Ran;
  push?: Ran;
  runs?: (poll: number) => unknown | Ran;
  jobs?: Record<number, unknown>;
}) {
  const calls: string[] = [];
  let clock = 0;
  let polls = 0;
  const say: string[] = [];
  const ports: PreviewPorts = {
    git: async args => {
      calls.push(`git ${args.join(' ')}`);
      if (args[0] === 'ls-remote') {
        const head = setup.head;
        if (typeof head === 'object') return head;
        return ok(head === undefined ? '' : `${head}\t${ref}\n`);
      }
      if (args[0] === 'fetch') return setup.fetch ?? ok();
      if (args[0] === 'merge-base') return { code: setup.ancestor ?? 0, out: '', err: '' };
      if (args[0] === 'push') return setup.push ?? ok();
      throw new Error(`unexpected git ${args.join(' ')}`);
    },
    gh: async args => {
      calls.push(`gh ${args.join(' ')}`);
      if (args[0] === 'run' && args[1] === 'list') {
        const answer = (setup.runs ?? (() => []))(polls++);
        return typeof answer === 'object' && answer !== null && 'code' in answer
          ? (answer as Ran)
          : ok(JSON.stringify(answer));
      }
      if (args[0] === 'run' && args[1] === 'view')
        return ok(JSON.stringify(setup.jobs?.[Number(args[2])] ?? { jobs: [] }));
      throw new Error(`unexpected gh ${args.join(' ')}`);
    },
    sleep: async ms => {
      clock += ms;
    },
    now: () => clock,
    say: line => say.push(line),
  };
  return { ports, calls, say };
}

const done = { jobs: [{ name: 'Deploy PWA', conclusion: 'success' }] };
const skipped = { jobs: [{ name: 'Deploy PWA', conclusion: 'skipped' }] };
const row = (id: number, conclusion: string, status = 'completed', sha = X, branch = 'rebuild/preview') => ({
  databaseId: id,
  headSha: sha,
  headBranch: branch,
  conclusion,
  status,
});
const pushes = (calls: string[]) => calls.filter(call => call.startsWith('git push'));
const refusal = async (promise: Promise<void>) => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PreviewRefusal);
    return (error as Error).message;
  }
  throw new Error('expected a refusal');
};

describe('moving the preview ref to the slot’s commit', () => {
  test('fast-forwards a descendant with a plain push of that commit to that one ref, then waits for the deploy', async () => {
    const h = harness({
      head: OLD,
      ancestor: 0,
      runs: poll => (poll === 0 ? [row(5, '', 'in_progress')] : [row(5, 'success')]),
      jobs: { 5: done },
    });
    await ensurePreviewDeployed(h.ports, X);
    expect(pushes(h.calls)).toEqual([`git push origin ${X}:${ref}`]);
    expect(h.calls.some(call => /--force|-f\b|--force-with-lease/u.test(call))).toBe(false);
    expect(h.calls.some(call => call.startsWith('gh workflow'))).toBe(false);
    expect(h.calls).toContain(`git merge-base --is-ancestor ${OLD} ${X}`);
    // The push comes before the wait, and the wait reads the run list for the preview ref only.
    expect(h.calls.findIndex(call => call.startsWith('git push'))).toBeLessThan(
      h.calls.findIndex(call => call.startsWith('gh run list')),
    );
    expect(h.calls.find(call => call.startsWith('gh run list'))).toContain('--branch rebuild/preview');
    expect(h.say.join('\n')).toContain('fast-forwarded');
  });

  test('creates the ref when it does not exist yet', async () => {
    const h = harness({ head: undefined, runs: () => [row(1, 'success')], jobs: { 1: done } });
    await ensurePreviewDeployed(h.ports, X);
    expect(pushes(h.calls)).toEqual([`git push origin ${X}:${ref}`]);
    expect(h.say.join('\n')).toContain('created');
  });

  test('refuses a commit that is not a descendant of the ref, and pushes nothing', async () => {
    const h = harness({ head: OLD, ancestor: 1 });
    const why = await refusal(ensurePreviewDeployed(h.ports, X));
    expect(why).toContain('never goes backwards');
    expect(pushes(h.calls)).toEqual([]);
    expect(h.calls.some(call => call.startsWith('gh '))).toBe(false);
  });

  test('refuses when git cannot say how the commits relate (merge-base error, or the fetch fails), and pushes nothing', async () => {
    for (const setup of [
      { head: OLD, ancestor: 128 },
      { head: OLD, fetch: bad(128) },
    ]) {
      const h = harness(setup);
      await refusal(ensurePreviewDeployed(h.ports, X));
      expect(pushes(h.calls)).toEqual([]);
    }
  });

  test('a ref already at the commit is not pushed again; the existing run is awaited', async () => {
    const h = harness({ head: X, runs: () => [row(9, 'success')], jobs: { 9: done } });
    await ensurePreviewDeployed(h.ports, X);
    expect(pushes(h.calls)).toEqual([]);
    expect(h.say.join('\n')).toContain('already points at');
  });

  test('an unreadable ref or an unexpected listing refuses before any push', async () => {
    for (const head of [bad(128, 'no network'), ok('not a listing\n'), ok(`${OLD}\trefs/heads/other\n`)]) {
      const h = harness({ head });
      await refusal(ensurePreviewDeployed(h.ports, X));
      expect(pushes(h.calls)).toEqual([]);
    }
  });

  test('a rejected push refuses, saying nothing was stopped, and waits for nothing', async () => {
    const h = harness({ head: OLD, push: bad(1, '! [rejected] (non-fast-forward)') });
    const why = await refusal(ensurePreviewDeployed(h.ports, X));
    expect(why).toContain('could not push');
    expect(why).toContain('nothing was stopped');
    expect(h.calls.some(call => call.startsWith('gh '))).toBe(false);
  });
});

describe('waiting for the deploy of exactly that commit', () => {
  test('a run of another commit, or on the old merge branches, does not count', async () => {
    const h = harness({
      head: OLD,
      runs: () => [row(1, 'success', 'completed', OLD), row(2, 'success', 'completed', X, 'rebuild/5.0-after')],
      jobs: { 1: done, 2: done },
    });
    const why = await refusal(ensurePreviewDeployed(h.ports, X));
    expect(why).toContain('no "Deploy 5.0 preview PWA to Pages" run for this commit appeared');
    expect(h.calls.some(call => call.startsWith('gh run view'))).toBe(false);
  });

  test('a green run whose deploy job was skipped (the gate refused the push) refuses', async () => {
    const h = harness({ head: OLD, runs: () => [row(3, 'success')], jobs: { 3: skipped } });
    const why = await refusal(ensurePreviewDeployed(h.ports, X));
    expect(why).toContain('did not succeed');
  });

  test('a failed run refuses at once, without waiting out the window', async () => {
    const h = harness({ head: OLD, runs: () => [row(4, 'failure')] });
    const why = await refusal(ensurePreviewDeployed(h.ports, X));
    expect(why).toContain('run 4 ended failure');
    expect(why).toContain('nothing was stopped');
  });

  test('a run that never finishes refuses after the total window', async () => {
    const h = harness({ head: OLD, runs: () => [row(6, '', 'in_progress')] });
    const why = await refusal(ensurePreviewDeployed(h.ports, X));
    expect(why).toContain(`${String(Math.round(PREVIEW_TOTAL_MS / 60_000))} minutes`);
  });

  test('a run list that fails twice and then answers is waited out; three failures in a row refuse', async () => {
    let n = 0;
    const flaky = harness({
      head: OLD,
      runs: () => (n++ < 2 ? bad(1, 'HTTP 502') : [row(1, 'success')]),
      jobs: { 1: done },
    });
    await ensurePreviewDeployed(flaky.ports, X);
    const down = harness({ head: OLD, runs: () => bad(1, 'HTTP 502') });
    const why = await refusal(ensurePreviewDeployed(down.ports, X));
    expect(why).toContain('could not read the Pages deploy runs');
  });

  test('an answer that is not JSON refuses', async () => {
    const h = harness({ head: OLD, runs: () => ok('<html>') as unknown });
    const ports: PreviewPorts = { ...h.ports, gh: async () => ok('<html>') };
    await refusal(ensurePreviewDeployed(ports, X));
  });
});
