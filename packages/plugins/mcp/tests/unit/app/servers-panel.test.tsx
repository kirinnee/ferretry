/**
 * The `mcp-servers` panel on `ferret.side` (Info › Folder › MCP and the Tools row), driven directly as the shell mounts
 * it: one ferret's servers read through the half's own client, their rows, Check, Sign in and the search.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { DaemonCallError } from '@ferretry/app';
import { type Mounted, must } from '@ferretry/app/testing';
import { type McpCheckResult, type McpInventory, McpInventorySchema } from '../../../contract/index.ts';
import { McpServersPanel } from '../../../app/views/servers-panel.tsx';
import { type Answers, CALLBACK, type Call, completion, MCP, mcpFlow, NOW, scriptedClient } from './mcp-fixtures.ts';
import { click, mountSettled, settle, text, type } from './mcp-view-support.tsx';

const NOTION_SUBJECT = 'notion..a1b2c3d4e5f6';
const SERVERS = 'GET /v1/ferrets/:ferretId/mcp/servers';
const CHECK = 'POST /v1/mcp/check';
const START = 'POST /v1/mcp/auth/:component';
const FINISH = 'POST /v1/mcp/auth/flows/:flowId';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const checked = (overrides: Partial<McpCheckResult> = {}): McpCheckResult => ({
  id: 'id-notion-project',
  name: 'notion',
  transport: 'http',
  outcome: 'connected',
  toolCount: 2,
  tools: ['search', 'read'],
  elapsedMs: 30,
  checkedAt: '2026-10-16T10:00:00.000Z',
  ...overrides,
});

const panel = async (answers: Answers, calls: Call[] = []) => {
  const client = scriptedClient({ [SERVERS]: MCP, ...answers }, calls);
  mounted = await mountSettled(
    <McpServersPanel client={client} ferretId="ferret-a" now={() => NOW} searchDebounceMs={0} />,
  );
  return { root: mounted.container, calls };
};

const rows = (root: HTMLElement, attribute: string): string[] =>
  [...root.querySelectorAll(`[${attribute}]`)].map(row => row.getAttribute(attribute) ?? '');

describe('DOM tests — the mcp-servers panel', () => {
  it('reads this ferret’s servers by route key and lists every one by scope with where it stands', async () => {
    const calls: Call[] = [];
    const { root } = await panel({}, calls);
    expect(calls).toEqual([{ route: SERVERS, params: { ferretId: 'ferret-a' }, body: undefined }]);
    expect(root.textContent).toContain('6 servers this ferret sees');
    expect(rows(root, 'data-context-mcp')).toEqual(['ferretry', 'scratch', 'lint', 'notion', 'github', 'linear']);
    expect(rows(root, 'data-mcp-scope')).toEqual(['ferretry', 'local', 'project', 'project', 'user', 'component']);
    expect([...root.querySelectorAll('[data-mcp-scope-chip]')].map(chip => chip.textContent)).toEqual([
      'Ferretry',
      'Local',
      'Project',
      'Project',
      'User',
      'Ferretry',
    ]);
    expect(text(root, '[data-mcp-row="ferretry"] [data-mcp-status]')).toBe('Built in');
    expect(text(root, '[data-mcp-row="lint"] [data-mcp-status]')).toBe('Not approved in this project');
    expect(text(root, '[data-mcp-row="lint"] [data-mcp-detail]')).toContain('“New MCP server found”');
    expect(text(root, '[data-mcp-row="linear"] [data-mcp-status]')).toContain('Signed in');
    expect(text(root, '[data-mcp-row="notion"] [data-mcp-status]')).toBe('Not checked yet');
    // Ferretry's own server has nothing to check.
    expect(root.querySelector('[data-mcp-check="ferretry"]')).toBeNull();
  });

  it('narrows by Needs attention and by the search, and keeps the chosen chip', async () => {
    const { root } = await panel({});
    await click(root, '[data-context-chip="attention"]');
    expect(rows(root, 'data-context-mcp')).toEqual(['lint']);
    await click(root, '[data-context-chip="all"]');
    await type(root, '[data-side-pane-search] input', 'linear.example');
    expect(rows(root, 'data-context-mcp')).toEqual(['linear']);
    await type(root, '[data-side-pane-search] input', 'nothing-like-this');
    expect(text(root, '[data-context-note]')).toBe('Nothing under All matches “nothing-like-this”.');
  });

  it('shows what the inventory knows about a server on demand, with the address as the daemon cut it', async () => {
    const { root } = await panel({});
    expect(root.querySelector('[data-mcp-details]')).toBeNull();
    await click(root, '[data-mcp-details-toggle="notion"]');
    const details = text(root, '[data-mcp-details="notion"]');
    expect(details).toContain('https://notion.example/mcp');
    expect(details).toContain('/work/app/.mcp.json');
    expect(details).toContain('claude-work (approved)');
    await click(root, '[data-mcp-details-toggle="notion"]');
    expect(root.querySelector('[data-mcp-details]')).toBeNull();
  });

  it('checks a server as this ferret reaches it, and lists the tools it answered with', async () => {
    const calls: Call[] = [];
    const { root } = await panel({ [CHECK]: checked() }, calls);

    await click(root, '[data-mcp-check="notion"]');
    expect(calls.at(-1)).toEqual({
      route: CHECK,
      params: undefined,
      body: { id: 'id-notion-project', sessionId: 'ferret-a' },
    });
    expect(text(root, '[data-mcp-row="notion"] [data-mcp-status]')).toBe('Connected · 2 tools');
    expect(text(root, '[data-mcp-row="notion"] [data-mcp-tools]')).toBe('search · read');
  });

  it('says a failed check in plain words, with the transport’s text behind Details', async () => {
    const { root } = await panel({
      [CHECK]: new Error('could not reach fyd at 127.0.0.1:7777 (ECONNREFUSED)'),
    });

    await click(root, '[data-mcp-check="github"]');
    expect(text(root, '[data-mcp-row="github"] [data-mcp-failure="check"] .text-err')).toBe(
      'This machine isn’t reachable right now',
    );
    expect(text(root, '[data-mcp-row="github"] [data-mcp-failure-details]')).toBe(
      'could not reach fyd at 127.0.0.1:7777 (ECONNREFUSED)',
    );
  });

  it('signs a project server in under its project subject once a check says it asks, and reads again', async () => {
    const answers: Answers = {
      [SERVERS]: MCP,
      [CHECK]: checked({ outcome: 'needs-sign-in', message: 'It asks for a sign-in.', tools: [] }),
      [START]: new DaemonCallError(403, 'grant_step_up_required', 'Unlock this device first.'),
    };
    const calls: Call[] = [];
    const client = scriptedClient(answers, calls);
    mounted = await mountSettled(
      <McpServersPanel client={client} ferretId="ferret-a" now={() => NOW} searchDebounceMs={0} />,
    );
    const root = mounted.container;
    expect(root.querySelector('[data-mcp-sign-in="notion"]')).toBeNull();

    await click(root, '[data-mcp-check="notion"]');
    expect(text(root, '[data-mcp-row="notion"] [data-mcp-status]')).toBe('Needs sign-in');
    await click(root, '[data-mcp-sign-in="notion"]');
    expect(calls.at(-1)?.params).toEqual({ component: NOTION_SUBJECT });
    expect(text(root, '[data-mcp-row="notion"] [data-mcp-failure="sign-in"]')).toBe('Unlock this device first.');
    expect(document.body.querySelector('[data-mcp-sign-in-state]')).toBeNull();

    // The provider, not this machine, is unreachable: the machine answered, so it is never "isn't reachable".
    const unreachable =
      'Ferretry’s daemon couldn’t reach auth.example.com to register Ferretry — no answer came back (network error: ENOTFOUND).';
    answers[START] = new DaemonCallError(409, 'mcp_auth_registration', unreachable);
    await click(root, '[data-mcp-sign-in="notion"]');
    expect(text(root, '[data-mcp-row="notion"] [data-mcp-failure="sign-in"] .text-err')).toBe(
      'Couldn’t start signing in to notion',
    );
    expect(text(root, '[data-mcp-row="notion"] [data-mcp-failure-details]')).toBe(unreachable);

    answers[START] = mcpFlow({ component: NOTION_SUBJECT });
    answers[FINISH] = completion();
    const readsBefore = calls.filter(call => call.route === SERVERS).length;
    await click(root, '[data-mcp-sign-in="notion"]');
    expect(root.querySelector('[data-mcp-failure="sign-in"]')).toBeNull();
    expect(document.body.querySelector('[data-mcp-sign-in="waiting"]')).not.toBeNull();
    // A sign-in started from a ferret's panel listens on the real channel here; nothing is delivered, so Cancel.
    await click(document.body, '[data-mcp-sign-in-cancel]');
    expect(document.body.querySelector('[data-mcp-sign-in="waiting"]')).toBeNull();
    expect(calls.filter(call => call.route === SERVERS).length).toBe(readsBefore);
  });

  it('says why a Codex project server cannot sign in from here', async () => {
    const codex = McpInventorySchema.parse({
      problems: [],
      servers: [
        {
          ...MCP.servers[3],
          harness: 'codex',
          signIn: {
            subject: NOTION_SUBJECT,
            required: false,
            unsupported: 'Codex reads a project server’s token only from its own config.',
          },
        },
      ],
    });
    const { root } = await panel({
      [SERVERS]: codex,
      [CHECK]: checked({ outcome: 'needs-sign-in', tools: [] }),
    });
    await click(root, '[data-mcp-check="notion"]');
    expect(root.querySelector('[data-mcp-sign-in="notion"]')).toBeNull();
    expect(text(root, '[data-mcp-sign-in-unsupported]')).toContain('Codex reads');
  });

  it('says how many servers it sees and any file it could not read, and offers no Add (Actions owns it)', async () => {
    const withProblem = McpInventorySchema.parse({
      ...MCP,
      problems: [{ source: '/work/app/.mcp.json', message: '/work/app/.mcp.json is not valid JSON.' }],
    });
    const { root } = await panel({ [SERVERS]: withProblem });
    expect(root.textContent).toContain('6 servers this ferret sees');
    expect(text(root, '[data-context-mcp-problem]')).toBe('/work/app/.mcp.json is not valid JSON.');
    expect(root.querySelector('[data-context-mcp-add]')).toBeNull();
  });

  it('reports a failed read in plain words and retries it, then says an empty list is empty', async () => {
    let fail = true;
    const answer = (): McpInventory => {
      if (fail) throw new Error('the machine is offline');
      return { servers: [], problems: [] };
    };
    const { root } = await panel({ [SERVERS]: answer });
    expect(root.querySelector('[data-context-failed] p')?.textContent).toBe('This machine isn’t reachable right now');
    expect(text(root, '[data-context-failed-details]')).toContain('the machine is offline');

    fail = false;
    await click(root, '[data-context-retry]');
    expect(text(root, '[data-context-note]')).toBe('This ferret has no MCP servers.');
  });

  it('says it is reading until the machine answers', async () => {
    const { root } = await panel({ [SERVERS]: () => new Promise(() => undefined) });
    expect(text(root, '[data-context-note]')).toBe('Reading MCP servers…');
  });

  it('S174 never draws a token or a secret value: a signed-in row names a status and nothing it is stored under', async () => {
    const { root } = await panel({});
    const html = root.innerHTML;
    expect(html).not.toContain('MCP_LINEAR');
    expect(html).not.toContain('accessToken');
    expect(html).not.toContain('refreshToken');
    expect(must(root.querySelector('[data-mcp-row="linear"]'), 'the linear row').textContent).toContain('Signed in');
  });
});

describe('DOM tests — the panel after a sign-in lands', () => {
  it('reads the list again and forgets the check that said “needs sign-in”', async () => {
    const answers: Answers = {
      [SERVERS]: MCP,
      [CHECK]: checked({ outcome: 'needs-sign-in', message: 'It asks for a sign-in.', tools: [] }),
      [START]: mcpFlow({ component: NOTION_SUBJECT }),
      [FINISH]: completion(),
    };
    const calls: Call[] = [];
    // The callback is pasted by hand: it ends in the same daemon call as the channel's hand-over, which the sheet suite covers.
    const client = scriptedClient(answers, calls);
    mounted = await mountSettled(
      <McpServersPanel client={client} ferretId="ferret-a" now={() => NOW} searchDebounceMs={0} />,
    );
    const root = mounted.container;
    await click(root, '[data-mcp-check="notion"]');
    await click(root, '[data-mcp-sign-in="notion"]');
    await click(document.body, '[data-mcp-sign-in-paste-disclosure] summary');
    await type(document.body, 'textarea[name="mcp-sign-in-address"]', CALLBACK);
    await click(document.body, '[data-mcp-sign-in-paste] button[type="submit"]');
    await settle();
    expect(calls.filter(call => call.route === SERVERS)).toHaveLength(2);
    expect(text(root, '[data-mcp-row="notion"] [data-mcp-status]')).toBe('Not checked yet');
    await click(document.body, '[data-mcp-sign-in-done]');
    expect(document.body.querySelector('[data-mcp-sign-in]')).toBeNull();
  });
});
