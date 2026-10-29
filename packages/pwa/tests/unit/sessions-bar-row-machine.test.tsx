import { afterEach, describe, expect, test } from 'bun:test';
import type { DaemonId } from '../../src/lib/daemon-connection.ts';
import { SessionsBarRow } from '../../src/shell/sessions-bar-row.tsx';
import '../support/dom.ts';
import { type Mounted, mount, must } from '../support/dom.ts';
import { sessionView } from '../support/sessions.ts';

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
