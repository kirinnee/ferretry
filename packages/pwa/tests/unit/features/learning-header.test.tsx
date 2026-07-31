import { describe, expect, it } from 'bun:test';
import { LearningHeader } from '../../../src/features/learning/learning-header.tsx';
import { interact, mount } from '../../support/dom.ts';

const NOW = Date.parse('2026-07-31T12:00:00.000Z');

describe('LearningHeader', () => {
  it('renders the ready daemon summary and starts a scan on request', async () => {
    let runs = 0;
    const { container } = await mount(
      <LearningHeader
        busy={false}
        canRun
        failed={false}
        now={NOW}
        onRunNow={() => {
          runs += 1;
        }}
        status={{
          enabled: true,
          lastRunAt: '2026-07-31T11:58:00.000Z',
          pending: { total: 4, strong: 2 },
        }}
      />,
    );

    expect(container.textContent).toContain('Learning');
    expect(container.textContent).toContain('enabled');
    expect(container.textContent).toContain('last run 2m ago');
    expect(container.textContent).toContain('4 pending');
    expect(container.textContent).toContain('2 strong');
    for (const separator of [...container.querySelectorAll('span')].filter(span => span.textContent === '·')) {
      expect(separator.getAttribute('aria-hidden')).toBe('true');
    }

    const button = container.querySelector('button[aria-label="Run a learning scan now"]') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    await interact(() => button.click());
    expect(runs).toBe(1);
  });

  it('keeps unavailable or unauthorised learning scans visibly disabled', async () => {
    const { container } = await mount(
      <LearningHeader busy canRun={false} failed now={NOW} onRunNow={() => {}} status={null} />,
    );

    expect(container.textContent).toContain('disabled');
    expect(container.textContent).toContain('last run —');
    expect(container.textContent).toContain('0 pending');
    expect(container.textContent).toContain('unavailable on this daemon');
    const button = container.querySelector('button[aria-label="Run a learning scan now"]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.querySelector('svg')?.getAttribute('class')).toContain('animate-spin');
  });
});
