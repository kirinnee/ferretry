import { describe, expect, it } from 'bun:test';
import type { PluginCommandContext } from '@ferretry/app';
import {
  type CommandBarAnswer,
  type CommandBarEntry,
  type CommandBarListSource,
  commandBarOptionId,
} from '@ferretry/app/ui';
import { currentProjectId, fileEntryId, goToFileSource } from '../../../app/features/file-finder/go-to-file.ts';
import { PROJECT, ferret, refusal, scripted, type Call, type Route } from './support/client.ts';
import { answerFor, FILES, summaryOf } from './support/finder-fixtures.ts';

const DAEMON = 'workstation';
const HERE = `/d/${DAEMON}/projects/${PROJECT.id}`;
const SCAN = 'packages/plugins/projects/daemon/features/repos/scan.ts';

interface Options {
  readonly files?: Route;
  readonly ferrets?: Route;
  readonly now?: () => number;
}

const harness = (pathname: string, calls: Call[] = [], options: Options = {}) => {
  const navigated: string[] = [];
  let changed = 0;
  const context = {
    client: scripted(
      {
        [FILES]: options.files ?? ((call: Call) => answerFor(summaryOf(), call.query?.q, Number(call.query?.limit))),
        'GET /v1/projects': [PROJECT],
        'GET /v1/ferrets': options.ferrets ?? [],
      },
      calls,
    ),
    daemon: DAEMON,
    navigate: (href: string) => void navigated.push(href),
    screenHref: () => undefined,
    changed: () => {
      changed += 1;
    },
  } as unknown as PluginCommandContext;
  const source = goToFileSource({
    pathname: () => pathname,
    debounceMs: 1,
    ...(options.now === undefined ? {} : { now: options.now }),
  })(context) as CommandBarListSource;
  return { source, navigated, changes: () => changed };
};

const entriesOf = (answer: readonly CommandBarEntry[] | CommandBarAnswer): readonly CommandBarEntry[] =>
  Array.isArray(answer) ? answer : (answer as CommandBarAnswer).entries;

const nextChange = async (changes: () => number, before: number): Promise<void> => {
  for (let turn = 0; turn < 500 && changes() === before; turn += 1)
    await new Promise(resolve => setTimeout(resolve, 2));
  expect(changes()).toBeGreaterThan(before);
};

/** Waits for what a chosen entry does (it reads the project and ferret lists first). */
const navigatedTo = async (navigated: string[]): Promise<string> => {
  for (let turn = 0; turn < 500 && navigated.length === 0; turn += 1)
    await new Promise(resolve => setTimeout(resolve, 2));
  return navigated[0] ?? '';
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
    const { source, changes } = harness(HERE, calls);
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
  });

  it('choosing a file opens THAT file in the file view of the project’s newest ferret', async () => {
    const { source, changes, navigated } = harness(HERE, [], {
      ferrets: [
        ferret('older', PROJECT.path, { stateAt: '2026-08-01T10:00:00.000Z' }),
        ferret('newer', PROJECT.path, { stateAt: '2026-08-06T10:00:00.000Z' }),
        ferret('elsewhere', '/home/k/scratch', { stateAt: '2026-08-07T10:00:00.000Z' }),
      ],
    });
    source.list('scan', {});
    await nextChange(changes, 0);
    entriesOf(source.list('scan', {}))[0]?.run();
    expect(await navigatedTo(navigated)).toBe(`/d/${DAEMON}/ferrets/newer?file=${encodeURIComponent(SCAN)}`);
  });

  it('with no ferret working there a chosen file opens the project page with its finder seeded', async () => {
    const { source, changes, navigated } = harness(HERE);
    source.list('scan', {});
    await nextChange(changes, 0);
    entriesOf(source.list('scan', {}))[0]?.run();
    expect(await navigatedTo(navigated)).toBe(`${HERE}?find=${encodeURIComponent(SCAN)}`);
  });

  it('a ferret list that cannot be read falls back to the seeded project page, never to nowhere', async () => {
    const { source, changes, navigated } = harness(HERE, [], {
      ferrets: refusal(403, 'the fleet is not yours to read', 'grant-denied'),
    });
    source.list('scan', {});
    await nextChange(changes, 0);
    entriesOf(source.list('scan', {}))[0]?.run();
    expect(await navigatedTo(navigated)).toBe(`${HERE}?find=${encodeURIComponent(SCAN)}`);
  });

  it('a burst of keystrokes is one read, and the earlier text’s files are never listed under the new text', async () => {
    const calls: Call[] = [];
    const { source, changes } = harness(HERE, calls);
    source.list('s', {});
    source.list('sc', {});
    const last = source.list('scan', {}) as CommandBarAnswer;
    expect(last.pending).toBeDefined();
    await nextChange(changes, 0);
    expect(calls.filter(call => call.route === FILES).map(call => call.query?.q)).toEqual(['scan']);
  });
});

