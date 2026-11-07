import { afterEach, describe, expect, test } from 'bun:test';
import type { HarnessDialog, PermissionRequest, SessionView } from '@ferretry/protocol';
import { SessionTopBar, sessionDisplayName, sessionTitle } from '../../src/components/session-top-bar.tsx';
import '../support/dom.ts';
import { interact, type Mounted, mount, must } from '../support/dom.ts';
import { sessionView } from '../support/sessions.ts';

let view: Mounted | null = null;
afterEach(async () => {
  await view?.unmount();
  view = null;
});

describe('what the session bar calls a session', () => {
  test('the callsign first, then the name, never the label, and finally the id', () => {
    expect(sessionDisplayName(sessionView('a', { config: { teammate: 'hadi', label: 'Fix it' } }))).toBe('Hadi');
    expect(sessionDisplayName(sessionView('b', { config: { name: 'Renamed', label: 'diene-cyan' } }))).toBe('Renamed');
    expect(sessionDisplayName(sessionView('c'))).toBe('Session c');
    expect(sessionDisplayName(sessionView('d', { config: { name: undefined as never } }))).toBe('d');
  });
});

describe('what titles a chat', () => {
  test('the task it was named, without a callsign prefix, and only then the callsign', () => {
    expect(sessionTitle(sessionView('a', { config: { teammate: 'hadi', name: '[Hadi] Fix it' } }))).toBe('Fix it');
    expect(sessionTitle(sessionView('b', { config: { teammate: 'hadi', name: '' } }))).toBe('Hadi');
    expect(sessionTitle(sessionView('c', { config: { teammate: 'hadi', name: 'interactive' } }))).toBe('Hadi');
  });

  test('the callsign is a secondary line on a desktop, absent on a phone and when it would repeat the title', async () => {
    const draw = async (compact: boolean, config: object) => {
      view = await mount(<SessionTopBar actions={null} compact={compact} session={sessionView('s1', { config })} />);
      const bar = must(view.container.querySelector('[data-session-bar]'), 'the session bar');
      const out = [bar.querySelector('h1')?.textContent, bar.querySelector('[data-session-callsign]')?.textContent];
      await view.unmount();
      view = null;
      return out;
    };
    expect(await draw(false, { teammate: 'hadi', name: 'Fix it' })).toEqual(['Fix it', 'Hadi']);
    expect(await draw(true, { teammate: 'hadi', name: 'Fix it' })).toEqual(['Fix it', undefined]);
    expect(await draw(false, { teammate: 'hadi', name: '' })).toEqual(['Hadi', undefined]);
  });
});

