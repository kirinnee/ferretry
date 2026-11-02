import { describe, expect, it } from 'bun:test';
import { WardenStrip } from '../../../src/features/warden/warden-strip.tsx';
import { mount } from '../../support/dom.ts';
import {
  wardenAccount,
  wardenAction,
  wardenAnomaly,
  wardenConfig,
  wardenFailover,
  wardenStatus,
} from '../../support/warden.ts';

const NOW = Date.parse('2026-07-31T12:00:00.000Z');
const SWEPT = '2026-07-31T11:58:00.000Z';

describe('WardenStrip', () => {
  it('should render nothing at all when the status is unknown', async () => {
    // Arrange
    const view = await mount(<WardenStrip status={null} />);
    try {
      // Act
      const html = view.container.innerHTML;

      // Assert
      expect(html).toBe('');
    } finally {
      await view.unmount();
    }
  });

  it('should read clean and settled when the last sweep left nobody waiting', async () => {
    // Arrange
    const view = await mount(<WardenStrip status={wardenStatus({ lastSweepAt: SWEPT })} now={NOW} />);
    try {
      // Act
      const text = view.container.textContent ?? '';

      // Assert
      expect(text).toContain('Fleet checks');
      expect(text).toContain('Rules only');
      expect(text).toContain('swept 2m ago');
      expect(text).toContain('nobody needs you');
      expect(view.container.querySelector('.text-ok')).not.toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it('should refuse to call a daemon that never swept healthy', async () => {
    // Arrange
    const view = await mount(<WardenStrip status={wardenStatus()} />);
    try {
      // Act
      const text = view.container.textContent ?? '';

      // Assert
      expect(text).toContain('not swept yet');
      expect(text).toContain('no evidence yet');
      expect(view.container.querySelector('.text-ok')).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it('should count who needs you and name anomalies as plain chips with the who on hover', async () => {
    // Arrange
    const status = wardenStatus({
      lastSweepAt: SWEPT,
      anomalies: [wardenAnomaly({ teammate: 'ms-98', kind: 'sus_thinking' })],
      actions: [wardenAction({ sessionId: 'sess-2', action: 'stop', outcome: 'held' })],
    });
    const view = await mount(<WardenStrip status={status} now={NOW} />);
    try {
      // Act
      const glance = [...view.container.querySelectorAll('span')].find(span => span.getAttribute('title') !== null);

      // Assert
      expect(view.container.textContent).toContain('2 need you');
      expect(view.container.textContent).not.toContain('sus_thinking');
      expect(glance?.textContent).toBe('long think');
      expect(glance?.getAttribute('title')).toBe('long think: Ms-98');
    } finally {
      await view.unmount();
    }
  });

  it('should say the Warden is off and that it is investigating, without link styling', async () => {
    // Arrange
    const status = wardenStatus({ config: wardenConfig({ enabled: false }), liveWarden: 'sess-9' });
    const view = await mount(<WardenStrip status={status} now={NOW} />);
    try {
      // Act
      const text = view.container.textContent ?? '';

      // Assert
      expect(text).toContain('Off');
      expect(text).toContain('investigating');
      expect(text).not.toContain('warden live');
      expect(view.container.querySelector('.text-accent')).toBeNull();
    } finally {
      await view.unmount();
    }
  });

  it('should chip each failover account by health and mark the one in use', async () => {
    // Arrange
    const failover = wardenFailover({
      accounts: [
        wardenAccount({ agent: 'claude-default' }),
        wardenAccount({ agent: 'codex-default', eligible: false, reason: 'at limit' }),
      ],
      lastSelection: { agent: 'claude-default', policy: 'fallback', at: SWEPT, reason: 'first eligible' },
    });
    const view = await mount(<WardenStrip status={wardenStatus({ failover })} now={NOW} />);
    try {
      // Act
      const chips = [...view.container.querySelectorAll('[aria-label="Warden AI logins"] li')];

      // Assert
      expect(chips.map(chip => chip.textContent)).toEqual(['claude-default · in use', 'codex-default']);
      expect(chips[0]?.className).toContain('text-ok');
      expect(chips[1]?.className).toContain('text-warn');
      expect(chips[1]?.getAttribute('title')).toBe('at limit');
    } finally {
      await view.unmount();
    }
  });

  it('should omit the account group when failover reports none, and name an exhaustion', async () => {
    // Arrange
    const failover = wardenFailover({
      exhaustedSince: '2026-07-31T10:00:00.000Z',
      accounts: [wardenAccount({ eligible: false, quota: { authOk: false } })],
    });
    const none = await mount(<WardenStrip status={wardenStatus()} now={NOW} />);
    const exhausted = await mount(<WardenStrip status={wardenStatus({ failover })} now={NOW} />);
    try {
      // Act
      const group = none.container.querySelector('[aria-label="Warden AI logins"]');

      // Assert
      expect(group).toBeNull();
      expect(exhausted.container.textContent).toContain('no warden credentials!');
    } finally {
      await none.unmount();
      await exhausted.unmount();
    }
  });

  it('should hide the decorative separators from assistive tech', async () => {
    // Arrange
    const view = await mount(<WardenStrip status={wardenStatus()} now={NOW} />);
    try {
      // Act
      const separators = [...view.container.querySelectorAll('span')].filter(span => span.textContent === '·');

      // Assert
      expect(separators.length).toBeGreaterThan(0);
      for (const separator of separators) expect(separator.getAttribute('aria-hidden')).toBe('true');
    } finally {
      await view.unmount();
    }
  });
});
