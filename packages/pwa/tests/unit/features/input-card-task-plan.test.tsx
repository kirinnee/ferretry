import { afterEach, describe, expect, it } from 'bun:test';
import type { InputRequest } from '@ferretry/protocol';
import { InputCard } from '../../../src/features/input-request/input-card.tsx';
import { fieldsOf } from '../../../src/lib/input-card.ts';
import { type Mounted, mount } from '../../support/dom.ts';
import { fakeClient, NOW, request } from '../../support/input-fixtures.ts';
import { PLAN_ID } from '../../support/task-plan-fixtures.ts';

const mounted: Mounted[] = [];

afterEach(async () => {
  for (const each of mounted.splice(0)) await each.unmount();
});

const show = async (value: InputRequest) => {
  const view = await mount(
    <InputCard
      agentName="Hadi"
      client={fakeClient(() => ({})).client}
      fields={fieldsOf(value)}
      now={NOW}
      onDone={() => undefined}
      request={value}
    />,
  );
  mounted.push(view);
  return (selector: string): HTMLElement | null => view.container.querySelector<HTMLElement>(selector);
};

describe('an input card a task plan line touched', () => {
  it('says which line was filled', async () => {
    const q = await show(request({ preapproval: { by: 'plan', plan: PLAN_ID, line: 1, outcome: 'filled' } }));
    expect(q('[data-input-plan-filled]')?.textContent).toBe('Filled under your task plan (line 2).');
    expect(q('[data-input-plan-miss]')).toBeNull();
  });

  it("says in the daemon's fixed words why a line did not apply", async () => {
    const q = await show(
      request({ preapproval: { by: 'plan', plan: PLAN_ID, line: 1, outcome: 'did-not-apply', reason: 'rate' } }),
    );
    expect(q('[data-input-plan-miss]')?.textContent).toContain('line 2');
    expect(q('[data-input-plan-filled]')).toBeNull();
  });

  it('says nothing for a card no plan touched', async () => {
    const q = await show(request());
    expect(q('[data-input-plan-miss]')).toBeNull();
    expect(q('[data-input-plan-filled]')).toBeNull();
  });
});
