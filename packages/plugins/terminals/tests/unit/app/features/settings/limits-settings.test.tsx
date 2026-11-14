import '@ferretry/app/testing';
import { describe, expect, it } from 'bun:test';
import { ensureDom, interact, mount, must, runAsync, settleUntil } from '@ferretry/app/testing';
import { LimitsSurface, limitsBadge } from '../../../../../app/features/settings/limits-settings.tsx';
import { LIMITS_COMMAND, limitsCommands } from '../../../../../app/features/settings/limits-command.ts';
import type { TerminalSlotsClient } from '../../../../../app/features/settings/terminal-slots-api.ts';
import { pluginTerminalSlotsClient } from '../../../../../app/lib/plugin-client.ts';
import { daemonConnection } from '../../../../../app/shell.ts';

ensureDom();

interface LimitsEntry {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly keywords?: readonly string[];
  readonly run: () => void;
}

/** S-0137 "Ferret limits": a read-only panel from the daemon's own `GET /v1/cgroups/config` view. */
const view = (over: Record<string, unknown> = {}) => ({
  switchedOn: true,
  enforcement: 'cgroups',
  explicit: false,
  platform: 'linux',
  budget: { ceilingBytes: 64e9, physicalBytes: 64e9, swapBytes: 0, cpus: 8, source: 'the RAM', reserveBytes: 4e9 },
  fleet: {},
  perFerret: {},
  disk: { ionice: true, effect: 'full' },
  throttled: [{ sessionId: 's-1', callsign: 'hadi' }],
  killed: [],
  overBudget: [],
  file: 'limits.yaml',
  lines: ['ferrets together may use 56 GB of memory; the daemon keeps 4 GB', 'hadi is slowed for memory now'],
  warnings: ['disk priority has no effect on this disk'],
  ...over,
});

const clientOf = (answer: unknown | Error, calls: string[] = []): (() => Promise<TerminalSlotsClient>) => {
  return async () => ({
    request: (async (path: string, _schema: unknown, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      if (answer instanceof Error) throw answer;
      return answer;
    }) as TerminalSlotsClient['request'],
  });
};

const settled = async (root: HTMLElement, selector: string): Promise<void> => {
  await settleUntil(() => root.querySelector(selector) !== null, selector, runAsync);
};

describe('S-0137 the badge', () => {
  it('S-0137 says switched off, enforced, priority only or not enforced', () => {
    expect(limitsBadge(view({ switchedOn: false }) as never)).toEqual({ text: 'switched off', good: false });
    expect(limitsBadge(view() as never)).toEqual({ text: 'enforced', good: true });
    expect(limitsBadge(view({ enforcement: 'priority' }) as never)).toEqual({ text: 'priority only', good: true });
    expect(limitsBadge(view({ enforcement: 'none' }) as never)).toEqual({ text: 'not enforced', good: false });
  });
});

describe('S-0137 Settings › Ferret limits', () => {
  it('S-0137 draws the daemon’s own lines, its warnings and where to change it, with no editor', async () => {
    const calls: string[] = [];
    const shown = await mount(
      <LimitsSurface connection={daemonConnection('alpha')} createClient={clientOf(view(), calls)} />,
    );
    await settled(shown.container, '[data-testid="limits-card"]');
    const root = shown.container;
    expect(calls).toEqual(['GET /v1/cgroups/config']);
    expect(root.textContent).toContain('Ferret limits');
    expect(root.querySelector('[data-limits-badge]')?.textContent).toBe('enforced');
    expect([...root.querySelectorAll('[aria-label="What is in force"] li')].map(li => li.textContent)).toEqual([
      'ferrets together may use 56 GB of memory; the daemon keeps 4 GB',
      'hadi is slowed for memory now',
    ]);
    expect(root.querySelector('[role="alert"]')?.textContent).toContain('disk priority has no effect on this disk');
    expect(root.textContent).toContain('edit limits.yaml in Settings › Files');
    // Read-only on purpose: limits change only through limits.yaml.
    expect(root.querySelectorAll('input, select, textarea, button')).toHaveLength(0);
    await shown.unmount();
  });

  it('S-0137 says it will not assume when the daemon did not answer', async () => {
    const shown = await mount(
      <LimitsSurface connection={daemonConnection('alpha')} createClient={clientOf(new Error('daemon down'))} />,
    );
    await settled(shown.container, '[aria-label="Ferret limits unavailable"]');
    expect(shown.container.textContent).toContain('will not assume they are on or off');
    expect(shown.container.textContent).toContain('daemon down');
    await shown.unmount();
  });

  it('S-0137 reads through the shell client by the declared route, parsing the view', async () => {
    const seen: string[] = [];
    const slots = pluginTerminalSlotsClient({
      call: async (route: string) => {
        seen.push(route);
        return view();
      },
    } as never);
    const shown = await mount(
      <LimitsSurface connection={daemonConnection('alpha')} createClient={async () => slots} />,
    );
    await settled(shown.container, '[data-testid="limits-card"]');
    expect(seen).toEqual(['GET /v1/cgroups/config']);
    await shown.unmount();
  });
});

describe('S-0137 the palette entry', () => {
  it('S-0137 finds Ferret limits by the words a person types when the machine is slow, and opens its tab', () => {
    const visited: string[] = [];
    const source = limitsCommands({
      client: {} as never,
      daemon: 'alpha',
      navigate: href => visited.push(href),
      screenHref: (() => '') as never,
      changed: () => undefined,
    }) as (query: string) => readonly LimitsEntry[];
    const entries = source('');
    const entry = must(
      entries.find(candidate => candidate.id === `${LIMITS_COMMAND}-alpha`),
      'the Ferret limits entry',
    );
    expect(entry.label).toBe('Ferret limits');
    expect(entry.description).toContain('How much of the machine the ferrets may take');
    for (const word of ['cpu', 'ram', 'memory', 'oom', 'limits.yaml', 'slow']) expect(entry.keywords).toContain(word);
    entry.run();
    expect(visited).toEqual(['/d/alpha/settings/terminals/limits']);
    void interact;
  });
});