describe('SessionTopBar', () => {
  test('draws the name, status, actions, ⓘ Info and the menu in one row, and nothing else', async () => {
    let toggled = 0;
    view = await mount(
      <SessionTopBar
        actions={<button type="button">Interrupt</button>}
        compact={false}
        infoOpen
        menu={
          <button data-menu-slot="" type="button">
            Actions
          </button>
        }
        onToggleInfo={() => (toggled += 1)}
        session={sessionView('s1', { config: { teammate: 'hadi', name: 'Fix the sign-in', label: 'diene-cyan' } })}
        status={<span data-extra="">needs you</span>}
      />,
    );
    const bar = must(view.container.querySelector('[data-session-bar]'), 'the session bar');
    expect(bar.querySelector('h1')?.textContent).toBe('Fix the sign-in');
    expect(bar.querySelector('[data-session-callsign]')?.textContent).toBe('Hadi');
    expect(bar.querySelector('.fy-session-bar__who')?.getAttribute('title')).toBe('Fix the sign-in — Hadi');
    expect(bar.querySelector('.fy-session-bar__word')?.textContent).toBe('running');
    expect(bar.querySelector('[data-extra]')).not.toBeNull();
    expect(bar.querySelector('[data-session-bar-sessions]')).toBeNull();
    expect(bar.querySelector('[data-menu-slot]')).not.toBeNull();
    expect(bar.querySelector('[data-session-actions] button')?.textContent).toBe('Interrupt');
    expect(bar.querySelector('[data-session-more]')).toBeNull();

    const info = must(bar.querySelector<HTMLButtonElement>('[data-session-info-toggle]'), 'the ⓘ toggle');
    expect(info.getAttribute('aria-pressed')).toBe('true');
    expect(info.getAttribute('aria-label')).toBe('Info');
    expect(info.textContent).toBe('');
    await interact(() => info.click());
    expect(toggled).toBe(1);
  });

  test('carries none of what moved into Info: project, started-by, sub-ferrets, card, marks, agenda, restart', async () => {
    view = await mount(
      <SessionTopBar
        actions={null}
        compact={false}
        onToggleInfo={() => undefined}
        session={
          {
            ...sessionView('s1', { config: { teammate: 'hadi', mode: 'interactive' } }),
            outdated: { sections: ['pack'] },
          } as SessionView
        }
      />,
    );
    for (const gone of [
      '.fy-session-bar__project',
      '[data-session-started-by]',
      '[data-sub-ferrets]',
      '[data-card-chip]',
      '[data-switch-marks]',
      '[data-switch-mark]',
      '.fy-session-bar__agenda',
      '[data-outdated-mark]',
      '[data-session-unread]',
    ])
      expect(view.container.querySelector(gone)).toBeNull();
  });

  test('on a phone it draws the one lifecycle button the page hands it, beside ⓘ', async () => {
    view = await mount(
      <SessionTopBar
        actions={<button data-resume="" type="button" />}
        compact
        onToggleInfo={() => undefined}
        session={sessionView('s1', { state: { status: 'stopped' } })}
      />,
    );
    expect(view.container.querySelector('[data-session-actions] [data-resume]')).not.toBeNull();
  });

  test('on a phone it is the title, status, ⓘ and the menu — and nothing else', async () => {
    let opened = 0;
    view = await mount(
      <SessionTopBar
        actions={null}
        compact
        menu={<button data-menu="" type="button" />}
        onOpenSessions={() => (opened += 1)}
        onToggleInfo={() => undefined}
        session={sessionView('s1', {
          config: { teammate: 'hadi', label: undefined as never, name: undefined as never },
        })}
      />,
    );
    const bar = must(view.container.querySelector('[data-session-bar]'), 'the session bar');
    expect(bar.hasAttribute('data-compact')).toBe(true);
    expect(bar.querySelector('.fy-session-bar__who')?.getAttribute('title')).toBe('Hadi');
    expect(bar.querySelector('.fy-session-bar__status .sr-only')?.textContent).toBe('running');
    expect(bar.querySelectorAll('.fy-session-bar__status')).toHaveLength(1);
    expect(bar.querySelector('[data-session-callsign]')).toBeNull();
    expect(bar.querySelector('[data-lifecycle]')).toBeNull();
    expect(bar.querySelector('[data-session-actions]')).toBeNull();
    // ☰ (the sessions drawer) is the phone's own way back, then the row: title+status, ⓘ, menu.
    const row = [...bar.children].map(child =>
      child.matches('[data-session-bar-sessions]')
        ? 'sessions'
        : child.matches('.fy-session-bar__who')
          ? 'who'
          : child.matches('[data-session-info-toggle]')
            ? 'info'
            : child.matches('[data-menu]')
              ? 'menu'
              : 'other',
    );
    expect(row).toEqual(['sessions', 'who', 'info', 'menu']);
    await interact(() => must(bar.querySelector<HTMLButtonElement>('[data-session-bar-sessions]'), '☰').click());
    expect(opened).toBe(1);
  });

  test('draws ⓘ on a phone too, and omits it when the host has no Info', async () => {
    view = await mount(<SessionTopBar actions={null} compact session={sessionView('s1')} />);
    expect(view.container.querySelector('[data-session-info-toggle]')).toBeNull();
    await view.render(
      <SessionTopBar actions={null} compact onToggleInfo={() => undefined} session={sessionView('s1')} />,
    );
    expect(view.container.querySelector('[data-session-info-toggle]')).not.toBeNull();
  });
});

