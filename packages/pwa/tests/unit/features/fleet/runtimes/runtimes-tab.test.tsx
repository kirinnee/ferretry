import { afterEach, describe, expect, it } from 'bun:test';
import type { FleetMachineView, FleetRuntimeCatalog, FleetRuntimeView } from '@ferretry/protocol';
import { FleetRuntimeCatalogSchema } from '@ferretry/protocol';
import type { FleetClient } from '../../../../../src/features/fleet/fleet-client.ts';
import { launchHref, RuntimesTab } from '../../../../../src/features/fleet/runtimes/runtimes-tab.tsx';
import { interact, mount, must } from '../../../../support/dom.ts';
import {
  APPLIED,
  type Call,
  CHANGE_ID,
  DATA,
  machine,
  READS,
  RUNTIMES,
  runtime,
  STUDIO,
  scripted,
  stagedFrom,
} from '../account-support.ts';

const APPLY = `POST /v1/fleet/proposals/${CHANGE_ID}/apply`;

afterEach(() => {
  window.location.hash = '';
  window.history.pushState({}, '', '/');
});

const settle = async (): Promise<void> => {
  await interact(async () => {
    for (let turn = 0; turn < 4; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
};

const click = async (container: ParentNode, selector: string): Promise<void> => {
  const element = must(container.querySelector<HTMLElement>(selector), selector);
  await interact(() => element.click());
};

const text = (container: ParentNode, selector: string): string =>
  must(container.querySelector(selector), selector).textContent ?? '';

const catalog = (runtimes: readonly FleetRuntimeView[]): FleetRuntimeCatalog =>
  FleetRuntimeCatalogSchema.parse({ ...RUNTIMES, runtimes });

const reads = (runtimes: readonly FleetRuntimeView[] = RUNTIMES.runtimes) => ({
  ...READS({ ...DATA, runtimes: catalog(runtimes) }),
});

interface TabOptions {
  readonly routes?: Record<string, unknown>;
  readonly machine?: FleetMachineView | null;
  readonly online?: boolean;
  readonly calls?: Call[];
  readonly createClient?: () => Promise<FleetClient>;
}

const open = async (options: TabOptions = {}) => {
  const client = scripted(options.routes ?? reads(), options.calls);
  const view = await mount(
    <RuntimesTab
      connection={STUDIO}
      machineName="studio-mac"
      machine={options.machine === undefined ? machine() : options.machine}
      online={options.online ?? true}
      checking={false}
      onRetry={() => undefined}
      createClient={options.createClient ?? (async () => client)}
      pollMs={5}
    />,
  );
  await settle();
  return view;
};

const page = async (name: string, options: TabOptions = {}) => {
  window.location.hash = `#machines/studio-mac/runtimes/${name}`;
  return await open(options);
};

const pageWith = async (overrides: Partial<FleetRuntimeView> & { name: string }, options: TabOptions = {}) =>
  await page(overrides.name, { routes: reads([runtime(overrides)]), ...options });

describe('Runtimes tab list', () => {
  it('lists every runtime with its login, profile and default model, and marks the agent one', async () => {
    const view = await open();
    expect(text(view.container, '[data-runtimes-tab] > div p')).toBe('5 runtimes on studio-mac');
    expect(view.container.querySelectorAll('[data-runtime-row]')).toHaveLength(5);
    expect(text(view.container, '[data-runtime-row="claude-default"]')).toContain(
      'you@example.com (personal) · Default profile · Sonnet 5.5',
    );
    expect(text(view.container, '[data-runtime-row="codex-default"]')).toContain(
      'you@example.com · Default profile · GPT-6',
    );
    expect(text(view.container, '[data-runtime-row="claude-review"]')).toContain('Harness default');
    expect(view.container.querySelector('[data-runtime-row="claude-default"]')?.getAttribute('href')).toBe(
      '#machines/studio-mac/runtimes/claude-default',
    );
    const badges = (name: string) =>
      view.container.querySelector(`[data-runtime-row="${name}"]`)?.querySelectorAll('[data-tone="accent"]');
    expect(badges('claude-agent')).toHaveLength(1);
    expect(badges('claude-agent')?.[0]?.textContent).toBe('Agent');
    expect(badges('claude-default')).toHaveLength(0);
    expect(view.container.querySelector('[data-runtime-missing-harness]')).toBeNull();
    expect(text(view.container, '[data-add-runtime]')).toBe('Add runtime');
    await view.unmount();
  });

  it('says "1 runtime" for one, and names a login the machine no longer lists as unknown', async () => {
    const orphan = runtime({
      name: 'orphan',
      credential: { id: 'gone', store: 'ferretry', status: 'ready' },
    });
    const view = await open({ routes: reads([orphan]) });
    expect(text(view.container, '[data-runtimes-tab] > div p')).toBe('1 runtime on studio-mac');
    expect(text(view.container, '[data-runtime-row="orphan"]')).toContain('Unknown login · Default profile');
    await view.unmount();
  });

  it('says on the row when the tool is not installed here, with a link to Settings', async () => {
    const view = await open({
      machine: machine({
        tools: [
          { harness: 'claude', label: 'Claude Code', installed: true, command: '/usr/local/bin/claude' },
          { harness: 'codex', label: 'Codex', installed: false },
        ],
      }),
    });
    const notes = view.container.querySelectorAll('[data-runtime-missing-harness]');
    expect(notes).toHaveLength(1);
    expect(notes[0]?.textContent).toBe('Codex isn’t installed here · Install');
    expect(notes[0]?.querySelector('a')?.getAttribute('href')).toBe('#machines/studio-mac/machine');
    await view.unmount();

    const unknown = await open({ machine: null });
    expect(unknown.container.querySelector('[data-runtime-missing-harness]')).toBeNull();
    await unknown.unmount();
  });

  it('E10: no runtimes yet says what a runtime is and offers the first one', async () => {
    const view = await open({ routes: reads([]) });
    expect(text(view.container, '[data-runtimes-empty] h3')).toBe('No runtimes on studio-mac yet');
    expect(text(view.container, '[data-runtimes-empty] p')).toBe(
      'A runtime is a login plus a profile. It’s the thing you launch.',
    );
    expect(text(view.container, '[data-runtimes-empty] button')).toBe('Add your first runtime');
    expect(view.container.querySelector('[data-runtime-row]')).toBeNull();
    await click(view.container, '[data-add-runtime]');
    expect(text(view.container, '[data-add-runtime] h3')).toBe('Add a runtime');
    await view.unmount();
  });

  it('M3: a machine that is not set up says it has no runtimes, and offers nothing to add yet', async () => {
    const view = await open({ machine: machine({ setUp: false }) });
    const note = must(view.container.querySelector('[data-runtimes-not-set-up]'), 'not set up');
    expect(text(note, 'h3')).toBe('No runtimes on studio-mac yet');
    // The way into setup is the banner above the tabs, so this card carries no second copy of it.
    expect(note.textContent).toContain('Finish setting it up above to bring in your Claude Code and Codex setup.');
    expect(note.querySelector('a, button')).toBeNull();
    expect(view.container.querySelector('[data-runtimes-tab]')).toBeNull();
    expect(view.container.querySelector('[data-add-runtime]')).toBeNull();
    await view.unmount();
  });

  it('reads the runtimes first, and says so while it waits', async () => {
    const waiting = await mount(
      <RuntimesTab
        connection={STUDIO}
        machineName="studio-mac"
        machine={machine()}
        online
        checking={false}
        onRetry={() => undefined}
        createClient={() => new Promise<FleetClient>(() => undefined)}
      />,
    );
    expect(text(waiting.container, '[data-runtimes-loading]')).toBe('Reading the runtimes on studio-mac…');
    await waiting.unmount();
  });

  it('a machine that does not answer shows one sentence and no list', async () => {
    const view = await open({ createClient: async () => Promise.reject(new Error('no carrier')) });
    expect(text(view.container, '[data-runtimes-failed]')).toContain('didn’t answer');
    expect(view.container.querySelector('[data-runtimes-tab]')).toBeNull();
    await view.unmount();
  });
});

describe('Add runtime from the tab', () => {
  const journey = async (view: Awaited<ReturnType<typeof open>>): Promise<void> => {
    await click(view.container, '[data-add-runtime]');
    await click(view.container, '[data-add-runtime-credential="claude-personal"] input');
    await click(view.container, '[data-add-runtime-profile="Claude hooks"] input');
    expect(must(view.container.querySelector<HTMLInputElement>('#add-runtime-name'), 'name').value).toBe(
      'claude-claude-hooks',
    );
    await click(view.container, '[data-change-submit]');
    await settle();
  };

  it('opens the one form in place of the list, and its way back returns to the list', async () => {
    const view = await open();
    await click(view.container, '[data-add-runtime]');
    expect(text(view.container, 'h3')).toBe('Add a runtime');
    expect(view.container.querySelector('[data-runtimes-tab]')).toBeNull();
    await click(view.container, '[data-page-back]');
    expect(view.container.querySelectorAll('[data-runtime-row]')).toHaveLength(5);
    expect(window.location.hash).toBe('#machines/studio-mac/runtimes');
    await view.unmount();
  });

  it('creates a runtime, re-reads, and Open lands on the runtime’s own page', async () => {
    const made = runtime({ name: 'claude-claude-hooks', profile: 'Claude hooks' });
    let created = false;
    const calls: Call[] = [];
    const view = await open({
      calls,
      routes: {
        ...reads(),
        'GET /v1/fleet/runtimes': () => catalog(created ? [...RUNTIMES.runtimes, made] : RUNTIMES.runtimes),
        'POST /v1/fleet/proposals': (call: Call) => stagedFrom(call),
        [APPLY]: () => {
          created = true;
          return APPLIED;
        },
      },
    });
    await journey(view);
    expect(text(view.container, '[data-add-runtime-done]')).toContain('claude-claude-hooks is ready to launch');
    await click(view.container, '[data-add-runtime-finish="open"]');
    expect(view.container.querySelector('[data-runtime-page="claude-claude-hooks"]')).not.toBeNull();
    expect(window.location.hash).toBe('#machines/studio-mac/runtimes/claude-claude-hooks');
    await view.unmount();
  });

  it('Back to Runtimes returns to the list, which keeps what was last seen beside the failed re-read', async () => {
    let reads_ = 0;
    const view = await open({
      routes: {
        ...reads(),
        'GET /v1/fleet/runtimes': () => {
          reads_ += 1;
          return reads_ === 1 ? RUNTIMES : new Error('gone');
        },
        'POST /v1/fleet/proposals': (call: Call) => stagedFrom(call),
        [APPLY]: APPLIED,
      },
    });
    await journey(view);
    await click(view.container, '[data-add-runtime-finish="list"]');
    expect(view.container.querySelectorAll('[data-runtime-row]')).toHaveLength(5);
    expect(text(view.container, '[data-runtimes-tab] [role="alert"]')).toContain('didn’t answer');
    expect(window.location.hash).toBe('#machines/studio-mac/runtimes');
    await view.unmount();
  });
});

describe('a runtime’s own page', () => {
  it('shows the login and profile as links, with the profile’s size', async () => {
    const view = await page('claude-default');
    expect(text(view.container, 'h3')).toBe('claude-default');
    expect(text(view.container, '[data-runtime-page] p')).toContain('Ready');
    expect(text(view.container, '[data-runtime-page] p')).not.toContain('Agent runtime');
    const login = must(view.container.querySelector('[data-runtime-credential]'), 'login link');
    expect(login.getAttribute('href')).toBe('#machines/studio-mac/credentials/claude-personal');
    expect(login.textContent).toContain('you@example.com (personal)');
    expect(login.textContent).toContain('Claude Code');
    const profile = must(view.container.querySelector('[data-runtime-profile]'), 'profile link');
    expect(profile.getAttribute('href')).toBe('#machines/studio-mac/profiles/Default');
    expect(profile.textContent).toContain('4 layers · 2 parts');
    expect(view.container.querySelector('[data-runtime-note]')).toBeNull();
    await view.unmount();
  });

  it('Back to Runtimes in the header returns to the list', async () => {
    const view = await page('claude-default');
    await click(view.container, '[data-page-back]');
    expect(view.container.querySelector('[data-runtime-page]')).toBeNull();
    expect(view.container.querySelectorAll('[data-runtime-row]')).toHaveLength(5);
    expect(window.location.hash).toBe('#machines/studio-mac/runtimes');
    await view.unmount();
  });

  it('a link to a runtime that is gone says so above the list', async () => {
    const view = await page('ghost');
    expect(text(view.container, '[data-runtime-missing]')).toBe('There is no runtime ghost on studio-mac any more.');
    expect(view.container.querySelectorAll('[data-runtime-row]')).toHaveLength(5);
    await view.unmount();
  });

  it('notes a missing tool, with the link to install it', async () => {
    const view = await page('claude-default', {
      machine: machine({
        tools: [{ harness: 'claude', label: 'Claude Code', installed: false }],
      }),
    });
    const note = must(view.container.querySelector('[data-runtime-note="missing"]'), 'missing note');
    expect(note.textContent).toContain('Claude Code isn’t installed here');
    expect(note.textContent).toContain('Install it on studio-mac to launch this runtime.');
    expect(note.querySelector('a')?.textContent).toBe('Install Claude Code');
    expect(note.querySelector('a')?.getAttribute('href')).toBe('#machines/studio-mac/machine');
    await view.unmount();
  });

  it('a login that needs sign-in says so and links to where it is signed in', async () => {
    const view = await pageWith({
      name: 'claude-work',
      credential: { id: 'claude-work', store: 'ferretry', label: 'work', status: 'needs_sign_in' },
    });
    const note = must(view.container.querySelector('[data-runtime-note="sign-in"]'), 'sign-in note');
    expect(note.textContent).toContain('This login needs sign-in');
    expect(note.textContent).toContain('Sign in once and every runtime that uses it can launch.');
    expect(note.querySelector('[data-runtime-sign-in]')?.getAttribute('href')).toBe(
      '#machines/studio-mac/credentials/claude-work',
    );
    expect(view.container.querySelector('[data-runtime-note="refresh"]')).toBeNull();
    await view.unmount();
  });

  it('a login with a refresh due says nothing needs doing', async () => {
    const view = await page('claude-work');
    const note = must(view.container.querySelector('[data-runtime-note="refresh"]'), 'refresh note');
    expect(note.textContent).toContain('Refresh due');
    expect(note.textContent).toContain('Ferretry renews the sign-in when you launch. Nothing to do.');
    expect(view.container.querySelector('[data-runtime-note="sign-in"]')).toBeNull();
    await view.unmount();
  });

  it('lists the profile’s layers newest on top, numbered, with what each needs said beside it', async () => {
    const view = await page('claude-default');
    const layers = [...view.container.querySelectorAll('[data-runtime-layer]')];
    expect(layers.map(layer => layer.getAttribute('data-runtime-layer'))).toEqual([
      'modelSets/Claude models',
      'settings/Claude settings',
      'skills/My skills',
      'instructions/Main instructions',
    ]);
    expect(layers.map(layer => layer.querySelector('span')?.textContent)).toEqual(['4', '3', '2', '1']);
    expect(text(view.container, '[data-runtime-layers] > p')).toBe('Newest on top · newer layer wins');
    const settings = must(view.container.querySelector('[data-runtime-layer="settings/Claude settings"]'), 'settings');
    expect(settings.textContent).toContain('Settings · Claude settings');
    expect(settings.querySelector('[data-tone]')?.textContent).toBe('Claude Code only');
    expect(settings.querySelector('[data-tone]')?.getAttribute('data-tone')).toBe('pend');
    const skills = must(view.container.querySelector('[data-runtime-layer="skills/My skills"]'), 'skills');
    expect(skills.querySelector('[data-tone]')?.textContent).toBe('Partly supported on Codex');
    expect(skills.querySelector('[data-tone]')?.getAttribute('data-tone')).toBe('warn');
    const plain = must(
      view.container.querySelector('[data-runtime-layer="instructions/Main instructions"]'),
      'instructions',
    );
    expect(plain.querySelector('[data-tone]')).toBeNull();
    await view.unmount();
  });

  it('marks a layer this harness skips, dimmed, and warns about a hook whose command is not found', async () => {
    const codex = await page('codex-default');
    const skipped = must(
      codex.container.querySelector('[data-runtime-layer="settings/Claude settings"]'),
      'skipped layer',
    );
    const words = [...skipped.querySelectorAll('[data-tone]')].map(badge => badge.textContent);
    expect(words).toEqual(['Skipped on Codex', 'Claude Code only']);
    expect(skipped.className).toContain('opacity-60');
    expect(skipped.querySelector('[data-tone]')?.getAttribute('data-tone')).toBe('pend');
    expect(text(codex.container, '[data-runtime-profile]')).toContain('4 layers · 3 parts · 1 skipped on Codex');
    await codex.unmount();

    const hooks = await pageWith({ name: 'claude-hooks', profile: 'Claude hooks' });
    const hook = must(hooks.container.querySelector('[data-runtime-layer="hooks/Format on save"]'), 'hook layer');
    const badges = [...hook.querySelectorAll('[data-tone]')].map(badge => [
      badge.textContent,
      badge.getAttribute('data-tone'),
    ]);
    expect(badges).toEqual([
      ['Claude Code only', 'pend'],
      ['Command not found: fmt-hook', 'warn'],
    ]);
    await hooks.unmount();

    const based = await pageWith({ name: 'claude-agent-work', profile: 'Agent work' });
    expect(text(based.container, '[data-runtime-layer="profile/Default"]')).toContain('Profile · Default');
    expect(text(based.container, '[data-runtime-layer="profile/Default"]')).toContain('Used as a base');
    await based.unmount();
  });

  it('shows no layers when the profile is not on the machine any more', async () => {
    const view = await pageWith({ name: 'claude-lost', profile: 'Vanished' });
    expect(view.container.querySelector('[data-runtime-layers]')).toBeNull();
    expect(text(view.container, '[data-runtime-profile]')).toContain('Vanished');
    expect(text(view.container, '[data-runtime-profile]')).toContain('2 parts');
    expect(text(view.container, '[data-runtime-profile]')).not.toContain('layers');
    await view.unmount();
  });

  it('E23: the model set strikes through what this login cannot use and marks the default', async () => {
    const view = await page('codex-default');
    const rows = [...view.container.querySelectorAll('[data-runtime-models] li')];
    expect(rows.map(row => row.textContent)).toEqual(['GPT-6Default', 'Opus 5.5Not available on this login']);
    expect(rows[0]?.querySelector('s')).toBeNull();
    expect(rows[1]?.querySelector('s')?.textContent).toBe('Opus 5.5');
    expect(text(view.container, '[data-runtime-model-note]')).toBe(
      "From Claude models in the Default profile. Its default, Opus 5.5, isn't available on this login, so this runtime starts on GPT-6, the first one that is.",
    );
    await view.unmount();

    const claude = await page('claude-default');
    const available = [...claude.container.querySelectorAll('[data-runtime-models] li')].map(row => row.textContent);
    expect(available).toEqual(['Opus 5.5', 'Sonnet 5.5Default']);
    expect(text(claude.container, '[data-runtime-model-note]')).toBe('From Claude models in the Default profile.');
    await claude.unmount();

    const none = await page('claude-review');
    expect(none.container.querySelector('[data-runtime-models]')).toBeNull();
    expect(text(none.container, '[data-runtime-model-note]')).toBe(
      'No model set in this profile. The harness picks its own default.',
    );
    await none.unmount();
  });

  it('E24: an agent runtime shows its locked fixed layer and what it overrides', async () => {
    const view = await page('claude-agent');
    expect(text(view.container, '[data-runtime-page] p')).toContain('Agent runtime');
    const fixed = must(view.container.querySelector('[data-runtime-fixed-layer]'), 'fixed layer');
    expect(fixed.textContent).toContain('Ferretry launches claude-agent as an agent, so it adds a locked layer last.');
    expect(fixed.textContent).toContain('You can’t edit it here.');
    expect(fixed.textContent).toContain('permissions.defaultMode = auto');
    expect(fixed.textContent).toContain('trust prompt = off');
    const overridden = must(view.container.querySelector('[data-runtime-overridden]'), 'overridden');
    expect(overridden.querySelector('s')?.textContent).toBe('permissions.defaultMode = acceptEdits');
    expect(overridden.textContent).toContain('From your Agent settings · Overridden for agents by Ferretry');
    await view.unmount();

    const plain = await page('claude-default');
    expect(plain.container.querySelector('[data-runtime-fixed-layer]')).toBeNull();
    await plain.unmount();

    const quiet = await pageWith({
      name: 'claude-quiet',
      agent: true,
      fixedLayer: { agentPermissions: 'auto', entries: [{ key: 'trust prompt', value: 'off' }], overridden: [] },
    });
    expect(quiet.container.querySelector('[data-runtime-fixed-layer]')).not.toBeNull();
    expect(quiet.container.querySelector('[data-runtime-overridden]')).toBeNull();
    await quiet.unmount();
  });
});

describe('Launch', () => {
  it('is a link to the New session form with the runtime picked, and nothing starts by itself', async () => {
    const calls: Call[] = [];
    const view = await page('claude-default', { calls });
    const launch = must(view.container.querySelector<HTMLAnchorElement>('a[data-runtime-launch]'), 'launch');
    expect(launch.textContent).toBe('Launch claude-default');
    expect(launch.getAttribute('href')).toBe('/d/studio/new?agent=claude-default');
    expect(launchHref(STUDIO, 'a b')).toBe('/d/studio/new?agent=a%20b');
    expect(calls.every(call => call.method === 'GET')).toBe(true);
    await view.unmount();
  });

  it('follows the link inside the app: pushes the address and tells the router, without a reload', async () => {
    const view = await page('claude-default');
    const launch = must(view.container.querySelector<HTMLAnchorElement>('a[data-runtime-launch]'), 'launch');
    const popped: string[] = [];
    const listener = (): void => {
      popped.push(`${window.location.pathname}${window.location.search}`);
    };
    window.addEventListener('popstate', listener);
    try {
      const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
      await interact(() => launch.dispatchEvent(click));
      expect(click.defaultPrevented).toBe(true);
      expect(popped).toEqual(['/d/studio/new?agent=claude-default']);
    } finally {
      window.removeEventListener('popstate', listener);
    }
    await view.unmount();
  });

  it('leaves a modified or non-primary click to the browser', async () => {
    const view = await page('claude-default');
    const launch = must(view.container.querySelector<HTMLAnchorElement>('a[data-runtime-launch]'), 'launch');
    const popped: string[] = [];
    const listener = (): void => {
      popped.push('popstate');
    };
    window.addEventListener('popstate', listener);
    try {
      for (const init of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { button: 1 }]) {
        const click = new MouseEvent('click', { bubbles: true, cancelable: true, ...init });
        await interact(() => launch.dispatchEvent(click));
        expect(click.defaultPrevented).toBe(false);
      }
      expect(popped).toEqual([]);
    } finally {
      window.removeEventListener('popstate', listener);
    }
    await view.unmount();
  });

  it('is a disabled button saying why when the runtime cannot launch', async () => {
    const view = await pageWith({
      name: 'claude-work',
      launch: { available: false, reason: 'Sign in to this login first.' },
    });
    const launch = must(view.container.querySelector<HTMLButtonElement>('button[data-runtime-launch]'), 'launch');
    expect(launch.disabled).toBe(true);
    expect(launch.textContent).toBe('Sign in to this login first.');
    expect(view.container.querySelector('a[data-runtime-launch]')).toBeNull();
    await view.unmount();
  });

  it('waits while the machine is offline, even for a runtime that could launch', async () => {
    const view = await page('claude-default', { online: false });
    const launch = must(view.container.querySelector<HTMLButtonElement>('button[data-runtime-launch]'), 'launch');
    expect(launch.disabled).toBe(true);
    expect(launch.textContent).toBe('Waiting for studio-mac');
    await view.unmount();
  });
});

describe('Runtimes tab › Import conversations', () => {
  it('swaps to the picker next to Add runtime, and Back returns to the list', async () => {
    const view = await open({
      routes: {
        ...reads(),
        'GET /v1/imports/conversations?harness=claude&limit=5000': { conversations: [], matched: 0, skipped: 0 },
      },
    });
    expect(text(view.container, '[data-import-conversations-open]')).toBe('Import conversations…');
    await click(view.container, '[data-import-conversations-open]');
    await settle();
    expect(text(view.container, '[data-import-conversations] h3')).toBe('Import conversations');
    expect(text(view.container, '[data-setup-note="conversations-empty"]')).toBe(
      'No Claude Code conversations on this machine.',
    );
    await click(view.container, '[data-import-conversations] [data-page-back]');
    expect(view.container.querySelector('[data-runtimes-tab]')).not.toBeNull();
    await view.unmount();
  });
});

describe('Runtimes tab › items the provisioner skipped', () => {
  const skippedRuntime = (skipped?: readonly string[]): readonly FleetRuntimeView[] => [
    { ...runtime({ name: 'claude-default' }), ...(skipped === undefined ? {} : { skipped }) },
    ...RUNTIMES.runtimes.slice(1),
  ];

  it('says nothing about a runtime when the daemon names nothing skipped', async () => {
    const view = await open({ routes: reads(skippedRuntime()) });
    expect(view.container.querySelector('[data-runtime-skipped]')).toBeNull();
    await view.unmount();
  });

  it('shows a quiet line INSIDE that runtime’s card that opens a list with the path inside the runtime and a plain reason', async () => {
    const view = await open({ routes: reads(skippedRuntime(['skills/review', 'commands/ship.md'])) });
    const card = must(view.container.querySelector<HTMLElement>('[data-runtime-card="claude-default"]'), 'card');
    const line = must(card.querySelector<HTMLElement>('[data-runtime-skipped="claude-default"]'), 'line in the card');
    expect(view.container.querySelectorAll('[data-runtime-skipped]').length).toBe(1);
    const toggle = must(line.querySelector<HTMLButtonElement>('button'), 'toggle');
    expect(toggle.textContent).toContain('2 items skipped');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(line.querySelector('ul')).toBeNull();

    await interact(() => toggle.click());

    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const items = [...line.querySelectorAll('li')];
    expect(items.map(item => item.querySelector('code')?.textContent)).toEqual(['skills/review', 'commands/ship.md']);
    expect(items[0]?.textContent).toContain('left as it was');
    expect(view.container.textContent).not.toContain('/home/kirin');
    await view.unmount();
  });

  it('puts the line under the runtime’s rows and above Rename and Remove', async () => {
    const view = await open({ routes: reads(skippedRuntime(['skills/review'])) });
    const card = must(view.container.querySelector<HTMLElement>('[data-runtime-card="claude-default"]'), 'card');
    const line = must(card.querySelector<HTMLElement>('[data-runtime-skipped]'), 'line');
    const actions = must(card.querySelector<HTMLElement>('[data-runtime-actions]'), 'the actions');
    expect(line.compareDocumentPosition(actions) & window.Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    await view.unmount();
  });

  it('shows the same line on the runtime’s own page', async () => {
    const view = await open({ routes: reads(skippedRuntime(['skills/review'])) });
    window.location.hash = '#machines/studio-mac/runtimes/claude-default';
    await interact(() => window.dispatchEvent(new window.Event('hashchange')));
    const line = must(
      view.container.querySelector<HTMLElement>('[data-runtime-page] [data-runtime-skipped="claude-default"]'),
      'page line',
    );
    expect(line.textContent).toContain('1 item skipped');
    await view.unmount();
  });
});
