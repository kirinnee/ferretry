import { afterEach, describe, expect, test } from 'bun:test';
import type { HarnessDialog, PermissionRequest } from '@ferretry/protocol';
import { SessionTopBar, sessionDisplayName } from '../../src/components/session-top-bar.tsx';
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

describe('SessionTopBar', () => {
  test('draws the name, project and status in one row, with the actions, ⓘ Info and the Actions menu', async () => {
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
        project="ferretry"
        session={sessionView('s1', { config: { teammate: 'hadi', name: 'Fix the sign-in', label: 'diene-cyan' } })}
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
    expect(bar.querySelector('[data-menu-slot]')).not.toBeNull();
    // The old ⋯ menu is gone: LOOK is Info, DO is Actions.
    expect(bar.querySelector('[data-session-more]')).toBeNull();

    const info = must(bar.querySelector<HTMLButtonElement>('[data-session-info-toggle]'), 'the ⓘ toggle');
    expect(info.getAttribute('aria-pressed')).toBe('true');
    // On a desktop the word is the label; no aria-label repeats it.
    expect(info.textContent).toBe('Info');
    expect(info.hasAttribute('aria-label')).toBe(false);
    await interact(() => info.click());
    expect(toggled).toBe(1);
  });

  test('says who started the ferret as a link, and drops it on a phone', async () => {
    let opened = 0;
    const props = {
      actions: null,
      project: 'ferretry',
      session: sessionView('s1'),
      startedBy: { name: 'Hadi', onOpen: () => (opened += 1) },
    };
    view = await mount(<SessionTopBar {...props} compact={false} />);
    const link = must(view.container.querySelector<HTMLButtonElement>('[data-session-started-by]'), 'the link');
    expect(link.textContent).toBe('Started by Hadi');
    await interact(() => link.click());
    expect(opened).toBe(1);
    await view.render(<SessionTopBar {...props} compact />);
    expect(view.container.querySelector('[data-session-started-by]')).toBeNull();
  });

  test('carries the sub-ferret indicator beside the name on a desktop and draws none on a phone', async () => {
    const props = { actions: null, project: null, session: sessionView('s1'), subFerrets: <span data-pack-slot="" /> };
    view = await mount(<SessionTopBar {...props} compact={false} />);
    expect(view.container.querySelector('.fy-session-bar__who [data-pack-slot]')).not.toBeNull();
    await view.render(<SessionTopBar {...props} compact />);
    expect(view.container.querySelector('[data-pack-slot]')).toBeNull();
  });

  test('on a phone it keeps the name and the dot, drops the project, and opens the sessions drawer', async () => {
    let opened = 0;
    view = await mount(
      <SessionTopBar
        actions={null}
        compact
        onOpenSessions={() => (opened += 1)}
        onToggleInfo={() => undefined}
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
    // The phone ⓘ is an icon: its name is the aria-label, and it starts unpressed.
    const info = must(bar.querySelector<HTMLButtonElement>('[data-session-info-toggle]'), 'the ⓘ toggle');
    expect(info.getAttribute('aria-label')).toBe('Info');
    expect(info.getAttribute('aria-pressed')).toBe('false');
    expect(info.textContent).toBe('');
    await interact(() => must(bar.querySelector<HTMLButtonElement>('[data-session-bar-sessions]'), '☰').click());
    expect(opened).toBe(1);
  });

  test('shows an accent count while items are open, and nothing at all when clear', async () => {
    const props = { actions: null, compact: false, project: null, session: sessionView('s1') };
    view = await mount(<SessionTopBar {...props} attentionOpen={3} />);
    const badge = must(view.container.querySelector('.fy-session-bar__attention'), 'the count badge');
    expect(badge.textContent).toContain('3');
    await view.render(<SessionTopBar {...props} attentionOpen={0} />);
    expect(view.container.querySelector('.fy-session-bar__attention')).toBeNull();
    await view.render(<SessionTopBar {...props} />);
    expect(view.container.querySelector('.fy-session-bar__attention')).toBeNull();
  });

  test('on a phone it draws no switch marks — they live in Info — and on a desktop it still does', async () => {
    const props = {
      actions: null,
      project: null,
      session: sessionView('s1', { config: { teammate: 'hadi', mode: 'interactive' } }),
      switches: { learning: true, hypermedia: true, pack: true },
    };
    view = await mount(<SessionTopBar {...props} compact={false} />);
    expect(view.container.querySelector('[data-switch-marks]')).not.toBeNull();
    await view.render(<SessionTopBar {...props} compact />);
    expect(view.container.querySelector('[data-switch-marks]')).toBeNull();
    expect(view.container.querySelector('[data-switch-mark]')).toBeNull();
  });

  test('omits the project when the folder cannot be named, and ⓘ when the host has no Info', async () => {
    view = await mount(<SessionTopBar actions={null} compact={false} project={null} session={sessionView('s1')} />);
    expect(view.container.querySelector('.fy-session-bar__project')).toBeNull();
    expect(view.container.querySelector('[data-session-info-toggle]')).toBeNull();
  });
});

describe('SessionTopBar trailing slot', () => {
  test('draws the trailing control last, after the Actions menu', async () => {
    view = await mount(
      <SessionTopBar
        actions={null}
        compact
        menu={<button type="button">Actions</button>}
        project={null}
        session={sessionView('s1')}
        trailing={<span data-trailing-slot="" />}
      />,
    );
    const bar = must(view.container.querySelector('[data-session-bar]'), 'the session bar');
    expect(bar.lastElementChild?.matches('[data-trailing-slot]')).toBe(true);
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
          project={null}
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
          project={null}
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
          project={null}
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

describe('the hypermedia mark', () => {
  test('sits beside the name while the ferret may use hypermedia, and is gone once it is off', async () => {
    const bar = (hypermedia: boolean | undefined) => (
      <SessionTopBar
        actions={null}
        compact={false}
        project={null}
        session={sessionView('s1', {
          config: { teammate: 'hadi', mode: 'interactive', ...(hypermedia === undefined ? {} : { hypermedia }) },
        })}
      />
    );
    view = await mount(bar(undefined));
    expect(
      view.container.querySelector('.fy-session-bar__who [data-switch-mark="hypermedia"]')?.getAttribute('aria-label'),
    ).toContain('Hypermedia on');
    await view.unmount();
    view = await mount(bar(false));
    expect(view.container.querySelector('[data-switch-mark="hypermedia"]')).toBeNull();
  });
});
