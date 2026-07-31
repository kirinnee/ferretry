import { describe, expect, it } from 'bun:test';
import { WardenStrip } from '../../../src/features/warden/warden-strip.tsx';
import { mount } from '../../support/dom.ts';
import { wardenAccount, wardenAnomaly, wardenFailover, wardenStatus } from '../../support/warden.ts';

const NOW = Date.parse('2026-07-31T12:00:00.000Z');

describe('WardenStrip', () => {
  it('renders nothing at all when the status is unknown', async () => {
    const { container } = await mount(<WardenStrip status={null} />);

    expect(container.innerHTML).toBe('');
  });

  it('reads clean and settled when the last sweep found nothing', async () => {
    const { container } = await mount(
      <WardenStrip status={wardenStatus({ lastSweepAt: '2026-07-31T11:58:00.000Z' })} now={NOW} />,
    );

    expect(container.textContent).toContain('Fleet checks');
    expect(container.textContent).toContain('last sweep 2m ago');
    expect(container.textContent).toContain('no anomalies');
    expect(container.textContent).toContain('every 5m');
  });

  it('shows an em dash rather than a guess when no sweep has happened', async () => {
    const { container } = await mount(<WardenStrip status={wardenStatus()} now={NOW} />);

    expect(container.textContent).toContain('last sweep —');
  });

  it('switches the shield and the tone once anomalies exist', async () => {
    const clean = await mount(<WardenStrip status={wardenStatus()} now={NOW} />);
    const dirty = await mount(
      <WardenStrip status={wardenStatus({ anomalies: [wardenAnomaly({ teammate: 'ms-98' })] })} now={NOW} />,
    );

    expect(clean.container.querySelector('.text-ok')).not.toBeNull();
    expect(dirty.container.querySelector('.text-warn')).not.toBeNull();
    expect(dirty.container.textContent).toContain('1 anomaly');
  });

  it('summarises the anomaly kinds and keeps the who in the hover title', async () => {
    const { container } = await mount(
      <WardenStrip
        status={wardenStatus({ anomalies: [wardenAnomaly({ teammate: 'ms-98', kind: 'sus_thinking' })] })}
        now={NOW}
      />,
    );
    const glance = container.querySelector('.ml-auto');

    expect(glance?.textContent).toBe('sus_thinking');
    expect(glance?.getAttribute('title')).toBe('sus_thinking: Ms-98');
  });

  it('says nothing about a live warden unless one is live', async () => {
    const idle = await mount(<WardenStrip status={wardenStatus()} now={NOW} />);
    const live = await mount(<WardenStrip status={wardenStatus({ liveWarden: 'sess-9' })} now={NOW} />);

    expect(idle.container.textContent).not.toContain('warden live');
    expect(live.container.textContent).toContain('warden live');
  });

  it('chips each failover account by health and marks the one last selected', async () => {
    const failover = wardenFailover({
      accounts: [
        wardenAccount({ agent: 'claude-auto-loge' }),
        wardenAccount({ agent: 'codex-auto-terra', eligible: false, reason: 'at limit' }),
      ],
      lastSelection: {
        agent: 'claude-auto-loge',
        policy: 'fallback',
        at: '2026-07-31T11:00:00.000Z',
        reason: 'first eligible',
      },
    });
    const { container } = await mount(<WardenStrip status={wardenStatus({ failover })} now={NOW} />);
    const group = container.querySelector('[aria-label="Warden accounts"]') as HTMLElement;
    const chips = [...group.querySelectorAll('span')];

    expect(chips.map(chip => chip.textContent)).toEqual(['loge ●', 'terra']);
    expect(chips[0]?.className).toContain('text-ok');
    expect(chips[1]?.className).toContain('text-warn');
    expect(chips[1]?.getAttribute('title')).toBe('at limit');
  });

  it('omits the account group entirely when failover reports none', async () => {
    const { container } = await mount(<WardenStrip status={wardenStatus()} now={NOW} />);

    expect(container.querySelector('[aria-label="Warden accounts"]')).toBeNull();
  });

  it('names an exhaustion the reader has to act on', async () => {
    const failover = wardenFailover({
      exhaustedSince: '2026-07-31T10:00:00.000Z',
      accounts: [wardenAccount({ eligible: false, quota: { authOk: false } })],
    });
    const { container } = await mount(<WardenStrip status={wardenStatus({ failover })} now={NOW} />);

    expect(container.textContent).toContain('no warden credentials!');
  });

  it('hides the decorative separators from assistive tech', async () => {
    const { container } = await mount(<WardenStrip status={wardenStatus()} now={NOW} />);
    const separators = [...container.querySelectorAll('span')].filter(span => span.textContent === '·');

    expect(separators.length).toBeGreaterThan(0);
    for (const separator of separators) expect(separator.getAttribute('aria-hidden')).toBe('true');
  });
});
