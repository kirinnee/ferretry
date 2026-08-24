import { describe, expect, test } from 'bun:test';
import { LiveStreamIndicator } from '../../src/components/live-stream-indicator.tsx';
import type { SessionEventStreamStatus } from '../../src/components/session-event-stream-model.ts';
import { interact, mount, must } from '../support/dom.ts';

/**
 * The one surface that says whether the live feed is actually alive.
 *
 * WHAT THIS SUITE HAS TO GET RIGHT. The defect underneath it is that a dead stream looked exactly
 * like a quiet one, so the interesting assertions are all about DISTINGUISHABILITY rather than about
 * appearance: four states must never collapse into the same rendering, a sighted reader and a screen
 * reader must be told the same thing rather than one of them being told nothing, and the recovery
 * control must be a real focusable control rather than something only a mouse can reach.
 */

const ALL: readonly SessionEventStreamStatus[] = ['connecting', 'live', 'reconnecting', 'disconnected'];

const reconnectButton = (container: HTMLElement): HTMLButtonElement | null =>
  container.querySelector('button[data-live-stream-reconnect]');

describe('LiveStreamIndicator', () => {
  test('renders a distinct machine state, word and sentence for each state', async () => {
    // Arrange
    const view = await mount(<LiveStreamIndicator status="connecting" onReconnect={() => {}} />);
    const seen: Array<readonly [string, string, string]> = [];

    // Act
    for (const status of ALL) {
      await view.render(<LiveStreamIndicator status={status} onReconnect={() => {}} />);
      const region = must(view.container.querySelector('[data-live-stream]'), 'the live-stream region');
      seen.push([
        region.getAttribute('data-live-stream') ?? '',
        must(region.querySelector('.kt-badge'), 'the state badge').textContent ?? '',
        must(region.querySelector('.sr-only'), 'the announced sentence').textContent ?? '',
      ]);
    }

    // Assert — a harness proves recovery against `data-live-stream`, which does not change when copy
    // does. Four states, four of everything: any two states sharing a rendering would put the
    // original "a dead stream looks alive" defect straight back.
    expect(seen).toEqual([
      ['connecting', 'Connecting', 'Live updates are connecting.'],
      ['live', 'Live', 'Live updates are connected.'],
      [
        'reconnecting',
        'Reconnecting',
        'Live updates dropped and are reconnecting. The transcript still refreshes on a timer.',
      ],
      ['disconnected', 'Offline', 'Live updates are disconnected. The transcript still refreshes on a timer.'],
    ]);
    expect(new Set(seen.map(row => row[2])).size).toBe(ALL.length);

    await view.unmount();
  });

  test('announces politely and hides the decorative word from the announcement', async () => {
    // Arrange/Act
    const view = await mount(<LiveStreamIndicator status="disconnected" onReconnect={() => {}} />);
    const region = must(view.container.querySelector('[data-live-stream]'), 'the live-stream region');

    // Assert — `status`/`polite` and not `alert`: losing a live feed is not an emergency, the
    // workspace still works, and interrupting somebody mid-sentence to say the fast path got slower
    // would be worse than the defect. The badge is hidden so the region reads one sentence rather
    // than "Offline Offline …".
    expect(region.getAttribute('role')).toBe('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(must(region.querySelector('.kt-badge'), 'the state badge').getAttribute('aria-hidden')).toBe('true');

    await view.unmount();
  });

  test('offers the recovery control exactly where it can only help', async () => {
    // Arrange
    const view = await mount(<LiveStreamIndicator status="connecting" onReconnect={() => {}} />);
    const offered: Array<readonly [SessionEventStreamStatus, boolean]> = [];

    // Act
    for (const status of ALL) {
      await view.render(<LiveStreamIndicator status={status} onReconnect={() => {}} />);
      offered.push([status, reconnectButton(view.container) !== null]);
    }

    // Assert — a reconnect ABANDONS whatever socket is open, so offering it on a live stream would be
    // a button whose only effect is destructive, and offering it during a first attempt would cancel
    // an attempt that has not had its chance yet.
    expect(offered).toEqual([
      ['connecting', false],
      ['live', false],
      ['reconnecting', true],
      ['disconnected', true],
    ]);

    await view.unmount();
  });

  test('exposes the control to a keyboard and a screen reader, not only to a pointer', async () => {
    // Arrange
    const clicks: number[] = [];
    const view = await mount(<LiveStreamIndicator status="disconnected" onReconnect={() => clicks.push(1)} />);
    const button = must(reconnectButton(view.container), 'the reconnect button');

    // Act — a real <button> is what makes Enter and Space work without this file implementing either.
    button.focus();
    await interact(() => button.click());

    // Assert
    expect(button.tagName).toBe('BUTTON');
    expect(button.type).toBe('button');
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe('Reconnect');
    expect(document.activeElement).toBe(button);
    expect(clicks).toEqual([1]);

    await view.unmount();
  });
});
