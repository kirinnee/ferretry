import { afterEach, describe, expect, it } from 'bun:test';
import { MCP_OAUTH_PATH } from '@ferretry/protocol';
import { FyHttpError } from '@ferretry/protocol/client';
import {
  ContextRailBody,
  type ContextRailBodyProps,
} from '../../../../src/features/context-rail/context-rail-body.tsx';
import type { ContextDoc, ContextMcpServer } from '../../../../src/features/context-rail/context-rail-model.ts';
import { loadFailureReason, useContextRead } from '../../../../src/features/context-rail/context-rail-parts.tsx';
import type { ContextLoader } from '../../../../src/features/context-rail/context-rail-ports.ts';
import { ContextRail } from '../../../../src/features/context-rail/context-rail.tsx';
import type { SkillsCatalog } from '../../../../src/features/skills/skills-catalog.ts';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import { interact, type Mounted, must } from '../../../support/dom.ts';
import { click, mountSettled, settle, text, type } from '../fleet/components/view-support.tsx';
import { type Answers, CALLBACK, completion, factoryFor, fakeChannels, mcpFlow } from '../fleet/mcp-sign-in-support.ts';
import {
  answeredItem,
  DOCS,
  type FakeSignals,
  fakeSignals,
  MCP,
  NOW,
  openItem,
  SKILLS,
  skill,
  snapshot,
} from './context-rail-fixtures.ts';

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
  readonly signals: FakeSignals;
  readonly inserted: string[];
  readonly opened: string[];
  readonly tabs: string[];
}

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const body = async (
  overrides: Partial<ContextRailBodyProps> = {},
  signals = fakeSignals(snapshot()),
): Promise<Harness> => {
  const inserted: string[] = [];
  const opened: string[] = [];
  const tabs: string[] = [];
  mounted = await mountSettled(
    <ContextRailBody
      agentName="Hadi"
      signals={signals}
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
  return { root: mounted.container, signals, inserted, opened, tabs };
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

const search = (root: HTMLElement, value: string) => type(root, '[data-side-pane-search] input', value);

describe('ContextRailBody — Signals', () => {
  it('opens on Signals with a count badge and lists what is waiting', async () => {
    const { root } = await body();
    expect(root.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe('Signals1');
    expect(text(root, '[data-context-signals-count]')).toBe('1');
    expect(rows(root, 'data-context-signal')).toEqual(['A1']);
    expect(root.textContent).toContain('Use the seeded test account?');
    expect(root.textContent).toContain('Hadi · 2m ago · pick one');
    expect(text(root, '[data-context-chip="open"]')).toBe('Open1');
    expect(text(root, '[data-context-chip="answered"]')).toBe('Answered1');
  });

  it('answers through the attention answer controls and shows a refusal on the item', async () => {
    const { root, signals } = await body();
    const yes = must(
      [...root.querySelectorAll<HTMLButtonElement>('[data-context-signal="A1"] button')].find(button =>
        button.textContent?.includes('Yes'),
      ),
      'the Yes answer',
    );
    signals.failNext = new Error('the daemon refused it');
    await interact(() => yes.click());
    await settle();
    expect(text(root, '[data-context-signal-refusal]')).toBe('Couldn’t send that: the daemon refused it');

    await interact(() => yes.click());
    await settle();
    expect(signals.responses).toEqual([{ id: 'A1', response: { kind: 'multiple-choice', choice: 'Yes' } }]);
    expect(root.querySelector('[data-context-signal-refusal]')).toBeNull();
  });

  it('marks an item with no answer shape done', async () => {
    const signals = fakeSignals(snapshot([openItem({ ask: undefined })], []));
    const { root } = await body({}, signals);
    await click(root, '[data-context-signal-done]');
    expect(signals.resolved).toEqual(['A1']);
  });

  it('shows the answered items with how they ended, filtered by the search', async () => {
    const signals = fakeSignals(
      snapshot([openItem()], [answeredItem(), answeredItem({ id: 'A5', subject: 'Deploy now?', response: undefined })]),
    );
    const { root } = await body({}, signals);
    await click(root, '[data-context-chip="answered"]');
    expect(rows(root, 'data-context-signal')).toEqual(['A2', 'A5']);
    expect(text(root, '[data-context-signal="A2"] [data-context-signal-outcome]')).toBe('Chose “Start over”');

    await search(root, 'deploy');
    expect(rows(root, 'data-context-signal')).toEqual(['A5']);
    expect(text(root, '[data-context-chip="open"]')).toBe('Open0');

    await search(root, 'nothing like it');
    expect(text(root, '[data-context-note]')).toBe('Nothing under Answered matches “nothing like it”.');
  });

  it('stays live: an answer given elsewhere updates the list and the badge', async () => {
    const { root, signals } = await body();
    await interact(() => signals.set('ready', snapshot([], [answeredItem()])));
    expect(root.querySelector('[data-context-signals-count]')).toBeNull();
    expect(text(root, '[data-context-note]')).toBe('Nothing is waiting on you here.');
  });

  it('says it is reading, and offers a retry when the board failed', async () => {
    const signals = fakeSignals(undefined);
    const { root } = await body({}, signals);
    expect(text(root, '[data-context-note]')).toBe('Reading signals…');
    expect(signals.loads).toBe(1);

    signals.failLoad = true;
    await interact(() => signals.set('error'));
    expect(root.querySelector('[data-context-failed]')?.textContent).toContain(
      'Couldn’t read what this agent is waiting on',
    );
    await click(root, '[data-context-retry]');
    expect(signals.loads).toBe(2);
  });
});

describe('ContextRailBody — MCP', () => {
  it('reads only once the tab is shown, then lists every server with its status', async () => {
    const loadMcp = counted(async () => MCP);
    const { root, tabs } = await body({ loadMcp });
    expect(loadMcp.calls).toBe(0);

    await tab(root, 'MCP');
    expect(tabs).toEqual(['mcp']);
    expect(loadMcp.calls).toBe(1);
    expect(rows(root, 'data-context-mcp')).toEqual(['github', 'linear', 'notion']);
    expect(text(root, '[data-context-mcp="github"] [data-context-mcp-status]')).toBe('Runs locally');
    expect(text(root, '[data-context-mcp="linear"] [data-context-mcp-status]')).toContain('Signed in');
    // No sign-in host: the row says where it stands and offers nothing.
    expect(text(root, '[data-context-mcp="notion"] [data-context-mcp-status]')).toBe('Needs sign-in');

    await click(root, '[data-context-chip="needs-sign-in"]');
    expect(rows(root, 'data-context-mcp')).toEqual(['notion']);

    // Moving away and back keeps the answer and the chosen chip, and does not read again.
    await tab(root, 'Signals');
    await tab(root, 'MCP');
    expect(loadMcp.calls).toBe(1);
    expect(rows(root, 'data-context-mcp')).toEqual(['notion']);
  });

  it('signs in with the Components tab’s sheet and reads again once signed in', async () => {
    const answers: Answers = {
      [`POST ${MCP_OAUTH_PATH}/notion`]: new FyHttpError('Unlock this device first.', 403, 'grant_step_up_required'),
    };
    const channels = fakeChannels();
    const loadMcp = counted(async () => MCP);
    const { root } = await body({
      loadMcp,
      tab: 'mcp',
      mcpSignIn: {
        connection: STUDIO,
        createClient: factoryFor(answers),
        machineName: 'studio-mac',
        origin: 'https://ferretry.pages.dev',
        channel: channels.factory,
      },
    });

    await click(root, '[data-context-mcp-sign-in="notion"]');
    expect(text(root, '[data-context-mcp-refusal]')).toBe('Unlock this device first.');
    expect(document.body.querySelector('[data-mcp-sign-in]')).toBeNull();

    answers[`POST ${MCP_OAUTH_PATH}/notion`] = mcpFlow({ component: 'notion' });
    answers[`POST ${MCP_OAUTH_PATH}/flows/mcp-flow-one`] = completion();
    await click(root, '[data-context-mcp-sign-in="notion"]');
    expect(root.querySelector('[data-context-mcp-refusal]')).toBeNull();
    expect(document.body.querySelector('[data-mcp-sign-in="waiting"]')).not.toBeNull();

    channels.opened[0]?.deliver({ type: 'callback', id: 'hand-over', href: CALLBACK });
    await settle();
    expect(loadMcp.calls).toBe(2);
    await click(document.body, '[data-mcp-sign-in-done]');
    expect(document.body.querySelector('[data-mcp-sign-in]')).toBeNull();
  });

  it('says it is reading, reports a failed read and retries it', async () => {
    let fail = true;
    const loadMcp = counted(async (): Promise<readonly ContextMcpServer[]> => {
      if (fail) throw new Error('the machine is offline');
      return [];
    });
    const { root } = await body({ loadMcp, tab: 'mcp' });
    expect(text(root, '[data-context-failed]')).toContain('the machine is offline');

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
  it('inserts a skill in the harness’s own spelling and filters by origin and search', async () => {
    const { root, inserted } = await body({ tab: 'skills' });
    expect(rows(root, 'data-context-skill')).toEqual(['babysit-pr', 'floop', 'summary']);
    expect(root.textContent).toContain('Claude · inserts /name');

    await click(root, '[data-context-skill="floop"]');
    expect(inserted).toEqual(['/floop']);

    await click(root, '[data-context-chip="generic"]');
    expect(rows(root, 'data-context-skill')).toEqual(['floop']);
    await search(root, 'green');
    expect(text(root, '[data-context-note]')).toBe('Nothing under Generic matches “green”.');
  });

  it('spells a Codex skill $name and offers the Codex chip', async () => {
    const codex: SkillsCatalog = { harness: 'codex', skills: [skill({ name: 'deploy', origin: 'codex' })] };
    const { root, inserted } = await body({ tab: 'skills', loadSkills: async () => codex });
    expect(rows(root, 'data-context-chip')).toEqual(['all', 'claude', 'codex', 'generic']);
    await click(root, '[data-context-chip="codex"]');
    await click(root, '[data-context-skill="deploy"]');
    expect(inserted).toEqual(['$deploy']);
  });

  it('reports a failed read, and an empty catalog', async () => {
    let fail = true;
    const loadSkills = async (): Promise<SkillsCatalog> => {
      if (fail) throw new Error('');
      return { harness: 'claude', skills: [] };
    };
    const { root } = await body({ tab: 'skills', loadSkills });
    expect(text(root, '[data-context-failed]')).toContain('The daemon did not answer.');
    fail = false;
    await click(root, '[data-context-retry]');
    expect(text(root, '[data-context-note]')).toBe('No skills are installed for this agent.');
  });

  it('says it is reading', async () => {
    const { root } = await body({ tab: 'skills', loadSkills: never() });
    expect(text(root, '[data-context-note]')).toBe('Reading skills…');
  });
});

describe('ContextRailBody — Docs', () => {
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

describe('ContextRail', () => {
  const rail = async (collapsed: boolean, signals = fakeSignals(snapshot())) => {
    const changes: boolean[] = [];
    mounted = await mountSettled(
      <ContextRail
        collapsed={collapsed}
        onCollapsedChange={next => changes.push(next)}
        agentName="Hadi"
        signals={signals}
        loadMcp={async () => MCP}
        loadSkills={async () => SKILLS}
        loadDocs={async () => DOCS}
        onInsertSkill={() => undefined}
        onOpenFile={() => undefined}
        now={() => NOW}
      />,
    );
    return { root: mounted.container, changes };
  };

  it('is titled This folder and collapses to a strip', async () => {
    const { root, changes } = await rail(false);
    expect(root.querySelector('aside')?.getAttribute('aria-label')).toBe('This folder');
    expect(text(root, 'h2')).toBe('This folder');
    expect(root.querySelector('[data-context-rail-body]')).not.toBeNull();
    await click(root, '[data-context-rail-toggle]');
    expect(changes).toEqual([true]);
  });

  it('keeps the open count on the collapsed strip and expands from it', async () => {
    const { root, changes } = await rail(true);
    expect(root.querySelector('[data-context-rail]')?.getAttribute('data-context-rail')).toBe('collapsed');
    expect(root.querySelector('[data-context-rail-body]')).toBeNull();
    expect(text(root, '[data-context-rail-count]')).toBe('1');
    await click(root, '[data-context-rail-toggle]');
    expect(changes).toEqual([false]);

    await mounted?.unmount();
    mounted = undefined;
    const quiet = await rail(true, fakeSignals(snapshot([], [])));
    expect(quiet.root.querySelector('[data-context-rail-count]')).toBeNull();
  });
});