describe('SessionTopBar turn word', () => {
  test('says which dialog a needs-input session is parked on, and only then', async () => {
    const prompt = 'Make auto mode your default permission mode?';
    for (const [turn, compact] of [
      ['needs-input', false],
      ['needs-input', true],
      ['your-turn', false],
    ] as const) {
      view = await mount(
        <SessionTopBar
          actions={null}
          compact={compact}
          session={sessionView('s1', { state: { status: 'running', turnState: turn, turnPrompt: prompt } })}
          turn={turn}
        />,
      );
      const status = must(view.container.querySelector('.fy-session-bar__status'), 'the status');
      const shown = status.querySelector('[data-session-blocked-by]');
      if (turn === 'needs-input') {
        expect(status.getAttribute('title')).toBe(`On screen: ${prompt}`);
        expect(shown?.textContent).toBe(`, on screen: ${prompt}`);
        // A phone keeps the words for a screen reader; the room goes to the name.
        expect(shown?.className).toBe(compact ? 'sr-only' : 'fy-session-bar__blocked');
      } else {
        expect(status.getAttribute('title')).toBeNull();
        expect(shown).toBeNull();
      }
      await view.unmount();
      view = null;
    }
  });

  test('says a permission prompt as the request it is waiting for approval on', async () => {
    const permissionRequest: PermissionRequest = {
      id: '0123456789abcdef',
      harness: 'claude',
      tool: 'Read',
      action: 'read',
      what: '/etc/hostname',
      question: 'Do you want to proceed?',
      options: [
        { number: 1, label: 'Yes', kind: 'allow' },
        { number: 2, label: 'No', kind: 'deny' },
      ],
      selected: 1,
    };
    for (const turn of ['needs-input', 'working'] as const) {
      view = await mount(
        <SessionTopBar
          actions={null}
          compact={false}
          session={sessionView('s1', {
            state: { status: 'running', turnState: turn, turnPrompt: 'Do you want to proceed?', permissionRequest },
          })}
          turn={turn}
        />,
      );
      const status = must(view.container.querySelector('.fy-session-bar__status'), 'the status');
      const shown = status.querySelector('[data-session-blocked-by]');
      if (turn === 'needs-input') {
        expect(status.getAttribute('title')).toBe('Waiting for approval: read /etc/hostname');
        expect(shown?.textContent).toBe(', Waiting for approval: read /etc/hostname');
      } else {
        expect(status.getAttribute('title')).toBeNull();
        expect(shown).toBeNull();
      }
      await view.unmount();
      view = null;
    }
  });

  test('says a harness dialog as the harness it is waiting on and its own title', async () => {
    const harnessDialog: HarnessDialog = {
      id: '0123456789abcdef',
      harness: 'codex',
      kind: 'hooks-review',
      title: 'Hooks need review',
      options: [{ number: 1, label: 'Review hooks', grantsTrust: false }],
      selected: 1,
    };
    for (const turn of ['needs-input', 'working'] as const) {
      view = await mount(
        <SessionTopBar
          actions={null}
          compact={false}
          session={sessionView('s1', {
            state: { status: 'running', turnState: turn, turnPrompt: 'Hooks need review', harnessDialog },
          })}
          turn={turn}
        />,
      );
      const status = must(view.container.querySelector('.fy-session-bar__status'), 'the status');
      const shown = status.querySelector('[data-session-blocked-by]');
      if (turn === 'needs-input') {
        expect(status.getAttribute('title')).toBe('Waiting on Codex: Hooks need review');
        expect(shown?.textContent).toBe(', Waiting on Codex: Hooks need review');
      } else {
        expect(status.getAttribute('title')).toBeNull();
        expect(shown).toBeNull();
      }
      await view.unmount();
      view = null;
    }
  });

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
