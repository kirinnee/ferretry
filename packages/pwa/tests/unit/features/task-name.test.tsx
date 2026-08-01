import { describe, expect, it } from 'bun:test';

import { TaskName } from '../../../src/features/tasks/task-name.tsx';
import { mount } from '../../support/dom.ts';

describe('TaskName', () => {
  it('renders the bracket prefix as quiet context and preserves the full accessible title', async () => {
    const { container } = await mount(<TaskName name="[Hayden] Fix the transcript scroller" />);
    const name = container.querySelector('span');
    const [prefix, task] = [...(name?.children ?? [])];

    expect(name?.getAttribute('title')).toBe('[Hayden] Fix the transcript scroller');
    expect(name?.className).toContain('max-w-full');
    expect(prefix?.textContent).toBe('Hayden');
    expect(prefix?.className).toContain('bg-surface-3');
    expect(task?.textContent).toBe('Fix the transcript scroller');
    expect(task?.className).toContain('truncate');
    expect(task?.className).toContain('text-row');
  });

  it('hides the prefix when the surrounding row already gives the same teammate', async () => {
    const { container } = await mount(<TaskName name="[Hayden] Fix the transcript scroller" teammate="hayden" />);

    expect(container.querySelectorAll('span span')).toHaveLength(1);
    expect(container.textContent).toBe('Fix the transcript scroller');
  });

  it('can explicitly suppress a distinct prefix without changing the task title', async () => {
    const { container } = await mount(<TaskName name="[Hayden] Fix the transcript scroller" showPrefix={false} />);
    const name = container.querySelector('span');

    expect(name?.getAttribute('title')).toBe('[Hayden] Fix the transcript scroller');
    expect(name?.textContent).toBe('Fix the transcript scroller');
  });

  it('uses the dense type ramp for session rows', async () => {
    const { container } = await mount(<TaskName name="[Hayden] Fix the transcript scroller" size="sm" />);
    const [prefix, task] = [...(container.querySelector('span')?.children ?? [])];

    expect(prefix?.className).toContain('text-2xs');
    expect(task?.className).toContain('text-ui');
  });

  it('prints an explicit dash rather than a blank cell for an unnamed session', async () => {
    const { container } = await mount(<TaskName className="extra" />);
    const name = container.querySelector('span');

    expect(name?.textContent).toBe('—');
    expect(name?.getAttribute('title')).toBe('this session was launched without a --name');
    expect(name?.className).toContain('text-faint');
    expect(name?.className).toContain('extra');
  });
});
