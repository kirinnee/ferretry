import { afterEach, describe, expect, it } from 'bun:test';
import type {
  SessionMcpAdded,
  SessionMcpAddRequest,
  SessionMcpListing,
  SessionMcpPreview,
  SessionMcpPreviewRequest,
  SessionMcpScope,
} from '@ferretry/protocol';
import { MCP_OAUTH_PATH } from '@ferretry/protocol';
import type { ContextMcpSignInHost } from '../../../../src/features/context-rail/context-rail-mcp.tsx';
import { AddMcpForm, type AddMcpPorts } from '../../../../src/features/session-actions/add-mcp-form.tsx';
import type { SessionActionFormHost } from '../../../../src/features/session-actions/registry.ts';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { interact, type Mounted, mount, must } from '../../../support/dom.ts';
import { settleUntil } from '../../../support/settle.ts';
import {
  CALLBACK,
  completion,
  factoryFor,
  fakeChannels,
  mcpConnection,
  mcpFlow,
} from '../fleet/mcp-sign-in-support.ts';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const ETAG = 'a'.repeat(64);
const PROJECT_LISTING: SessionMcpListing = { project: { path: '/r/.mcp.json', etag: null, servers: [] } };
const NO_PROJECT_LISTING: SessionMcpListing = { project: null, projectUnavailable: 'This folder is not a checkout.' };

const projectPreview = (
  overrides: Partial<Extract<SessionMcpPreview, { scope: 'project' }>> = {},
): SessionMcpPreview => ({
  scope: 'project',
  path: '/r/.mcp.json',
  etag: null,
  replaces: false,
  diff: [
    { kind: 'context', text: '{' },
    { kind: 'add', text: '  "sentry": { "command": "npx" }' },
    { kind: 'context', text: '}' },
  ],
  ...overrides,
});

const loginPreview = (overrides: Partial<Extract<SessionMcpPreview, { scope: 'login' }>> = {}): SessionMcpPreview => ({
  scope: 'login',
  runtime: 'nero',
  profile: 'default',
  replaces: false,
  ferrets: 1,
  ...overrides,
});

const PROJECT_ADDED: SessionMcpAdded = { scope: 'project', name: 'sentry', path: '/r/.mcp.json', etag: ETAG };
const LOGIN_ADDED: SessionMcpAdded = { scope: 'login', name: 'sentry', runtime: 'nero', profile: 'default' };

interface Call {
  readonly kind: 'listing' | 'preview' | 'add' | 'reload' | 'reloadOthers';
  readonly scope?: SessionMcpScope;
  readonly request?: unknown;
}

interface PortState {
  listingAnswer: SessionMcpListing | Error;
  previewImpl: (scope: SessionMcpScope, request: SessionMcpPreviewRequest) => Promise<SessionMcpPreview>;
  addImpl: (scope: SessionMcpScope, request: SessionMcpAddRequest) => Promise<SessionMcpAdded>;
  reloadImpl: () => Promise<void>;
  reloadOthersImpl?: () => Promise<void>;
  signIn?: ContextMcpSignInHost;
}

const makePorts = (overrides: Partial<PortState> = {}) => {
  const calls: Call[] = [];
  const state: PortState = {
    listingAnswer: PROJECT_LISTING,
    previewImpl: async (scope: SessionMcpScope) => (scope === 'project' ? projectPreview() : loginPreview()),
    addImpl: async (scope: SessionMcpScope) => (scope === 'project' ? PROJECT_ADDED : LOGIN_ADDED),
    reloadImpl: async () => undefined,
    ...overrides,
  };
  const ports: AddMcpPorts = {
    listing: async () => {
      calls.push({ kind: 'listing' });
      if (state.listingAnswer instanceof Error) throw state.listingAnswer;
      return state.listingAnswer;
    },
    preview: async (scope, request) => {
      calls.push({ kind: 'preview', scope, request });
      return state.previewImpl(scope, request);
    },
    add: async (scope, request) => {
      calls.push({ kind: 'add', scope, request });
      return state.addImpl(scope, request);
    },
    reload: async () => {
      calls.push({ kind: 'reload' });
      return state.reloadImpl();
    },
    ...(state.reloadOthersImpl === undefined
      ? {}
      : {
          reloadOthers: async () => {
            calls.push({ kind: 'reloadOthers' });
            await state.reloadOthersImpl?.();
          },
        }),
    ...(state.signIn === undefined ? {} : { signIn: state.signIn }),
  };
  return { ports, calls, state };
};

