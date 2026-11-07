import { afterEach, describe, expect, test } from 'bun:test';
import type { DaemonId } from '../../../app/lib/daemon-connection.ts';
import { SessionPinContext } from '@ferretry/app';
import { SessionsBarRow } from '../../../app/shell/sessions-bar-row.tsx';
import '@ferretry/app/testing';
import { type Mounted, mount, must } from '@ferretry/app/testing';
import { sessionView } from '@ferretry/app/testing';

const DAEMON = 'alpha' as DaemonId;

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

describe('SessionsBarRow machine chip', () => {
  test('names the machine on a row with nothing unread, where no badge says it', async () => {
    view = await mount(
      <ul>
        <SessionsBarRow
          active={false}
          daemonId={DAEMON}
          learningPassive={false}
          machine="kirin-box"
          onNavigate={() => undefined}
          view={sessionView('quiet-1', { config: { teammate: 'hadi', label: 'Quiet work', cwd: '/work/site' } })}
        />
      </ul>,
    );
    const row = must(view.container.querySelector('[data-sbar-session="quiet-1"]'), 'the row');
    expect(row.hasAttribute('data-sbar-unread')).toBe(false);
    expect(row.querySelector('[data-machine-chip]')?.textContent).toBe('kirin-box');
    expect(row.querySelector('.fy-sbar__marks')).toBeNull();
  });
});

describe('SessionsBarRow pin control', () => {
  const rowWith = (pinnedAt: string | undefined, toggled: string[]) => (
    <SessionPinContext.Provider value={target => toggled.push(target.view.config.id)}>
      <ul>
        <SessionsBarRow
          active={false}
          daemonId={DAEMON}
          learningPassive={false}
          onNavigate={() => undefined}
          view={sessionView('pin-1', {
            config: { label: 'Site work', cwd: '/work/site' },
            state: { status: 'completed' },
            ...(pinnedAt === undefined ? {} : { pinnedAt }),
          })}
        />
      </ul>
    </SessionPinContext.Provider>
  );

  test('offers Pin to top on an unpinned row, and asks the app when pressed', async () => {
    const toggled: string[] = [];
    view = await mount(rowWith(undefined, toggled));
    const button = must(view.container.querySelector('[data-sbar-pin-toggle]'), 'the pin control');
    expect(button.getAttribute('aria-label')).toContain('to top');
    (button as HTMLButtonElement).click();
    expect(toggled).toEqual(['pin-1']);
  });

  test('offers Unpin on a pinned row, and marks a finished pinned row so it can be dimmed', async () => {
    view = await mount(rowWith('2026-11-02T10:00:00.000Z', []));
    const button = must(view.container.querySelector('[data-sbar-pin-toggle]'), 'the pin control');
    expect(button.getAttribute('aria-label')).toStartWith('Unpin');
    const row = must(view.container.querySelector('[data-sbar-session="pin-1"]'), 'the row');
    expect(row.hasAttribute('data-sbar-pinned')).toBe(true);
    expect(row.hasAttribute('data-sbar-stopped')).toBe(true);
  });

  test('draws no control where the app offers none', async () => {
    view = await mount(
      <ul>
        <SessionsBarRow
          active={false}
          daemonId={DAEMON}
          learningPassive={false}
          onNavigate={() => undefined}
          view={sessionView('pin-2')}
        />
      </ul>,
    );
    expect(view.container.querySelector('[data-sbar-pin-toggle]')).toBeNull();
  });
});
