/**
 * `ContextRailBody` and its MCP sub-tab (`ContextMcpPanel`), driven directly as Info › Context draws
 * them — there is no `ContextRail` wrapper left (deleted with the desktop rail chrome), so this is the
 * only place these two render at all. Also covers `useContextRead` (`context-rail-parts.tsx`), the
 * lazy read every sub-tab shares.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import {
  MCP_OAUTH_PATH,
  type McpCheckResult,
  type McpInventory,
  McpInventorySchema,
  type SessionSkillsInventory,
  SessionSkillsInventorySchema,
} from '@ferretry/protocol';
import { FyApiClient, FyHttpError } from '@ferretry/protocol/client';
import {
  ContextRailBody,
  type ContextRailBodyProps,
} from '../../../../src/features/context-rail/context-rail-body.tsx';
import type { ContextDoc } from '../../../../src/features/context-rail/context-rail-model.ts';
import { loadFailureReason, useContextRead } from '../../../../src/features/context-rail/context-rail-parts.tsx';
import {
  type ContextLoader,
  sessionMcpLoader,
  sessionSkillsInventoryLoader,
  skillFileLoader,
} from '../../../../src/features/context-rail/context-rail-ports.ts';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { fakeClient } from '../../../support/catalog-client.ts';
import { installRecord, ownedCatalog } from '../../../support/catalog-views.ts';
import { interact, type Mounted, must } from '../../../support/dom.ts';
import { click, mountSettled, settle, text, type } from '../fleet/components/view-support.tsx';
import {
  type Answers,
  CALLBACK,
  type Call,
  completion,
  factoryFor,
  fakeChannels,
  mcpFlow,
} from '../fleet/mcp-sign-in-support.ts';
import { DOCS, MCP, NOW, SKILLS, skill } from './context-rail-fixtures.ts';

const STUDIO = daemonConnection({ daemonId: 'studio', baseUrl: 'https://studio.example.test', deviceId: 't' });

/** A loader that counts its reads and answers what the test says, settable between reads. */
const counted = <T,>(answer: () => Promise<T>) => {
  const loader = Object.assign(
    async (_signal: AbortSignal) => {
      loader.calls += 1;
      return await answer();
    },
    { calls: 0 },
  );
  return loader;
};

const never =
  <T,>(): ContextLoader<T> =>
  () =>
    new Promise<T>(() => undefined);

interface Harness {
  readonly root: HTMLElement;
  readonly inserted: string[];
  readonly opened: string[];
  readonly tabs: string[];
}

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const body = async (overrides: Partial<ContextRailBodyProps> = {}): Promise<Harness> => {
  const inserted: string[] = [];
  const opened: string[] = [];
  const tabs: string[] = [];
  mounted = await mountSettled(
    <ContextRailBody
      sessionId="session-a"
      machineName="studio-mac"
      loadMcp={async () => MCP}
      loadSkills={async () => SKILLS}
      loadDocs={async () => DOCS}
      onInsertSkill={invocation => inserted.push(invocation)}
      onOpenFile={path => opened.push(path)}
      onTabChange={tab => tabs.push(tab)}
      now={() => NOW}
      searchDebounceMs={0}
      {...overrides}
    />,
  );
  return { root: mounted.container, inserted, opened, tabs };
};

