/**
 * mcp#0 / mcp#1 — Add MCP server: the form, its preview, the add, the reload and the sign-in, driven as the dialog mounts
 * it, over a scripted client.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { type Mounted, must } from '@ferretry/app/testing';
import { AddMcpForm } from '../../../app/views/add-mcp-form.tsx';
import { mcpFlow, scriptedClient, type Call, type Answers } from './mcp-fixtures.ts';
import { click, mountSettled, settle, text, type } from './mcp-view-support.tsx';

const LISTING = 'GET /v1/ferrets/:ferretId/mcp';
const PREVIEW_PROJECT = 'POST /v1/ferrets/:ferretId/mcp/project/preview';
const PREVIEW_LOGIN = 'POST /v1/ferrets/:ferretId/mcp/login/preview';
const ADD_PROJECT = 'POST /v1/ferrets/:ferretId/mcp/project';
const ADD_LOGIN = 'POST /v1/ferrets/:ferretId/mcp/login';
const RESTART = 'POST /v1/restarts';
const START = 'POST /v1/mcp/auth/:component';
const ETAG = 'a'.repeat(64);

const listing = { project: { path: '/w/.mcp.json', etag: null, servers: [] } };
const projectPreview = (over = {}) => ({
  scope: 'project',
  path: '.mcp.json',
  etag: ETAG,
  replaces: false,
  diff: [
    { kind: 'context', text: '{' },
    { kind: 'add', text: '"sentry": {}' },
    { kind: 'remove', text: '"old": {}' },
  ],
  ...over,
});
const loginPreview = (over = {}) => ({
  scope: 'login',
  runtime: 'marin',
  profile: 'default',
  replaces: false,
  ferrets: 1,
  ...over,
});
const projectAdded = { scope: 'project', name: 'sentry', path: '/w/.mcp.json', etag: ETAG };
const loginAdded = { scope: 'login', name: 'sentry', runtime: 'marin', profile: 'default' };

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const wait = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms));
  await settle();
};

const open = async (answers: Answers, over: Record<string, unknown> = {}) => {
  const calls: Call[] = [];
  const closed: string[] = [];
  const client = scriptedClient({ [LISTING]: listing, ...answers }, calls);
  mounted = await mountSettled(
    <AddMcpForm
      agentName="Marin"
      client={client}
      ferretId="f1"
      host={{ close: () => closed.push('closed') }}
      origin="https://pwa.example.test"
      previewDebounceMs={0}
      {...over}
    />,
  );
  return { root: mounted.container, calls, closed };
};

const fillCommand = async (root: HTMLElement, name = 'sentry'): Promise<void> => {
  await type(root, 'input[placeholder="sentry"]', name);
  await type(root, 'input[placeholder="npx -y @sentry/mcp-server"]', 'npx -y @sentry/mcp-server');
  await wait(5);
};
const submit = async (root: HTMLElement): Promise<void> => click(root, '[data-action-submit]');

describe('mcp#0 Add MCP server — project scope', () => {
  it('previews the repo change as a diff, adds with the previewed etag, then reloads this ferret', async () => {
    const { root, calls, closed } = await open({
      [PREVIEW_PROJECT]: projectPreview({ etag: null }),
      [ADD_PROJECT]: projectAdded,
      [RESTART]: { restarted: [{ id: 'f1' }], queued: [], skipped: [], failed: [] },
    });
    expect(calls[0]).toEqual({ route: LISTING, params: { ferretId: 'f1' }, body: undefined });
    expect(root.textContent).toContain('Writes .mcp.json in w;');
    await fillCommand(root);
    expect(text(root, '[data-add-mcp-preview="project"]')).toContain('new file');
    expect([...root.querySelectorAll('.fy-diff__line')].map(line => line.textContent)).toEqual([
      '  {',
      '+ "sentry": {}',
      '- "old": {}',
    ]);
    await submit(root);
    expect(calls.find(call => call.route === ADD_PROJECT)?.body).toEqual({
      name: 'sentry',
      server: { transport: 'command', command: 'npx', args: ['-y', '@sentry/mcp-server'], env: {} },
      etag: null,
    });
    expect(text(root, '[data-add-mcp-added="project"]')).toContain('/w/.mcp.json');
    expect(root.textContent).toContain('Marin picks it up after a reload');
    expect(root.textContent).toContain('Claude Code asks once to trust');
    await click(root, '[data-add-mcp-reload]');
    expect(calls.find(call => call.route === RESTART)?.body).toEqual({ scope: 'ids', ids: ['f1'] });
    expect(calls.find(call => call.route === RESTART)?.headers?.['x-fy-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(closed).toEqual(['closed']);
  });

  it('says whether the preview replaces a server or adds one', async () => {
    const { root } = await open({ [PREVIEW_PROJECT]: projectPreview({ replaces: true }) });
    await fillCommand(root);
    expect(text(root, '[data-add-mcp-preview="project"]')).toContain('replaces 1 server');
    await type(root, 'input[placeholder="sentry"]', 'other');
    expect(root.querySelector('[data-add-mcp-preview]')).not.toBeNull();
  });

  it('says +1 server for an existing file', async () => {
    const { root } = await open({ [PREVIEW_PROJECT]: projectPreview({ replaces: false, etag: ETAG }) });
    await fillCommand(root);
    expect(text(root, '[data-add-mcp-preview="project"]')).toContain('+1 server');
  });

  it('shows the person’s mistake as they type, and a failed preview in the daemon’s words', async () => {
    const { root } = await open({
      [PREVIEW_PROJECT]: new Error('boom'),
    });
    await type(root, 'input[placeholder="sentry"]', '-bad');
    expect(text(root, '[data-add-mcp-refusal]')).toContain('Name: use letters');
    await fillCommand(root, 'sentry');
    expect(root.querySelector('[data-add-mcp-refusal]')).toBeNull();
    expect(text(root, '[data-add-mcp-preview-failed]')).toContain('This machine didn’t answer');
    expect(root.querySelector<HTMLButtonElement>('[data-action-submit]')?.disabled).toBe(true);
  });

  it('shows a refused add and stays on the form', async () => {
    const { root } = await open({ [PREVIEW_PROJECT]: projectPreview(), [ADD_PROJECT]: new Error('nope') });
    await fillCommand(root);
    await submit(root);
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('This machine didn’t answer');
    expect(root.querySelector('[data-add-mcp-added]')).toBeNull();
  });

  it('does nothing when submitted without a fresh preview', async () => {
    const { root, calls } = await open({ [PREVIEW_PROJECT]: projectPreview() });
    const form = must(root.querySelector('form'), 'form');
    await settle();
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    expect(calls.some(call => call.route === ADD_PROJECT)).toBe(false);
  });

  it('shows a url server and the project sign-in note', async () => {
    const { root } = await open({});
    await click(root, '.fy-segmented__option input[value="url"]');
    expect(root.textContent).toContain('sign in from Info › Context › MCP once it is added');
    await type(root, 'input[placeholder="https://mcp.sentry.dev/mcp"]', 'https://mcp.example.test/mcp');
    await click(root, '.fy-segmented__option input[value="command"]');
    expect(root.querySelector('textarea')?.getAttribute('placeholder')).toContain('SENTRY_TOKEN=$' + '{SENTRY_TOKEN}');
  });
});

describe('mcp#0 Add MCP server — login scope', () => {
  it('goes to the login when the project cannot be written, and says why', async () => {
    const { root } = await open(
      {
        [LISTING]: { project: null, projectUnavailable: 'This ferret has no git project.' },
        [PREVIEW_LOGIN]: loginPreview({ ferrets: 3, replaces: true }),
        [ADD_LOGIN]: loginAdded,
      },
      { login: 'marin' },
    );
    expect(text(root, '[data-choice="project"]')).toContain('This ferret has no git project.');
    expect(root.querySelector<HTMLInputElement>('[data-choice="project"] input')?.disabled).toBe(true);
    expect(text(root, '[data-choice="login"]')).toContain('marin');
    expect(root.textContent).toContain('secret:NAME');
    await fillCommand(root);
    expect(text(root, '[data-add-mcp-preview="login"]')).toContain('Replaces the server in profile default');
    expect(text(root, '[data-add-mcp-preview="login"]')).toContain('3 ferrets run on it');
    await submit(root);
    expect(text(root, '[data-add-mcp-added="login"]')).toContain('login marin');
    expect(root.textContent).toContain('Other ferrets on this login get it on their next start.');
    await click(root, '.fy-action-form__foot button:first-child');
  });

  it('reads an unreadable listing as “project unavailable” and still lets the login be chosen', async () => {
    const { root } = await open({ [LISTING]: new Error('down'), [PREVIEW_LOGIN]: loginPreview() });
    expect(text(root, '[data-choice="project"]')).toContain('could not read this ferret’s project');
    await click(root, '[data-choice="login"] input');
    await fillCommand(root);
    expect(text(root, '[data-add-mcp-preview="login"]')).toContain('Adds the server');
  });

  it('adds a url server that signs in through Ferretry, then opens the sign-in', async () => {
    const { root, calls } = await open({
      [LISTING]: { project: null },
      [PREVIEW_LOGIN]: loginPreview(),
      [ADD_LOGIN]: loginAdded,
      [START]: mcpFlow({ component: 'sentry', expiresAt: new Date(Date.now() + 600_000).toISOString() }),
    });
    await click(root, '.fy-segmented__option input[value="url"]');
    await type(root, 'input[placeholder="sentry"]', 'sentry');
    await type(root, 'input[placeholder="https://mcp.sentry.dev/mcp"]', 'https://mcp.example.test/mcp');
    await click(root, '.fy-action-form__check input');
    await wait(5);
    await submit(root);
    await click(root, '[data-add-mcp-sign-in]');
    expect(calls.find(call => call.route === START)?.params).toEqual({ component: 'sentry' });
    expect(document.body.querySelector('[data-mcp-sign-in="waiting"]')).not.toBeNull();
    await click(document.body, '[data-mcp-sign-in-cancel]');
  });

  it('says why a sign-in could not start and why a reload failed', async () => {
    const { root } = await open({
      [LISTING]: { project: null },
      [PREVIEW_LOGIN]: loginPreview(),
      [ADD_LOGIN]: loginAdded,
      [START]: new Error('no'),
      [RESTART]: new Error('no'),
    });
    await click(root, '.fy-segmented__option input[value="url"]');
    await type(root, 'input[placeholder="sentry"]', 'sentry');
    await type(root, 'input[placeholder="https://mcp.sentry.dev/mcp"]', 'https://mcp.example.test/mcp');
    await click(root, '.fy-action-form__check input');
    await wait(5);
    await submit(root);
    await click(root, '[data-add-mcp-sign-in]');
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('This machine didn’t answer');
    await click(root, '[data-add-mcp-reload]');
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('This machine didn’t answer');
  });

  it('closes on Later without reloading', async () => {
    const { root, calls, closed } = await open({
      [LISTING]: { project: null },
      [PREVIEW_LOGIN]: loginPreview(),
      [ADD_LOGIN]: loginAdded,
    });
    await fillCommand(root);
    await submit(root);
    await click(root, '.fy-action-form__foot button');
    expect(closed).toEqual(['closed']);
    expect(calls.some(call => call.route === RESTART)).toBe(false);
  });

  it('starts on the login when asked to', async () => {
    const { root } = await open({}, { initialScope: 'login' });
    expect(root.querySelector<HTMLInputElement>('[data-choice="login"] input')?.checked).toBe(true);
  });
});

describe('mcp#0 Add MCP server — scope switching', () => {
  it('goes back to the project after choosing the login, and ignores a listing that fails after the form closed', async () => {
    const { root } = await open({});
    await click(root, '[data-choice="login"] input');
    expect(root.querySelector<HTMLInputElement>('[data-choice="login"] input')?.checked).toBe(true);
    await click(root, '[data-choice="project"] input');
    expect(root.querySelector<HTMLInputElement>('[data-choice="project"] input')?.checked).toBe(true);
    await mounted?.unmount();
    mounted = undefined;

    let fail: (reason: Error) => void = () => undefined;
    const late = new Promise((_resolve, reject) => {
      fail = reject;
    });
    const client = scriptedClient({ [LISTING]: late });
    mounted = await mountSettled(
      <AddMcpForm agentName="Marin" client={client} ferretId="f1" host={{ close: () => undefined }} />,
    );
    await mounted.unmount();
    mounted = undefined;
    fail(new Error('too late'));
    await settle();
  });
});

describe('mcp#1 Reload this ferret says what the restart did', () => {
  const none = { restarted: [], queued: [], skipped: [], failed: [] };

  const added = async (restart: unknown) => {
    const made = await open({
      [PREVIEW_PROJECT]: projectPreview(),
      [ADD_PROJECT]: projectAdded,
      [RESTART]: restart,
    });
    await fillCommand(made.root);
    await submit(made.root);
    await click(made.root, '[data-add-mcp-reload]');
    return made;
  };

  it('a restart nobody reported is not a success: the dialog stays open and says so', async () => {
    const { root, closed } = await added(none);
    expect(closed).toEqual([]);
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('did not say whether Marin reloaded');
  });

  it('a queued restart says it reloads at its next idle moment, and does not close or offer a second reload', async () => {
    const { root, closed } = await added({ ...none, queued: [{ id: 'f1', reason: 'mid-turn' }] });
    expect(closed).toEqual([]);
    expect(text(root, '[data-add-mcp-queued]')).toBe(
      'Marin reloads at its next idle moment (it is working on a turn).',
    );
    expect(root.querySelector('[data-add-mcp-reload]')).toBeNull();
    await click(root, '.fy-action-form__foot button');
    expect(closed).toEqual(['closed']);
  });

  it('a skipped restart is a failure in words, and the dialog stays open', async () => {
    const { root, closed } = await added({ ...none, skipped: [{ id: 'f1', reason: 'not-running' }] });
    expect(closed).toEqual([]);
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('Marin was not reloaded: it is not running.');
    expect(root.querySelector('[data-add-mcp-reload]')).not.toBeNull();
  });

  it('a failed restart is a failure with the daemon’s reason, and the dialog stays open', async () => {
    const { root, closed } = await added({ ...none, failed: [{ id: 'f1', reason: 'the pane did not answer' }] });
    expect(closed).toEqual([]);
    expect(root.querySelector('[role="alert"]')?.textContent).toContain(
      'Marin could not be reloaded: the pane did not answer',
    );
  });
});
