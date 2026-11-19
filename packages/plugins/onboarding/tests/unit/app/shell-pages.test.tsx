import { afterEach, describe, expect, it } from 'bun:test';
import { ensureDom, type Mounted, mount } from '@ferretry/app/testing';
import { stepHarness } from '../../../contract/testing/index.ts';
import { AppearancePage, routeNameDecision } from '../../../app/features/setup-flow/shell-pages.tsx';

ensureDom();

let view: Mounted | undefined;
afterEach(async () => {
  await view?.unmount();
  view = undefined;
});

describe('Onboarding’s own two pages', () => {
  it('the name step: asking shows the page, an already-named machine skips it, an answer is done and moves on', () => {
    const asking = stepHarness();
    routeNameDecision(asking.host, 'asking');
    expect(asking.calls).toEqual([{ kind: 'ready' }]);

    const named = stepHarness();
    routeNameDecision(named.host, 'named');
    expect(named.decision).toBe('skipped');
    expect(named.skippedWhy).toBe('already-set');

    const settled = stepHarness();
    routeNameDecision(settled.host, 'settled');
    expect(settled.calls).toEqual([{ kind: 'done' }, { kind: 'next' }]);
  });

  it('the appearance page is ready at once (it has nothing to look up)', async () => {
    const harness = stepHarness({ phase: 'client' });
    view = await mount(<AppearancePage step={harness.host} />);
    expect(harness.decision).toBe('shown');
  });
});