const type = async (field: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> => {
  await interact(() => {
    const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

const click = async (element: HTMLElement): Promise<void> => interact(() => element.click());

const submitForm = async (root: HTMLElement): Promise<void> => {
  const form = must(root.querySelector('form'), 'the form');
  await interact(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
};

const nameInput = (root: HTMLElement) =>
  must(root.querySelector('input[placeholder="sentry"]'), 'name input') as HTMLInputElement;
const urlInput = (root: HTMLElement) =>
  must(root.querySelector('input[placeholder="https://mcp.sentry.dev/mcp"]'), 'url input') as HTMLInputElement;
const commandInput = (root: HTMLElement) =>
  must(root.querySelector('input[placeholder="npx -y @sentry/mcp-server"]'), 'command input') as HTMLInputElement;
const envTextarea = (root: HTMLElement) => must(root.querySelector('textarea'), 'env textarea') as HTMLTextAreaElement;
const scopeRadio = (root: HTMLElement, value: 'project' | 'login') =>
  must(root.querySelector(`[data-choice="${value}"] input`), `${value} scope radio`) as HTMLInputElement;
const typeRadio = (root: HTMLElement, value: 'command' | 'url') =>
  must(root.querySelector(`.fy-segmented input[value="${value}"]`), `${value} type radio`) as HTMLInputElement;
const submitButton = (root: HTMLElement) =>
  must(root.querySelector('[data-action-submit]'), 'submit button') as HTMLButtonElement;

const HOST_CLOSES = (): {
  readonly host: SessionActionFormHost;
  readonly closes: number[];
  readonly opens: string[];
} => {
  const closes: number[] = [];
  const opens: string[] = [];
  return {
    host: { close: () => closes.push(1), open: id => opens.push(id), notify: () => undefined, compact: false },
    closes,
    opens,
  };
};

const openForm = async (
  portsOverrides: Partial<PortState> = {},
  props: { readonly compact?: boolean; readonly login?: string; readonly project?: string | null } = {},
) => {
  const { ports, calls, state } = makePorts(portsOverrides);
  const { host, closes, opens } = HOST_CLOSES();
  mounted = await mount(
    <AddMcpForm
      agentName="Hadi"
      host={{ ...host, compact: props.compact ?? false }}
      login={props.login ?? 'nero'}
      ports={ports}
      previewDebounceMs={0}
      project={props.project ?? 'ferretry'}
    />,
  );
  return { root: mounted.container, calls, state, closes, opens };
};

const waitForPreview = async (root: HTMLElement): Promise<void> =>
  settleUntil(() => root.querySelector('[data-add-mcp-preview]') !== null, 'the preview to load', interact);

const fillCommandServer = async (
  root: HTMLElement,
  name = 'sentry',
  command = 'npx -y @sentry/mcp-server',
): Promise<void> => {
  await type(nameInput(root), name);
  await type(commandInput(root), command);
};

const waitForAdded = async (root: HTMLElement): Promise<void> =>
  settleUntil(() => root.querySelector('[data-add-mcp-added]') !== null, 'the added step', interact);

/** Fills, previews and submits a project-scope command server; returns once Added is showing. */
const addedProjectForm = async (portsOverrides: Partial<PortState> = {}) => {
  const result = await openForm({
    previewImpl: async () => projectPreview(),
    addImpl: async () => PROJECT_ADDED,
    ...portsOverrides,
  });
  await fillCommandServer(result.root);
  await waitForPreview(result.root);
  await submitForm(result.root);
  await waitForAdded(result.root);
  return result;
};

/** Fills, previews and submits a login-scope command server; returns once Added is showing. */
const addedLoginForm = async (portsOverrides: Partial<PortState> = {}) => {
  const result = await openForm({
    previewImpl: async () => loginPreview(),
    addImpl: async () => LOGIN_ADDED,
    ...portsOverrides,
  });
  await click(scopeRadio(result.root, 'login'));
  await fillCommandServer(result.root);
  await waitForPreview(result.root);
  await submitForm(result.root);
  await waitForAdded(result.root);
  return result;
};

describe('AddMcpForm — the project listing', () => {
  it('starts on project scope and leaves the project card enabled when a project is readable', async () => {
    const { root } = await openForm();
    await settleUntil(() => root.querySelector('[data-choice]') !== null, 'the choice cards', interact);
    await interact(() => undefined);
    expect(scopeRadio(root, 'project').disabled).toBe(false);
    expect(scopeRadio(root, 'project').checked).toBe(true);
  });

  it('falls back to login scope and disables the project card when there is no project here', async () => {
    const { root } = await openForm({ listingAnswer: NO_PROJECT_LISTING });
    await settleUntil(() => scopeRadio(root, 'login').checked, 'the scope to fall back to login', interact);
    expect(scopeRadio(root, 'project').disabled).toBe(true);
    expect(root.textContent).toContain('This folder is not a checkout.');
  });

  it('disables the project card with its own sentence when the listing read itself fails', async () => {
    const { root } = await openForm({ listingAnswer: new Error('offline') });
    await settleUntil(
      () => root.textContent?.includes('Ferretry could not read this ferret’s project.') === true,
      'the listing failure sentence',
      interact,
    );
    expect(scopeRadio(root, 'project').disabled).toBe(true);
  });
});

describe('AddMcpForm — a URL server in the project', () => {
  it('says a project server signs in from Context › MCP once added, and offers no switch here', async () => {
    const { root } = await openForm();
    await settleUntil(() => root.querySelector('[data-choice]') !== null, 'the choice cards', interact);
    await click(typeRadio(root, 'url'));
    expect(root.textContent).toContain(
      'If it asks for a sign-in, sign in from Info › Context › MCP once it is added: Ferretry keeps the token for this project.',
    );
    expect(root.querySelector('input[type="checkbox"]')).toBeNull();
  });
});

describe('AddMcpForm — the inline refusal', () => {
  it('shows nothing while the fields are simply empty', async () => {
    const { root } = await openForm();
    expect(root.querySelector('[data-add-mcp-refusal]')).toBeNull();
  });

  it('shows the protocol’s own refusal once the person types something it rejects', async () => {
    const { root } = await openForm();
    await type(nameInput(root), '-bad');
    await type(commandInput(root), 'npx server');
    expect(must(root.querySelector('[data-add-mcp-refusal]'), 'refusal').textContent).toBe(
      'Name: use letters, digits, - and _, starting with a letter or digit.',
    );
  });

  it('refuses a raw-looking secret typed into the environment, with the project’s own way out', async () => {
    const { root } = await openForm();
    await fillCommandServer(root);
    await type(envTextarea(root), 'TOKEN=1234567890abcdef');
    expect(must(root.querySelector('[data-add-mcp-refusal]'), 'refusal').textContent).toContain(
      'TOKEN looks like a raw secret, and .mcp.json is shared with everyone on the repo.',
    );
  });
});

describe('AddMcpForm — the preview', () => {
  it('shows nothing until the draft is ready to send', async () => {
    const { root } = await openForm();
    await type(nameInput(root), 'sentry');
    expect(root.querySelector('[data-add-mcp-preview]')).toBeNull();
  });

  it('reads a login summary, with the ferret count only when it is more than one', async () => {
    const { root } = await openForm(
      { previewImpl: async () => loginPreview({ ferrets: 3, replaces: true }) },
      { login: 'nero' },
    );
    await click(scopeRadio(root, 'login'));
    await fillCommandServer(root);
    await waitForPreview(root);
    const preview = must(root.querySelector('[data-add-mcp-preview="login"]'), 'login preview');
    expect(preview.textContent).toContain('Replaces the server in profile default');
    expect(preview.textContent).toContain('3 ferrets run on it');
  });

  it('says "Adds" and omits the ferret count for a fresh single-ferret login server', async () => {
    const { root } = await openForm({ previewImpl: async () => loginPreview() });
    await click(scopeRadio(root, 'login'));
    await fillCommandServer(root);
    await waitForPreview(root);
    const preview = must(root.querySelector('[data-add-mcp-preview="login"]'), 'login preview');
    expect(preview.textContent).toContain('Adds the server in profile default');
    expect(preview.textContent).not.toContain('ferrets run on it');
  });

  it('reads a project preview as a new-file diff, line by line', async () => {
    const { root } = await openForm({ previewImpl: async () => projectPreview() });
    await fillCommandServer(root);
    await waitForPreview(root);
    const preview = must(root.querySelector('[data-add-mcp-preview="project"]'), 'project preview');
    expect(preview.textContent).toContain('new file');
    const lines = [...preview.querySelectorAll('.fy-diff__line')];
    expect(lines.map(line => line.getAttribute('data-kind'))).toEqual(['context', 'add', 'context']);
    expect(lines[1]?.textContent).toContain('+ ');
  });

  it('marks a project preview that replaces an existing server', async () => {
    const { root } = await openForm({ previewImpl: async () => projectPreview({ etag: ETAG, replaces: true }) });
    await fillCommandServer(root);
    await waitForPreview(root);
    expect(must(root.querySelector('[data-add-mcp-preview="project"]'), 'preview').textContent).toContain(
      'replaces 1 server',
    );
  });

  it('marks a project preview that only adds a server to an existing file', async () => {
    const { root } = await openForm({ previewImpl: async () => projectPreview({ etag: ETAG, replaces: false }) });
    await fillCommandServer(root);
    await waitForPreview(root);
    expect(must(root.querySelector('[data-add-mcp-preview="project"]'), 'preview').textContent).toContain('+1 server');
  });

  it('shows the daemon’s refusal when the preview itself fails', async () => {
    const { root } = await openForm({
      previewImpl: async () => Promise.reject(new Error('the daemon is unreachable')),
    });
    await fillCommandServer(root);
    await settleUntil(
      () => root.querySelector('[data-add-mcp-preview-failed]') !== null,
      'the preview failure',
      interact,
    );
    expect(must(root.querySelector('[data-add-mcp-preview-failed]'), 'failure').textContent).toBe(
      'the daemon is unreachable',
    );
  });

  it('drops a stale preview answer for a request the person has already changed', async () => {
    let releaseFirst: (() => void) | undefined;
    let calls = 0;
    const { root } = await openForm({
      previewImpl: async () => {
        calls += 1;
        if (calls === 1)
          return new Promise(resolve => {
            releaseFirst = () => resolve(loginPreview({ profile: 'stale' }));
          });
        return loginPreview({ profile: 'fresh' });
      },
    });
    await click(scopeRadio(root, 'login'));
    await fillCommandServer(root, 'sentry', 'npx one');
    // Let the first request actually reach `preview` (and go pending) before changing the draft —
    // changing it any sooner would just debounce the first keystroke away unfired.
    await settleUntil(() => calls >= 1, 'the first preview call to start', interact);
    await type(commandInput(root), 'npx two');
    await waitForPreview(root);
    expect(must(root.querySelector('[data-add-mcp-preview="login"]'), 'preview').textContent).toContain('fresh');
    releaseFirst?.();
    await interact(() => undefined);
    expect(root.textContent).not.toContain('stale');
  });

  it('shows "Reading…" again once the request changes, even while the stale preview is still marked ready', async () => {
    // The second answer is HELD. With no debounce and an instant fake, it could land inside the same
    // turn as the keystroke on a slow runner, and the "Reading…" this test is about would never be on
    // screen to see — so it failed CI having waited 2s for a state that had already come and gone.
    let releaseSecond: (() => void) | undefined;
    let calls = 0;
    const { root } = await openForm({
      previewImpl: async () => {
        calls += 1;
        if (calls === 1) return loginPreview();
        return new Promise(resolve => {
          releaseSecond = () => resolve(loginPreview());
        });
      },
    });
    await click(scopeRadio(root, 'login'));
    await fillCommandServer(root, 'sentry', 'npx one');
    await waitForPreview(root);
    await type(commandInput(root), 'npx two');
    expect(root.textContent).toContain('Reading what this would change…');
    expect(root.querySelector('[data-add-mcp-preview]')).toBeNull();
    // Drain the held call for "npx two" before the test ends, rather than leaving its state update to
    // land after the test (and before unmount) has moved on.
    await settleUntil(() => releaseSecond !== undefined, 'the second preview call to start', interact);
    await interact(() => releaseSecond?.());
    await waitForPreview(root);
    expect(root.textContent).not.toContain('Reading what this would change…');
  });
});

describe('AddMcpForm — submitting', () => {
  it('disables Add until a preview has actually landed', async () => {
    const { root } = await openForm();
    await type(nameInput(root), 'sentry');
    expect(submitButton(root).disabled).toBe(true);
  });

  it('ignores a submit while nothing is ready, and never calls add', async () => {
    const { root, calls } = await openForm();
    await submitForm(root);
    expect(calls.some(call => call.kind === 'add')).toBe(false);
  });

  it('sends the previewed etag on a project add, and becomes the Added step', async () => {
    const { root, calls } = await openForm({
      previewImpl: async () => projectPreview({ etag: ETAG }),
      addImpl: async () => PROJECT_ADDED,
    });
    await fillCommandServer(root);
    await waitForPreview(root);
    await submitForm(root);
    await settleUntil(() => root.querySelector('[data-add-mcp-added]') !== null, 'the added step', interact);
    const addCall = must(
      calls.find(call => call.kind === 'add'),
      'the add call',
    );
    expect(addCall.scope).toBe('project');
    expect((addCall.request as { etag?: string }).etag).toBe(ETAG);
    expect(root.textContent).toContain('Added');
    expect(root.querySelector('[data-add-mcp-added="project"]')).not.toBeNull();
  });

  it('never carries an etag on a login add', async () => {
    const { root, calls } = await openForm({
      previewImpl: async () => loginPreview(),
      addImpl: async () => LOGIN_ADDED,
    });
    await click(scopeRadio(root, 'login'));
    await fillCommandServer(root);
    await waitForPreview(root);
    await submitForm(root);
    await settleUntil(() => root.querySelector('[data-add-mcp-added]') !== null, 'the added step', interact);
    const addCall = calls.find(call => call.kind === 'add');
    expect(addCall?.request).not.toHaveProperty('etag');
  });

  it('shows the daemon’s refusal and stays on the form when the add itself fails', async () => {
    const { root } = await openForm({
      previewImpl: async () => projectPreview(),
      addImpl: async () => Promise.reject(new Error('.mcp.json changed since the preview.')),
    });
    await fillCommandServer(root);
    await waitForPreview(root);
    await submitForm(root);
    await settleUntil(
      () => root.textContent?.includes('.mcp.json changed since the preview.') === true,
      'the failure',
      interact,
    );
    expect(root.querySelector('[data-add-mcp-added]')).toBeNull();
  });
});

describe('AddMcpForm — the Added step', () => {
  it('names the project file it changed, and explains the next reload', async () => {
    const { root } = await addedProjectForm();
    expect(root.textContent).toContain('Added');
    expect(root.textContent).toContain('/r/.mcp.json');
    expect(root.textContent).toContain('Claude Code asks once to trust a new project server');
  });

  it('names the login it changed instead, for a login add', async () => {
    const { root } = await addedLoginForm();
    expect(root.textContent).toContain('login');
    expect(root.textContent).toContain('nero');
    expect(root.textContent).toContain('Other ferrets on this login get it on their next start.');
  });

  it('closes the form through Later, without reloading anything', async () => {
    const { root, calls, closes } = await addedProjectForm();
    const later = must(
      [...root.querySelectorAll('button')].find(button => button.textContent === 'Later'),
      'Later',
    );
    await click(later);
    expect(closes).toEqual([1]);
    expect(calls.some(call => call.kind === 'reload')).toBe(false);
  });

  it('reloads this ferret and closes, through the Reload button', async () => {
    const { root, calls, closes } = await addedProjectForm();
    await click(must(root.querySelector('[data-add-mcp-reload]'), 'reload button'));
    await settleUntil(() => closes.length > 0, 'the reload to finish and close', interact);
    expect(calls.some(call => call.kind === 'reload')).toBe(true);
    expect(closes).toEqual([1]);
  });

  it('shows a reloading state while the reload is in flight', async () => {
    let release: (() => void) | undefined;
    const { root } = await addedProjectForm({ reloadImpl: () => new Promise(resolve => (release = resolve)) });
    const reload = must(root.querySelector('[data-add-mcp-reload]'), 'reload button') as HTMLButtonElement;
    await click(reload);
    expect(reload.textContent).toContain('Reloading…');
    expect(reload.disabled).toBe(true);
    await interact(() => release?.());
    await settleUntil(() => !reload.disabled, 'the reload to settle', interact);
  });

  it('shows the daemon’s refusal and stays open when the reload fails', async () => {
    const { root, closes } = await addedProjectForm({
      reloadImpl: async () => Promise.reject(new Error('the pane is busy')),
    });
    await click(must(root.querySelector('[data-add-mcp-reload]'), 'reload button'));
    await settleUntil(() => root.textContent?.includes('the pane is busy') === true, 'the failure', interact);
    expect(closes).toEqual([]);
  });

  it('offers to also reload the other ferrets on a login with more than one, and reloads both on request', async () => {
    const { root, calls, closes } = await addedLoginForm({
      previewImpl: async () => loginPreview({ ferrets: 3 }),
      reloadOthersImpl: async () => undefined,
    });
    const checkbox = must(
      root.querySelector('.fy-action-form__check input'),
      'reload all checkbox',
    ) as HTMLInputElement;
    expect(root.textContent).toContain('reload the other 2 ferrets on this login now');
    await click(checkbox);
    const reload = must(root.querySelector('[data-add-mcp-reload]'), 'reload button') as HTMLButtonElement;
    await click(reload);
    await settleUntil(() => closes.length > 0, 'the reload (and reloadOthers) to finish', interact);
    expect(calls.some(call => call.kind === 'reloadOthers')).toBe(true);
    expect(closes).toEqual([1]);
  });

  it('never offers to reload others for a project add, for a lone ferret, or without the port', async () => {
    const lone = await addedLoginForm({
      previewImpl: async () => loginPreview({ ferrets: 1 }),
      reloadOthersImpl: async () => undefined,
    });
    expect(lone.root.querySelector('.fy-action-form__check')).toBeNull();

    const noPort = await addedLoginForm({ previewImpl: async () => loginPreview({ ferrets: 3 }) });
    expect(noPort.root.querySelector('.fy-action-form__check')).toBeNull();

    const project = await addedProjectForm();
    expect(project.root.querySelector('.fy-action-form__check')).toBeNull();
  });
});

describe('AddMcpForm — signing an added server in', () => {
  const SIGN_IN_CONNECTION = daemonConnection({
    daemonId: 'studio',
    baseUrl: 'https://studio.example.test',
    deviceId: 't',
  });
  // A week from the real "now": a fixed instant expired at midnight and failed this test, and a week
  // keeps the expiry timer's duration a plain 32-bit number (setTimeout overflows past ~24.8 days).
  const FAR_FUTURE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const addedLoginUrlServer = async (signIn: ContextMcpSignInHost | undefined, oauthChecked = true) => {
    const result = await openForm({
      previewImpl: async () => loginPreview(),
      addImpl: async () => LOGIN_ADDED,
      signIn,
    });
    await click(scopeRadio(result.root, 'login'));
    await click(typeRadio(result.root, 'url'));
    await type(nameInput(result.root), 'sentry');
    await type(urlInput(result.root), 'https://mcp.sentry.dev/mcp');
    if (oauthChecked) {
      const oauth = must(
        [...result.root.querySelectorAll('input[type="checkbox"]')].find(input =>
          input.closest('label')?.textContent?.includes('Sign in through Ferretry'),
        ),
        'oauth checkbox',
      ) as HTMLInputElement;
      await click(oauth);
    }
    await waitForPreview(result.root);
    await submitForm(result.root);
    await settleUntil(() => result.root.querySelector('[data-add-mcp-added]') !== null, 'the added step', interact);
    return result;
  };

  it('offers no sign-in block for a command server, or without oauth checked, or without a sign-in port', async () => {
    const command = await addedProjectForm();
    expect(command.root.querySelector('[data-add-mcp-sign-in]')).toBeNull();

    const noOauth = await addedLoginUrlServer(
      { connection: SIGN_IN_CONNECTION, createClient: factoryFor({}), machineName: 'studio-mac' },
      false,
    );
    expect(noOauth.root.querySelector('[data-add-mcp-sign-in]')).toBeNull();

    const noPort = await addedLoginUrlServer(undefined);
    expect(noPort.root.querySelector('[data-add-mcp-sign-in]')).toBeNull();
  });

  it('shows "Opening sign-in…" while the sign-in start is in flight, then the sheet once it answers', async () => {
    let release: ((value: unknown) => void) | undefined;
    const flow = mcpFlow({ component: 'sentry', flowId: 'flow-busy', expiresAt: FAR_FUTURE });
    const signIn: ContextMcpSignInHost = {
      connection: SIGN_IN_CONNECTION,
      createClient: factoryFor({
        [`POST ${MCP_OAUTH_PATH}/sentry`]: () => new Promise(resolve => (release = resolve)),
      }),
      machineName: 'studio-mac',
      channel: fakeChannels().factory,
    };
    const { root } = await addedLoginUrlServer(signIn);
    const signInButton = must(root.querySelector('[data-add-mcp-sign-in]'), 'sign-in button') as HTMLButtonElement;
    await click(signInButton);
    expect(signInButton.textContent).toContain('Opening sign-in…');
    expect(signInButton.disabled).toBe(true);
    await interact(() => release?.(flow));
    await settleUntil(() => root.querySelector('[role="dialog"]') !== null, 'the sign-in sheet to open', interact);
  });

  it('signs the server in end to end, through the channel, then hides the Sign in button', async () => {
    const flow = mcpFlow({ component: 'sentry', flowId: 'flow-ok', expiresAt: FAR_FUTURE });
    const { factory, opened } = fakeChannels();
    const signIn: ContextMcpSignInHost = {
      connection: SIGN_IN_CONNECTION,
      createClient: factoryFor({
        [`POST ${MCP_OAUTH_PATH}/sentry`]: flow,
        [`POST ${MCP_OAUTH_PATH}/flows/flow-ok`]: completion(mcpConnection({ component: 'sentry' })),
      }),
      machineName: 'studio-mac',
      channel: factory,
    };
    const { root } = await addedLoginUrlServer(signIn);
    await click(must(root.querySelector('[data-add-mcp-sign-in]'), 'sign-in button'));
    expect(root.textContent).toContain('This server signs in through Ferretry.');

    await interact(() => opened[0]?.deliver({ type: 'callback', id: 'hand-over', href: CALLBACK }));
    await settleUntil(
      () => root.textContent?.includes('Signed in; the token is in the secret store.') === true,
      'the sign-in to finish',
      interact,
    );
    expect(root.querySelector('[data-add-mcp-sign-in]')).toBeNull();
  });

  it('shows the machine’s refusal when starting the sign-in fails', async () => {
    const signIn: ContextMcpSignInHost = {
      connection: SIGN_IN_CONNECTION,
      createClient: async () => {
        throw new Error('offline');
      },
      machineName: 'studio-mac',
    };
    const { root } = await addedLoginUrlServer(signIn);
    await click(must(root.querySelector('[data-add-mcp-sign-in]'), 'sign-in button'));
    await settleUntil(() => root.textContent?.includes('didn’t answer') === true, 'the refusal', interact);
  });
});