const tab = async (root: HTMLElement, label: string): Promise<void> => {
  const button = must(
    [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(entry => entry.textContent?.startsWith(label)),
    `the ${label} tab`,
  );
  await click(root, `#${CSS.escape(button.id)}`);
};

const rows = (root: HTMLElement, attribute: string): string[] =>
  [...root.querySelectorAll(`[${attribute}]`)].map(row => row.getAttribute(attribute) ?? '');

/** Opens a skill's SKILL.md the way a person does: its ⋯, then Open. */
const openSkillFile = async (root: HTMLElement, name: string): Promise<void> => {
  await click(root, `[data-catalog-item-row="${name}"] [data-row-more]`);
  const item = must(
    [...root.ownerDocument.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      entry => entry.textContent === 'Open SKILL.md',
    ),
    'the Open SKILL.md item',
  );
  await interact(() => item.click());
  await settle();
};

const search = (root: HTMLElement, value: string) => type(root, '[data-side-pane-search] input', value);

describe('ContextRailBody — MCP', () => {
  const NOTION_SUBJECT = 'notion..a1b2c3d4e5f6';
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
  const host = (answers: Answers, calls: Call[] = [], channel = fakeChannels()) => ({
    connection: STUDIO,
    createClient: factoryFor(answers, calls),
    machineName: 'studio-mac',
    origin: 'https://ferretry.pages.dev',
    channel: channel.factory,
  });

  it('reads only once the tab is shown, then lists every server by scope with where it stands', async () => {
    const loadMcp = counted(async () => MCP);
    const { root, tabs } = await body({ loadMcp, tabs: ['skills', 'mcp'] });
    expect(loadMcp.calls).toBe(0);

    await tab(root, 'MCP');
    expect(tabs).toEqual(['mcp']);
    expect(loadMcp.calls).toBe(1);
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

    await click(root, '[data-context-chip="attention"]');
    expect(rows(root, 'data-context-mcp')).toEqual(['lint']);

    // Moving away and back keeps the answer and the chosen chip, and does not read again.
    await tab(root, 'Skills');
    await tab(root, 'MCP');
    expect(loadMcp.calls).toBe(1);
    expect(rows(root, 'data-context-mcp')).toEqual(['lint']);
  });

  it('offers no act without a host: every row says where it stands and Check is off', async () => {
    const { root } = await body({ tab: 'mcp' });
    const check = must(root.querySelector<HTMLButtonElement>('[data-mcp-check="notion"]'), 'Check');
    expect(check.disabled).toBe(true);
  });

  it('checks a server as this ferret reaches it, and lists the tools it answered with', async () => {
    const calls: Call[] = [];
    const { root } = await body({
      tab: 'mcp',
      mcpSignIn: host({ 'POST /v1/mcp/check': checked() }, calls),
    });

    await click(root, '[data-mcp-check="notion"]');
    expect(calls).toEqual([
      { path: '/v1/mcp/check', method: 'POST', body: { id: 'id-notion-project', sessionId: 'session-a' } },
    ]);
    expect(text(root, '[data-mcp-row="notion"] [data-mcp-status]')).toBe('Connected · 2 tools');
    expect(text(root, '[data-mcp-row="notion"] [data-mcp-tools]')).toBe('search · read');
  });

  it('says a failed check in plain words, with the transport’s text behind Details', async () => {
    const { root } = await body({
      tab: 'mcp',
      mcpSignIn: host({ 'POST /v1/mcp/check': new Error('could not reach fyd at 127.0.0.1:7777 (ECONNREFUSED)') }),
    });

    await click(root, '[data-mcp-check="github"]');
    expect(text(root, '[data-mcp-row="github"] [data-mcp-failure="check"] .text-err')).toBe(
      'studio-mac isn’t reachable right now',
    );
    expect(text(root, '[data-mcp-row="github"] [data-mcp-failure-details]')).toBe(
      'could not reach fyd at 127.0.0.1:7777 (ECONNREFUSED)',
    );
  });

  it('signs a project server in under its project subject once a check says it asks, and reads again', async () => {
    const answers: Answers = {
      'POST /v1/mcp/check': checked({ outcome: 'needs-sign-in', message: 'It asks for a sign-in.', tools: [] }),
      [`POST ${MCP_OAUTH_PATH}/${NOTION_SUBJECT}`]: new FyHttpError(
        'Unlock this device first.',
        403,
        'grant_step_up_required',
      ),
    };
    const channels = fakeChannels();
    const loadMcp = counted(async () => MCP);
    const { root } = await body({ loadMcp, tab: 'mcp', mcpSignIn: host(answers, [], channels) });
    expect(root.querySelector('[data-mcp-sign-in="notion"]')).toBeNull();

    await click(root, '[data-mcp-check="notion"]');
    expect(text(root, '[data-mcp-row="notion"] [data-mcp-status]')).toBe('Needs sign-in');
    await click(root, '[data-mcp-sign-in="notion"]');
    expect(text(root, '[data-mcp-row="notion"] [data-mcp-failure="sign-in"]')).toBe('Unlock this device first.');
    expect(document.body.querySelector('[data-mcp-sign-in-state]')).toBeNull();

    // The provider, not this machine, is unreachable: the machine answered, so it is never "isn't reachable".
    const unreachable =
      'Ferretry’s daemon couldn’t reach auth.example.com to register Ferretry — no answer came back (network error: ENOTFOUND).';
    answers[`POST ${MCP_OAUTH_PATH}/${NOTION_SUBJECT}`] = new FyHttpError(unreachable, 409, 'mcp_auth_registration');
    await click(root, '[data-mcp-sign-in="notion"]');
    expect(text(root, '[data-mcp-row="notion"] [data-mcp-failure="sign-in"] .text-err')).toBe(
      'Couldn’t start signing in to notion',
    );
    expect(text(root, '[data-mcp-row="notion"] [data-mcp-failure-details]')).toBe(unreachable);

    answers[`POST ${MCP_OAUTH_PATH}/${NOTION_SUBJECT}`] = mcpFlow({ component: NOTION_SUBJECT });
    answers[`POST ${MCP_OAUTH_PATH}/flows/mcp-flow-one`] = completion();
    await click(root, '[data-mcp-sign-in="notion"]');
    expect(root.querySelector('[data-mcp-failure="sign-in"]')).toBeNull();
    expect(document.body.querySelector('[data-mcp-sign-in="waiting"]')).not.toBeNull();

    channels.opened[0]?.deliver({ type: 'callback', id: 'hand-over', href: CALLBACK });
    await settle();
    expect(loadMcp.calls).toBe(2);
    // The check that said "needs sign-in" is stale now.
    expect(text(root, '[data-mcp-row="notion"] [data-mcp-status]')).toBe('Not checked yet');
    await click(document.body, '[data-mcp-sign-in-done]');
    expect(document.body.querySelector('[data-mcp-sign-in="waiting"]')).toBeNull();
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
    const { root } = await body({
      tab: 'mcp',
      loadMcp: async () => codex,
      mcpSignIn: host({ 'POST /v1/mcp/check': checked({ outcome: 'needs-sign-in', tools: [] }) }),
    });
    await click(root, '[data-mcp-check="notion"]');
    expect(root.querySelector('[data-mcp-sign-in="notion"]')).toBeNull();
    expect(text(root, '[data-mcp-sign-in-unsupported]')).toContain('Codex reads');
  });

  it('offers Add…, says how many servers it sees and any file it could not read', async () => {
    const added: boolean[] = [];
    const withProblem = McpInventorySchema.parse({
      ...MCP,
      problems: [{ source: '/work/app/.mcp.json', message: '/work/app/.mcp.json is not valid JSON.' }],
    });
    const { root } = await body({ tab: 'mcp', onAddMcp: () => added.push(true), loadMcp: async () => withProblem });
    expect(root.textContent).toContain('6 servers this ferret sees');
    expect(text(root, '[data-context-mcp-problem]')).toBe('/work/app/.mcp.json is not valid JSON.');
    await click(root, '[data-context-mcp-add]');
    expect(added).toEqual([true]);
  });

  it('says it is reading, reports a failed read in plain words and retries it', async () => {
    let fail = true;
    const loadMcp = counted(async (): Promise<McpInventory> => {
      if (fail) throw new Error('the machine is offline');
      return { servers: [], problems: [] };
    });
    const { root } = await body({ loadMcp, tab: 'mcp' });
    expect(root.querySelector('[data-context-failed] p')?.textContent).toBe('studio-mac isn’t reachable right now');
    expect(text(root, '[data-context-failed-details]')).toContain('the machine is offline');

    fail = false;
    await click(root, '[data-context-retry]');
    expect(text(root, '[data-context-note]')).toBe('This agent has no MCP servers.');

    await mounted?.unmount();
    mounted = undefined;
    const pending = await body({ loadMcp: never(), tab: 'mcp' });
    expect(text(pending.root, '[data-context-note]')).toBe('Reading MCP servers…');
  });
});

describe('ContextRailBody — Skills', () => {
  it('lists every skill this ferret sees by scope, the winners first, and says which ones are overridden', async () => {
    const { root, inserted } = await body({ tab: 'skills' });
    expect(rows(root, 'data-row-use')).toEqual(['summary', 'floop', 'babysit-pr', 'summary']);
    expect(rows(root, 'data-context-skill-scope')).toEqual(['project', 'user', 'ferretry', 'user']);
    expect(rows(root, 'data-context-chip')).toEqual(['all', 'project', 'user', 'ferretry']);
    expect(text(root, '[data-row-note]')).toBe('Not active: the skill of the same name in This project wins');
    expect(root.textContent).toContain('Claude · inserts /name');

    await click(root, '[data-row-use="floop"]');
    expect(inserted).toEqual(['/floop']);

    await click(root, '[data-context-chip="user"]');
    expect(rows(root, 'data-row-use')).toEqual(['floop', 'summary']);
    await search(root, 'green');
    expect(text(root, '[data-context-note]')).toBe('Nothing under This account matches “green”.');
  });

  it('opens a skill’s SKILL.md and shows it as the document it is', async () => {
    const read: string[] = [];
    const loadSkillFile = async (path: string) => {
      read.push(path);
      return { path, content: '---\nname: floop\ndescription: Review.\n---\n# Summary\n\nSay what happened.' };
    };
    const { root } = await body({ tab: 'skills', loadSkillFile });
    await openSkillFile(root, 'floop');
    expect(read).toEqual(['/fy/fleet/homes/claude-work/skills/floop/SKILL.md']);
    const sheet = must(document.body.querySelector('[data-context-skill-file="floop"]'), 'the sheet');
    expect(sheet.querySelector('h1')?.textContent).toBe('Summary');
    // The front matter is shown as the lines it is, never as a heading.
    expect(sheet.querySelector('[data-context-skill-front-matter]')?.textContent).toBe(
      'name: floop\ndescription: Review.',
    );
    expect(sheet.textContent).toContain('Say what happened.');
  });

  it('says a SKILL.md it could not open in plain words', async () => {
    const { root } = await body({
      tab: 'skills',
      loadSkillFile: async () => {
        throw new Error('no listed skill has that path');
      },
    });
    await openSkillFile(root, 'floop');
    expect(document.body.querySelector('[data-context-skill-file] [data-context-failed] p')?.textContent).toBe(
      'Couldn’t open floop’s SKILL.md',
    );
  });

  it('spells a Codex skill $name, and offers only the scopes it has', async () => {
    const codex = SessionSkillsInventorySchema.parse({
      sessionId: 'session-a',
      harness: 'codex',
      truncated: true,
      skills: [skill({ name: 'deploy', harness: 'codex' })],
    });
    const { root, inserted } = await body({ tab: 'skills', loadSkills: async () => codex });
    expect(rows(root, 'data-context-chip')).toEqual(['all', 'user']);
    expect(root.textContent).toContain('the list was cut short');
    expect(root.querySelector('[data-row-more]')).toBeNull();
    await click(root, '[data-row-use="deploy"]');
    expect(inserted).toEqual(['$deploy']);
  });

  it('reports a failed read, and an empty list', async () => {
    let fail = true;
    const loadSkills = async (): Promise<SessionSkillsInventory> => {
      if (fail) throw new Error('');
      return { sessionId: 'session-a', harness: 'claude', skills: [], truncated: false };
    };
    const { root } = await body({ tab: 'skills', loadSkills });
    expect(root.querySelector('[data-context-failed] p')?.textContent).toBe('studio-mac isn’t answering right now');
    fail = false;
    await click(root, '[data-context-retry]');
    expect(text(root, '[data-context-note]')).toBe('No skills are installed for this agent.');
  });

  it('says it is reading', async () => {
    const { root } = await body({ tab: 'skills', loadSkills: never() });
    expect(text(root, '[data-context-note]')).toBe('Reading skills…');
  });
});

describe('ContextRailBody — Instructions', () => {
  it('opens an instruction file in a Files tab and filters by harness and search', async () => {
    const { root, opened } = await body({ tab: 'docs' });
    expect(rows(root, 'data-context-doc')).toEqual(['CLAUDE.md', 'AGENTS.md']);
    expect(text(root, '[data-context-doc="CLAUDE.md"]')).toContain('13 KB · opens in a Files tab');

    await click(root, '[data-context-doc="AGENTS.md"]');
    expect(opened).toEqual(['AGENTS.md']);

    await click(root, '[data-context-chip="claude"]');
    expect(rows(root, 'data-context-doc')).toEqual(['CLAUDE.md']);
    await search(root, 'agents');
    expect(text(root, '[data-context-note]')).toBe('Nothing under Claude matches “agents”.');
  });

  it('shows a file the listing gave no size for, and an empty folder', async () => {
    const unsized: readonly ContextDoc[] = [{ path: 'AGENTS.md', name: 'AGENTS.md' }];
    const { root } = await body({ tab: 'docs', loadDocs: async () => unsized });
    expect(text(root, '[data-context-doc="AGENTS.md"]')).toBe('AGENTS.mdopens in a Files tab');

    await mounted?.unmount();
    mounted = undefined;
    const empty = await body({ tab: 'docs', loadDocs: async () => [] });
    expect(text(empty.root, '[data-context-note]')).toBe('No instruction files in this folder.');
  });

  it('reports a failed listing and retries it', async () => {
    let fail = true;
    const loadDocs = async (): Promise<readonly ContextDoc[]> => {
      if (fail) throw new Error('This folder is not shared with this device.');
      return DOCS;
    };
    const { root } = await body({ tab: 'docs', loadDocs });
    expect(text(root, '[data-context-failed]')).toContain('This folder is not shared with this device.');
    fail = false;
    await click(root, '[data-context-retry]');
    expect(rows(root, 'data-context-doc')).toEqual(['CLAUDE.md', 'AGENTS.md']);

    await mounted?.unmount();
    mounted = undefined;
    const pending = await body({ tab: 'docs', loadDocs: never() });
    expect(text(pending.root, '[data-context-note]')).toBe('Reading instructions…');
  });
});

describe('ContextRailBody — tabs, label and Files', () => {
  it('draws Info › Context’s own tab set and label, opening on the first of them', async () => {
    const { root } = await body({ tabs: ['files', 'docs', 'skills', 'mcp'], label: 'Context sections' });
    expect(root.querySelector('[role="tablist"]')?.getAttribute('aria-label')).toBe('Context sections');
    expect([...root.querySelectorAll('[role="tab"]')].map(button => button.textContent)).toEqual([
      'Files',
      'Instructions',
      'Skills',
      'MCP',
    ]);
    expect(root.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Files');
  });

  it('renders the host’s Files body on the Files sub-tab, and nothing when the host gave none', async () => {
    const { root } = await body({ tabs: ['files', 'docs'], tab: 'files', renderFiles: () => <p>a file tree</p> });
    expect(root.textContent).toContain('a file tree');

    await mounted?.unmount();
    mounted = undefined;
    const empty = await body({ tabs: ['files', 'docs'], tab: 'files' });
    expect(empty.root.querySelector('[data-context-panel="files"]')?.textContent).toBe('');
  });
});

describe('useContextRead', () => {
  it('blanks the old rows when the loader is another agent’s', async () => {
    const seen: string[] = [];
    function Probe({ loader }: { readonly loader: ContextLoader<string> }) {
      const { load } = useContextRead(loader, true);
      seen.push(load.kind === 'ready' ? load.value : load.kind);
      return null;
    }
    mounted = await mountSettled(<Probe loader={async () => 'first'} />);
    expect(seen.at(-1)).toBe('first');
    await interact(() => mounted?.render(<Probe loader={never()} />));
    await settle();
    expect(seen.at(-1)).toBe('loading');
  });

  it('says why a read failed', () => {
    expect(loadFailureReason(new Error('gone'))).toBe('gone');
    expect(loadFailureReason('a string')).toBe('The daemon did not answer.');
  });
});

/** A daemon from before 4.82: it answers every unknown route exactly as the real dispatcher does. */
const oldDaemon = async (version: string | undefined) =>
  await FyApiClient.connect({
    baseUrl: STUDIO.baseUrl,
    token: 'placeholder',
    version: '4.86.1',
    requestId: () => 'request-1',
    transport: {
      send: async (url: string) => {
        const { pathname } = new URL(url);
        return new Response(
          JSON.stringify({ error: `no route GET ${pathname}`, code: 'unknown_route', method: 'GET', path: pathname }),
          {
            status: 404,
            headers: { 'content-type': 'application/json', ...(version ? { 'x-fy-version': version } : {}) },
          },
        );
      },
    },
  });

describe('Context › MCP and Skills against a daemon older than the app', () => {
  it('says the machine needs an update to show MCP — not that the read failed', async () => {
    const client = await oldDaemon('4.81.0');
    const { root } = await body({ tab: 'mcp', loadMcp: sessionMcpLoader(STUDIO, async () => client, 'session-a') });
    expect(root.querySelector('[data-context-failed]')).toBeNull();
    expect(root.querySelector('[data-context-outdated]')?.getAttribute('role')).toBe('status');
    expect(root.querySelector('[data-context-outdated] p')?.textContent).toBe(
      'This machine needs an update to show MCP here',
    );
    expect(root.textContent).toContain('studio-mac is running version 4.81.0');
    expect(root.textContent).toContain('run “fy daemon update” (Settings › Machine › About & updates)');
    expect(root.textContent).not.toContain('Couldn’t');
  });

  it('says it for Skills, and for a SKILL.md opened from them, without a version the daemon never stamped', async () => {
    const client = await oldDaemon(undefined);
    const { root } = await body({
      tab: 'skills',
      loadSkills: sessionSkillsInventoryLoader(STUDIO, async () => client, 'session-a'),
    });
    expect(root.querySelector('[data-context-outdated] p')?.textContent).toBe(
      'This machine needs an update to show skills here',
    );
    expect(root.textContent).toContain('studio-mac is running an older version');
  });

  it('says it for a SKILL.md the machine cannot open yet', async () => {
    const client = await oldDaemon('4.81.0');
    const { root } = await body({
      tab: 'skills',
      loadSkillFile: skillFileLoader(STUDIO, async () => client, 'session-a'),
    });
    await openSkillFile(root, 'floop');
    expect(document.body.querySelector('[data-context-skill-file] [data-context-outdated] p')?.textContent).toBe(
      'This machine needs an update to show this SKILL.md here',
    );
  });

  it('reads again when asked, and shows the list once the machine is updated', async () => {
    let updated = false;
    const loadMcp = counted(async (): Promise<McpInventory> => {
      if (!updated) throw new FyHttpError('no route', 404, 'unknown_route', undefined, '4.81.0');
      return MCP;
    });
    const { root } = await body({ tab: 'mcp', loadMcp });
    expect(root.querySelector('[data-context-outdated]')).not.toBeNull();
    updated = true;
    await click(root, '[data-context-retry]');
    expect(root.querySelector('[data-context-outdated]')).toBeNull();
    expect(rows(root, 'data-context-mcp').length).toBeGreaterThan(0);
  });

  it('does not call any other refusal an old machine', async () => {
    const loadMcp = async (): Promise<McpInventory> => {
      throw new FyHttpError('the daemon failed to handle this request', 500, 'internal_error');
    };
    const { root } = await body({ tab: 'mcp', loadMcp });
    expect(root.querySelector('[data-context-outdated]')).toBeNull();
    expect(text(root, '[data-context-failed] p')).toBe('Couldn’t read this ferret’s MCP servers');
    expect(text(root, '[data-context-failed-details]')).toContain('the daemon failed to handle this request');
  });

  it('keeps a file the machine could not read as a line naming it, beside the servers it could', async () => {
    const withProblems = McpInventorySchema.parse({
      ...MCP,
      problems: [
        {
          source: '/Users/me/Documents/pe/.mcp.json',
          message:
            '/Users/me/Documents/pe/.mcp.json cannot be read by the daemon: the operating system refused access (on macOS, that folder may need Full Disk Access for the daemon).',
        },
      ],
    });
    const { root } = await body({ tab: 'mcp', loadMcp: async () => withProblems });
    expect(root.querySelector('[data-context-failed]')).toBeNull();
    expect(text(root, '[data-context-mcp-problem]')).toContain('/Users/me/Documents/pe/.mcp.json cannot be read');
    expect(rows(root, 'data-context-mcp').length).toBeGreaterThan(0);
  });
});

describe('ContextRailBody — catalogs', () => {
  const fake = () =>
    fakeClient({
      'GET /v1/catalog-installs': () => ({
        installs: [installRecord('skill', 'floop'), installRecord('mcp', 'github')],
      }),
      'GET /v1/catalogs': () => ({ catalogs: [ownedCatalog()] }),
    });

  it('lists the active skills with where each came from, publishes only from the ⋯, and has no Share, Add or link', async () => {
    const client = fake();
    const { root } = await body({ tab: 'skills', catalogs: { connection: STUDIO, createClient: client.factory } });
    expect(text(root, '[data-context-skills-active]')).toBe(
      '3 active in this session · Claude · inserts /name · account claude-work',
    );
    const floop = must(root.querySelector('[data-context-skill-scope] [data-catalog-item-row="floop"]'), 'floop row');
    expect(floop.querySelector('[data-row-from]')?.textContent).toContain('from');
    expect(root.querySelectorAll('[data-row-from]')).toHaveLength(1);
    expect(root.querySelector('[data-row-add]')).toBeNull();
    expect(root.querySelector('[data-row-share]')).toBeNull();
    expect(root.querySelector('[data-catalog-add-link]')).toBeNull();
    expect(root.querySelector('[data-catalog-add-entry]')).toBeNull();
    expect(root.querySelector('[data-catalog-link-input]')).toBeNull();
    await click(root, '[data-catalog-item-row="babysit-pr"] [data-row-more]');
    const publish = must(
      [...root.ownerDocument.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        entry => entry.textContent === 'Publish in a catalog…',
      ),
      'the Publish item',
    );
    await interact(() => publish.click());
    await settle();
    expect(root.querySelector('[data-catalog-sheet="add"]')).not.toBeNull();
    expect(client.calls.some(call => call.path === '/v1/catalogs')).toBe(true);
  });

  it('gives every MCP row a ⋯ with Show details, even one in no catalog, and hides them again', async () => {
    const client = fake();
    const { root } = await body({ tab: 'mcp', catalogs: { connection: STUDIO, createClient: client.factory } });
    const servers = rows(root, 'data-context-mcp');
    expect(root.querySelectorAll('[data-row-more]')).toHaveLength(servers.length);
    const menuLabels = (): string[] =>
      [...root.ownerDocument.querySelectorAll('[role="menuitem"]')].map(entry => entry.textContent ?? '');
    const pick = async (name: string, label: string, expected?: string[]): Promise<void> => {
      await click(root, `[data-context-mcp="${name}"] [data-row-more]`);
      if (expected !== undefined) expect(menuLabels()).toEqual(expected);
      const item = must(
        [...root.ownerDocument.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
          entry => entry.textContent === label,
        ),
        `the ${label} item`,
      );
      await interact(() => item.click());
      await settle();
    };
    await pick('scratch', 'Show details', ['Show details', 'Publish in a catalog…']);
    const details = must(root.querySelector('[data-context-mcp="scratch"] [data-mcp-details]'), 'the details');
    expect(details.textContent).toContain('Runs');
    expect(details.textContent).not.toContain('Declared in');
    await pick('notion', 'Show details');
    expect(text(root, '[data-context-mcp="notion"] [data-mcp-details]')).toContain('/work/app/.mcp.json');
    expect(text(root, '[data-context-mcp="notion"] [data-mcp-details]')).toContain('claude-work (approved)');
    await pick('lint', 'Show details');
    expect(text(root, '[data-context-mcp="lint"] [data-mcp-details]')).toContain('waiting for approval');
    await pick('lint', 'Hide details');
    await pick('notion', 'Hide details');
    expect(root.querySelector('[data-context-mcp="linear"] [data-mcp-details]')).toBeNull();
    await pick('scratch', 'Hide details');
    expect(root.querySelector('[data-mcp-details]')).toBeNull();
  });

  it('says where a server came from on the MCP tab, matched by name, with no Share, Add or link', async () => {
    const client = fake();
    const { root } = await body({ tab: 'mcp', catalogs: { connection: STUDIO, createClient: client.factory } });
    expect(root.querySelector('[data-context-mcp="github"] [data-row-from]')).not.toBeNull();
    expect(root.querySelector('[data-context-mcp="linear"] [data-row-from]')).toBeNull();
    expect(root.querySelector('[data-row-add]')).toBeNull();
    expect(root.querySelector('[data-row-share]')).toBeNull();
    expect(root.querySelector('[data-catalog-add-link]')).toBeNull();
    expect(root.querySelector('[data-catalog-add-entry]')).toBeNull();
    expect(root.querySelector('[data-catalog-link-input]')).toBeNull();
  });

  it('shows no catalog tools at all when the host names no machine', async () => {
    const { root } = await body({ tab: 'skills' });
    expect(root.querySelector('[data-row-share]')).toBeNull();
    expect(root.querySelector('[data-row-add]')).toBeNull();
    expect(root.querySelector('[data-catalog-add-entry]')).toBeNull();
    expect(root.querySelector('[data-catalog-add-link]')).toBeNull();
  });
});
