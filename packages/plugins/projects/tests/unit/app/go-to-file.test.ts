import { describe, expect, it } from 'bun:test';
import type { PluginCommandContext } from '@ferretry/app';
import type { CommandBarAnswer, CommandBarEntry, CommandBarListSource } from '@ferretry/app/ui';
import { currentProjectId, goToFileSource } from '../../../app/features/file-finder/go-to-file.ts';
import { PROJECT, scripted, type Call } from './support/client.ts';
import { answerFor, FILES, summaryOf } from './support/finder-fixtures.ts';

const DAEMON = 'workstation';
const HERE = `/d/${DAEMON}/projects/${PROJECT.id}`;

const harness = (pathname: string, calls: Call[] = []) => {
  const navigated: string[] = [];
  let changed = 0;
  const context = {
    client: scripted(
      { [FILES]: (call: Call) => answerFor(summaryOf(), call.query?.q, Number(call.query?.limit)) },
      calls,
    ),
    daemon: DAEMON,
    navigate: (href: string) => void navigated.push(href),
    screenHref: () => undefined,
    changed: () => {
      changed += 1;
    },
  } as unknown as PluginCommandContext;
  const source = goToFileSource({ pathname: () => pathname, debounceMs: 1 })(context) as CommandBarListSource;
  return { source, navigated, changes: () => changed };
};

const entriesOf = (answer: readonly CommandBarEntry[] | CommandBarAnswer): readonly CommandBarEntry[] =>
  Array.isArray(answer) ? answer : (answer as CommandBarAnswer).entries;

const nextChange = async (changes: () => number, before: number): Promise<void> => {
  for (let turn = 0; turn < 500 && changes() === before; turn += 1)
    await new Promise(resolve => setTimeout(resolve, 2));
  expect(changes()).toBeGreaterThan(before);
};

describe('currentProjectId', () => {
  it('is the project whose page is on screen, on this daemon only', () => {
    expect(currentProjectId(HERE, DAEMON)).toBe(PROJECT.id);
    expect(currentProjectId(`${HERE}/`, DAEMON)).toBe(PROJECT.id);
    expect(currentProjectId(`/d/other/projects/${PROJECT.id}`, DAEMON)).toBeUndefined();
    expect(currentProjectId(`/d/${DAEMON}/projects`, DAEMON)).toBeUndefined();
    expect(currentProjectId(`/d/${DAEMON}/projects/not-a-uuid`, DAEMON)).toBeUndefined();
    expect(currentProjectId(`/d/${DAEMON}/ferrets/${PROJECT.id}`, DAEMON)).toBeUndefined();
    expect(currentProjectId('/d/%E0%A4%A/projects/x', DAEMON)).toBeUndefined();
  });
});

describe('Go to file', () => {
  it('offers nothing anywhere but on a project’s page, and asks the daemon nothing', () => {
    const calls: Call[] = [];
    const { source } = harness(`/d/${DAEMON}/projects`, calls);
    expect(source.list('', {})).toEqual([]);
    expect(source.list('scan', {})).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('rests as one “Go to file” entry on a project’s page, which opens that project', () => {
    const { source, navigated } = harness(HERE);
    const [entry, ...rest] = entriesOf(source.list('', {}));
    expect(rest).toEqual([]);
    expect(entry?.label).toBe('Go to file');
    expect(entry?.resting).toBe(true);
    entry?.run();
    expect(navigated).toEqual([HERE]);
  });

  it('while typing says it is searching, then lists the daemon’s matches under Files', async () => {
    const calls: Call[] = [];
    const { source, changes, navigated } = harness(HERE, calls);
    const first = source.list('scan', {}) as CommandBarAnswer;
    expect(first.pending).toBe('Searching this project’s files…');
    expect(first.entries).toEqual([]);
    await nextChange(changes, 0);

    const entries = entriesOf(source.list('scan', {}));
    expect(entries.map(entry => entry.label)).toEqual(['scan.ts']);
    expect(entries[0]?.group).toBe('Files');
    expect(entries[0]?.description).toBe('packages/plugins/projects/daemon/features/repos/');
    expect(calls.map(call => call.query)).toEqual([{ q: 'scan', limit: '12' }]);
    expect(calls[0]?.params).toEqual({ id: PROJECT.id });
    entries[0]?.run();
    expect(navigated).toEqual([`${HERE}?find=packages%2Fplugins%2Fprojects%2Fdaemon%2Ffeatures%2Frepos%2Fscan.ts`]);
  });

  it('a burst of keystrokes is one read, and the earlier text’s files are never listed under the new text', async () => {
    const calls: Call[] = [];
    const { source, changes } = harness(HERE, calls);
    source.list('s', {});
    source.list('sc', {});
    const last = source.list('scan', {}) as CommandBarAnswer;
    expect(last.pending).toBeDefined();
    await nextChange(changes, 0);
    expect(calls.map(call => call.query?.q)).toEqual(['scan']);
  });

  it('lists nothing when the read fails, and says nothing alarming in the bar', async () => {
    const { source, changes } = (() => {
      const navigated: string[] = [];
      let changed = 0;
      const context = {
        client: scripted({ [FILES]: new Error('the daemon is busy') }),
        daemon: DAEMON,
        navigate: (href: string) => void navigated.push(href),
        changed: () => {
          changed += 1;
        },
      } as unknown as PluginCommandContext;
      return {
        source: goToFileSource({ pathname: () => HERE, debounceMs: 1 })(context) as CommandBarListSource,
        changes: () => changed,
      };
    })();
    source.list('scan', {});
    await nextChange(changes, 0);
    expect(entriesOf(source.list('scan', {}))).toEqual([]);
  });
});
