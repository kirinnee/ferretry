import { afterEach, describe, expect, test } from 'bun:test';
import { SessionTopBar, sessionDisplayName, sessionRuntimeLine } from '../../src/components/session-top-bar.tsx';
import '../support/dom.ts';
import { interact, type Mounted, mount, must } from '../support/dom.ts';
import { sessionView } from '../support/sessions.ts';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

describe('what the session bar calls a session', () => {
  test('the callsign first, then the label, the name and finally the id', () => {
    expect(sessionDisplayName(sessionView('a', { config: { teammate: 'hadi', label: 'Fix it' } }))).toBe('Hadi');
    expect(sessionDisplayName(sessionView('b', { config: { label: 'Fix it' } }))).toBe('Fix it');
    expect(sessionDisplayName(sessionView('c'))).toBe('Session c');
    expect(sessionDisplayName(sessionView('d', { config: { name: undefined as never } }))).toBe('d');
  });

  test('the runtime line names the account wrapper, the mode and the id', () => {
    expect(sessionRuntimeLine(sessionView('abc', { config: { agent: 'claude-default', mode: 'interactive' } }))).toBe(
      'claude-default · interactive · abc',
    );
  });
});

describe('SessionTopBar', () => {
  test('draws the name, project and status in one row, with the actions and a ⋯ menu', async () => {
    const chosen: string[] = [];
    view = await mount(
      <SessionTopBar
        actions={<button type="button">Interrupt</button>}
        compact={false}
        menuItems={[{ key: 'files', label: 'Files', onSelect: () => chosen.push('files') }]}
        project="ferretry"
        session={sessionView('s1', { config: { teammate: 'hadi', label: 'Fix the sign-in' } })}
        status={<span data-extra="">needs you</span>}
      />,
    );
    const bar = must(view.container.querySelector('[data-session-bar]'), 'the session bar');
    expect(bar.querySelector('h1')?.textContent).toBe('Hadi');
    expect(bar.querySelector('.fy-session-bar__who')?.getAttribute('title')).toBe('Hadi — Fix the sign-in');
    expect(bar.querySelector('.fy-session-bar__project')?.textContent).toBe('ferretry');
    expect(bar.querySelector('.fy-session-bar__word')?.textContent).toBe('running');
    expect(bar.querySelector('[data-extra]')).not.toBeNull();
    expect(bar.querySelector('[data-session-bar-sessions]')).toBeNull();

    const more = must(bar.querySelector<HTMLButtonElement>('[data-session-more]'), 'the ⋯ button');
    expect(more.getAttribute('aria-expanded')).toBe('false');
    await interact(() => more.click());
    expect(more.getAttribute('aria-expanded')).toBe('true');
    const rows = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
    expect(rows.map(row => row.textContent)).toEqual(['claude · auto · s1', 'Files']);
    // The runtime line is a fact, not an action.
    expect(rows[0]?.disabled).toBe(true);
    await interact(() => rows[1]?.click());
    expect(chosen).toEqual(['files']);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  test('on a phone it keeps the name and the dot, drops the project, and opens the sessions drawer', async () => {
    let opened = 0;
    view = await mount(
      <SessionTopBar
        actions={null}
        compact
        menuItems={[]}
        onOpenSessions={() => (opened += 1)}
        project="ferretry"
        session={sessionView('s1', {
          config: { teammate: 'hadi', label: undefined as never, name: undefined as never },
        })}
      />,
    );
    const bar = must(view.container.querySelector('[data-session-bar]'), 'the session bar');
    expect(bar.hasAttribute('data-compact')).toBe(true);
    expect(bar.querySelector('.fy-session-bar__project')).toBeNull();
    expect(bar.querySelector('.fy-session-bar__who')?.getAttribute('title')).toBe('Hadi');
    expect(bar.querySelector('.fy-session-bar__status .sr-only')?.textContent).toBe('running');
    await interact(() => must(bar.querySelector<HTMLButtonElement>('[data-session-bar-sessions]'), '☰').click());
    expect(opened).toBe(1);
  });

  test('omits the project when the folder cannot be named', async () => {
    view = await mount(
      <SessionTopBar actions={null} compact={false} menuItems={[]} project={null} session={sessionView('s1')} />,
    );
    expect(view.container.querySelector('.fy-session-bar__project')).toBeNull();
  });
});

describe('SessionTopBar turn word', () => {
  test("says whose turn it is in the person's words, and marks it for the page", async () => {
    for (const [turn, word] of [
      ['working', 'working'],
      ['your-turn', 'your turn'],
      ['needs-input', 'needs input'],
    ] as const) {
      view = await mount(
        <SessionTopBar
          actions={null}
          compact={false}
          menuItems={[]}
          project={null}
          session={sessionView('s1', { state: { status: 'running', turnState: turn } })}
          turn={turn}
        />,
      );
      const status = must(view.container.querySelector('.fy-session-bar__status'), 'the status');
      expect(status.getAttribute('data-session-activity')).toBe(turn);
      expect(status.querySelector('.fy-session-bar__word')?.textContent).toBe(word);
      await view.unmount();
      view = null;
    }
  });
});