describe('Go to file option ids', () => {
  it('two files whose names differ only by `.` and `-` never share a DOM id', () => {
    const ids = ['src/entry.ts', 'src/entry-ts', 'src/entry_ts', 'src/entry/ts', 'src/entry ts'].map(path =>
      commandBarOptionId({ id: fileEntryId(PROJECT.id, path), group: 'Files', label: path, run: () => undefined }),
    );
    expect(new Set(ids).size).toBe(ids.length);
    // The id is already what the bar would make of it, so the bar changes nothing in it.
    for (const id of ids) expect(id).toMatch(/^fy-command-bar-option-[A-Za-z0-9_-]+$/u);
  });

  it('the listed entries of such files carry distinct ids', async () => {
    const { source, changes } = harness(HERE, [], {
      files: () => answerFor(summaryOf(), 'entry', 12, false, ['src/entry.ts', 'src/entry-ts']),
    });
    source.list('entry', {});
    await nextChange(changes, 0);
    const entries = entriesOf(source.list('entry', {}));
    expect(entries.length).toBe(2);
    const ids = entries.map(entry => commandBarOptionId(entry));
    expect(new Set(ids).size).toBe(2);
  });
});

describe('Go to file when the read fails', () => {
  it('says the daemon’s refusal as one line instead of “no results”, and does not keep it', async () => {
    let clock = 1_000;
    let denied = true;
    const calls: Call[] = [];
    const { source, changes } = harness(HERE, calls, {
      now: () => clock,
      files: (call: Call) =>
        denied
          ? refusal(403, 'listing a folder outside the home folder needs filesystem.configure', 'step-up-required')
          : answerFor(summaryOf(), call.query?.q, Number(call.query?.limit)),
    });
    source.list('scan', {});
    await nextChange(changes, 0);
    const [line, ...rest] = entriesOf(source.list('scan', {}));
    expect(rest).toEqual([]);
    expect(line?.label).toBe('Search refused by the daemon');
    expect(line?.description).toBe('listing a folder outside the home folder needs filesystem.configure');
    // Not faded: it is the line the reader has to act on.
    expect(line?.muted).toBeUndefined();
    // Listed again at once (the same text, a re-render): the failure is shown, not asked for again in a loop.
    expect(entriesOf(source.list('scan', {}))[0]?.label).toBe('Search refused by the daemon');
    expect(calls.filter(call => call.route === FILES).length).toBe(1);

    // The reader grants access and the same text is listed again a while later: it reads again and now answers.
    denied = false;
    clock += 10_000;
    const again = source.list('scan', {}) as CommandBarAnswer;
    expect(again.pending).toBeDefined();
    await nextChange(changes, 1);
    expect(entriesOf(source.list('scan', {})).map(entry => entry.label)).toEqual(['scan.ts']);
  });

  it('a bar opened again (the box cleared) forgets a refusal, so the same text is read afresh at once', async () => {
    const calls: Call[] = [];
    let busy = true;
    const { source, changes } = harness(HERE, calls, {
      files: (call: Call) =>
        busy ? refusal(503, 'the file index is busy', 'index_busy') : answerFor(summaryOf(), call.query?.q, 12),
    });
    source.list('scan', {});
    await nextChange(changes, 0);
    expect(entriesOf(source.list('scan', {}))[0]?.label).toBe('File search is not ready');
    expect(entriesOf(source.list('scan', {}))[0]?.description).toBe('the file index is busy');
    busy = false;
    source.list('', {});
    const reopened = source.list('scan', {}) as CommandBarAnswer;
    expect(reopened.pending).toBeDefined();
    await nextChange(changes, 1);
    expect(entriesOf(source.list('scan', {})).map(entry => entry.label)).toEqual(['scan.ts']);
  });
});
