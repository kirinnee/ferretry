import { afterEach, describe, expect, it } from 'bun:test';
import { interact, type Mounted, mount, must, settleUntil } from '@ferretry/app/testing';
import { FileFinder } from '../../../app/features/file-finder/file-finder.tsx';
import { PROJECT, refusal, scripted, typeInto, clickEvent, type Call } from './support/client.ts';
import { answerFor, CAPPED, FILES, PATHS, RESCAN, STATUS, statusOf, summaryOf } from './support/finder-fixtures.ts';

const FAST = { debounceMs: 5, pollMs: 5 } as const;
const NOW = Date.parse('2026-08-01T10:03:00.000Z');

const finder = (client: ReturnType<typeof scripted>, initialQuery = '') => (
  <FileFinder client={client} project={PROJECT} initialQuery={initialQuery} timings={FAST} now={() => NOW} />
);

/** The finder's debounce and poll are real timers (5 ms here), so each settle turn also lets 2 ms of wall clock pass. */
const until = async (mounted: Mounted, ready: (container: HTMLElement) => boolean, what: string): Promise<void> =>
  await settleUntil(
    () => ready(mounted.container),
    what,
    callback =>
      interact(async () => {
        await callback();
        await new Promise<void>(resolve => setTimeout(resolve, 2));
      }),
  );

const rows = (mounted: Mounted): string[] =>
  [...mounted.container.querySelectorAll('[data-finder-row]')].map(row => row.getAttribute('data-finder-row') ?? '');

const query = (call: Call): string | undefined => call.query?.q;

const reading = (index = summaryOf()) => ({
  [FILES]: (call: Call) => answerFor(index, query(call), Number(call.query?.limit ?? 50)),
});

afterEach(() => {
  Object.defineProperty(globalThis.navigator, 'clipboard', { value: undefined, configurable: true });
});

describe('FileFinder', () => {
  it('lists the top of the index at first, asking the daemon for the default 50 and no search text', async () => {
    const calls: Call[] = [];
    const mounted = await mount(finder(scripted(reading(), calls)));
    await until(mounted, c => c.querySelector('[data-finder-row]') !== null, 'the first rows');

    expect(rows(mounted)).toEqual(PATHS);
    expect(calls[0]?.route).toBe(FILES);
    expect(calls[0]?.params).toEqual({ id: PROJECT.id });
    expect(calls[0]?.query).toEqual({ limit: '50' });
    expect(mounted.container.querySelector('[data-finder-built]')?.textContent).toBe(
      '12,594 files indexed · updated 3m ago',
    );
    // A complete index with nothing skipped says nothing more.
    expect(mounted.container.querySelector('[data-finder-banner]')).toBeNull();
    await mounted.unmount();
  });

  it('says "1 file indexed" for a single file and the plural for every other count', async () => {
    const one = await mount(finder(scripted(reading(summaryOf({ indexed: 1 })), [])));
    await until(one, c => c.querySelector('[data-finder-built]') !== null, 'the index line');
    expect(one.container.querySelector('[data-finder-built]')?.textContent).toBe('1 file indexed · updated 3m ago');
    await one.unmount();
    const none = await mount(finder(scripted(reading(summaryOf({ indexed: 0 })), [])));
    await until(none, c => c.querySelector('[data-finder-built]') !== null, 'the index line');
    expect(none.container.querySelector('[data-finder-built]')?.textContent).toBe('0 files indexed · updated 3m ago');
    await none.unmount();
  });

  it('searches on the daemon as the person types, one read for a burst, and draws what comes back', async () => {
    const calls: Call[] = [];
    const mounted = await mount(finder(scripted(reading(), calls)));
    await until(mounted, c => c.querySelector('[data-finder-row]') !== null, 'the first rows');

    const input = must(mounted.container.querySelector<HTMLInputElement>('[data-finder-input]'), 'the box');
    await interact(() => {
      typeInto(input, 'sc');
      typeInto(input, 'scan');
    });
    await until(mounted, c => c.querySelectorAll('[data-finder-row]').length === 1, 'the filtered rows');

    expect(rows(mounted)).toEqual(['packages/plugins/projects/daemon/features/repos/scan.ts']);
    const searches = calls.filter(call => query(call) !== undefined).map(query);
    expect(searches).toEqual(['scan']);
    await mounted.unmount();
  });

  it('starts from the text an address seeded it with', async () => {
    const calls: Call[] = [];
    const mounted = await mount(finder(scripted(reading(), calls), 'README'));
    await until(mounted, c => c.querySelector('[data-finder-row]') !== null, 'the seeded rows');

    expect(query(calls[0] as Call)).toBe('README');
    expect(must(mounted.container.querySelector<HTMLInputElement>('[data-finder-input]'), 'box').value).toBe('README');
    expect(rows(mounted)).toEqual(['README.md']);
    await mounted.unmount();
  });

  it('at the cap says it, names where, what was skipped and how to help; never a bare list', async () => {
    const mounted = await mount(finder(scripted(reading(CAPPED))));
    await until(mounted, c => c.querySelector('[data-finder-banner]') !== null, 'the banner');

    const banner = must(mounted.container.querySelector('[data-finder-banner]'), 'the banner');
    expect(banner.getAttribute('data-finder-banner')).toBe('cap');
    const text = banner.textContent ?? '';
    expect(text).toContain('Showing 50,000 of more than 50,000 files — the rest were not looked at.');
    expect(text).toContain('Most files: data/ (31,200), packages/ (12,400), docs/ (3,100).');
    expect(text).toContain('Skipped: 3 nested worktrees, 41 secret-looking names.');
    expect(text).toContain('Tip: add big generated folders to .gitignore.');
    expect(mounted.container.querySelector('[data-finder-coverage="partial"]')).not.toBeNull();
    await mounted.unmount();
  });

  it('never says "no file matches" over a partial index', async () => {
    const mounted = await mount(finder(scripted(reading(CAPPED)), 'zzz-not-here'));
    await until(mounted, c => c.querySelector('[data-finder-empty]') !== null, 'the empty sentence');

    const text = mounted.container.querySelector('[data-finder-empty]')?.textContent ?? '';
    expect(text).toContain('the file may exist beyond them');
    expect(text).not.toContain('No file in this project');
    await mounted.unmount();
  });

  it('says there is no match over a complete index', async () => {
    const mounted = await mount(finder(scripted(reading()), 'zzz-not-here'));
    await until(mounted, c => c.querySelector('[data-finder-empty]') !== null, 'the empty sentence');

    expect(mounted.container.querySelector('[data-finder-empty]')?.textContent).toBe(
      'No file in this project matches “zzz-not-here”.',
    );
    await mounted.unmount();
  });

  it('says how many matches are not on screen', async () => {
    const mounted = await mount(
      finder(
        scripted({
          [FILES]: () => ({ ...answerFor(summaryOf(), undefined, 50), total: 1_312 }),
        }),
      ),
    );
    await until(mounted, c => c.querySelector('[data-finder-count]') !== null, 'the count');

    expect(mounted.container.querySelector('[data-finder-count]')?.textContent).toContain(
      'Showing 7 of 1,312 matches.',
    );
    await mounted.unmount();
  });

  it('Rescan starts a build, shows Updating… and reads again once the build is over', async () => {
    const calls: Call[] = [];
    let building = true;
    let builtAt = '2026-08-01T10:00:00.000Z';
    const mounted = await mount(
      finder(
        scripted(
          {
            [FILES]: (call: Call) => answerFor(summaryOf({ builtAt }), query(call), 50),
            [RESCAN]: () => statusOf(summaryOf({ builtAt }), true),
            [STATUS]: () => {
              if (building) {
                building = false;
                builtAt = '2026-08-01T10:02:30.000Z';
                return statusOf(summaryOf({ builtAt }), true);
              }
              return statusOf(summaryOf({ builtAt }), false);
            },
          },
          calls,
        ),
      ),
    );
    await until(mounted, c => c.querySelector('[data-finder-row]') !== null, 'the first rows');

    const button = must(mounted.container.querySelector<HTMLButtonElement>('[data-finder-rescan]'), 'rescan');
    expect(button.textContent).toContain('Rescan');
    await interact(() => button.dispatchEvent(clickEvent()));
    expect(calls.some(call => call.route === RESCAN)).toBe(true);
    await until(
      mounted,
      c => c.querySelector('[data-finder-rescan]')?.textContent?.includes('Updating') === true,
      'updating',
    );
    expect(button.getAttribute('aria-disabled')).toBe('true');
    const callsBefore = calls.length;
    await interact(() => button.dispatchEvent(clickEvent()));
    expect(calls.slice(callsBefore).some(call => call.route === RESCAN)).toBe(false);
    // Rows stay while it builds, then a fresh read lands and the button is back.
    expect(rows(mounted)).toEqual(PATHS);
    await until(
      mounted,
      c => c.querySelector('[data-finder-rescan]')?.textContent?.includes('Rescan') === true,
      'the build to finish',
    );
    expect(calls.filter(call => call.route === FILES).length).toBeGreaterThanOrEqual(2);
    expect(mounted.container.querySelector('[data-finder-built]')?.textContent).toContain('updated 3m ago');
    await mounted.unmount();
  });

  it('keeps polling while an answer says a newer index is being built', async () => {
    let status = 0;
    const calls: Call[] = [];
    const mounted = await mount(
      finder(
        scripted(
          {
            [FILES]: (call: Call) => answerFor(summaryOf(), query(call), 50, status < 2),
            [STATUS]: () => {
              status += 1;
              return statusOf(summaryOf(), status < 2);
            },
          },
          calls,
        ),
      ),
    );
    await until(
      mounted,
      c => c.querySelector('[data-finder-rescan]')?.textContent?.includes('Updating') === true,
      'updating',
    );
    await until(
      mounted,
      c => c.querySelector('[data-finder-rescan]')?.textContent?.includes('Rescan') === true,
      'done',
    );
    expect(calls.filter(call => call.route === FILES).length).toBeGreaterThanOrEqual(2);
    await mounted.unmount();
  });

  it('names a failed first read as the daemon worded it', async () => {
    const mounted = await mount(
      finder(
        scripted({
          [FILES]: refusal(403, 'this project folder is private and is not indexed', 'project_folder_private'),
        }),
      ),
    );
    await until(mounted, c => c.querySelector('[data-finder-state="failed"]') !== null, 'the failure');

    expect(mounted.container.querySelector('[data-finder-error]')?.textContent).toBe(
      'Could not read this project’s files: this project folder is private and is not indexed',
    );
    await mounted.unmount();
  });

  it('keeps the last answer on screen when a later read fails', async () => {
    let failing = false;
    const mounted = await mount(
      finder(
        scripted({
          [FILES]: (call: Call) => {
            if (failing) throw new Error('the daemon is busy');
            return answerFor(summaryOf(), query(call), 50);
          },
        }),
      ),
    );
    await until(mounted, c => c.querySelector('[data-finder-row]') !== null, 'the first rows');

    failing = true;
    const input = must(mounted.container.querySelector<HTMLInputElement>('[data-finder-input]'), 'box');
    await interact(() => typeInto(input, 'scan'));
    await until(mounted, c => c.querySelector('[data-finder-error]') !== null, 'the refresh failure');

    expect(mounted.container.querySelector('[data-finder-error]')?.textContent).toContain('the daemon is busy');
    expect(rows(mounted)).toEqual(PATHS);
    await mounted.unmount();
  });

  it('a row copies the absolute path of its file', async () => {
    const copied: string[] = [];
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText: async (text: string) => void copied.push(text) },
      configurable: true,
    });
    const mounted = await mount(finder(scripted(reading())));
    await until(mounted, c => c.querySelector('[data-finder-row]') !== null, 'the rows');

    const row = must(mounted.container.querySelector('[data-finder-row="README.md"]'), 'the README row');
    await interact(() => row.dispatchEvent(clickEvent()));
    await until(mounted, c => (c.textContent ?? '').includes('Copied'), 'the confirmation');
    expect(copied).toEqual(['/work/ferretry/README.md']);
    await mounted.unmount();
  });

  it('with a ferret working here a row OPENS that file in the ferret’s file view, and a button beside it copies the path', async () => {
    const navigated: string[] = [];
    const mounted = await mount(
      <FileFinder
        client={scripted(reading())}
        project={PROJECT}
        timings={FAST}
        now={() => NOW}
        opensIn={{ daemon: 'workstation', ferret: { id: 'f-1', name: 'hayden' } }}
        onNavigate={to => void navigated.push(to)}
      />,
    );
    await until(mounted, c => c.querySelector('[data-finder-row]') !== null, 'the rows');

    const row = must(mounted.container.querySelector('[data-finder-row="README.md"]'), 'the README row');
    expect(row.tagName).toBe('A');
    expect(row.getAttribute('href')).toBe('/d/workstation/ferrets/f-1?file=README.md');
    expect(row.getAttribute('aria-label')).toBe('Open README.md in the files of hayden');
    await interact(() => row.dispatchEvent(clickEvent()));
    expect(navigated).toEqual(['/d/workstation/ferrets/f-1?file=README.md']);
    expect(mounted.container.querySelector('[data-finder-copy="README.md"]')).not.toBeNull();
    await mounted.unmount();
  });

  it('a refused look at a running build stops “Updating…”, says why, and offers Rescan again', async () => {
    const calls: Call[] = [];
    const sentence = 'listing a folder outside the home folder needs filesystem.configure';
    const mounted = await mount(
      finder(
        scripted(
          {
            ...reading(),
            [RESCAN]: () => statusOf(summaryOf(), true),
            [STATUS]: () => refusal(403, sentence, 'step-up-required'),
          },
          calls,
        ),
      ),
    );
    await until(mounted, c => c.querySelector('[data-finder-row]') !== null, 'the first rows');
    const button = must(mounted.container.querySelector<HTMLButtonElement>('[data-finder-rescan]'), 'rescan');
    await interact(() => button.dispatchEvent(clickEvent()));
    await until(mounted, c => c.querySelector('[data-finder-refused]') !== null, 'the refusal');

    expect(mounted.container.querySelector('[data-finder-refused]')?.textContent).toContain(sentence);
    expect(button.textContent).toContain('Rescan');
    expect(button.getAttribute('aria-disabled')).toBe('false');
    // It asked once and stopped: no endless status reads behind a refusal.
    const statusReads = calls.filter(call => call.route === STATUS).length;
    await interact(() => new Promise<void>(resolve => setTimeout(resolve, 40)));
    expect(calls.filter(call => call.route === STATUS).length).toBe(statusReads);
    expect(statusReads).toBe(1);
    // Rescan works again.
    await interact(() => button.dispatchEvent(clickEvent()));
    expect(calls.filter(call => call.route === RESCAN).length).toBe(2);
    await mounted.unmount();
  });

  it('a hiccup in the look at a running build is said once and the next beat asks again', async () => {
    let looks = 0;
    const mounted = await mount(
      finder(
        scripted({
          ...reading(),
          [RESCAN]: () => statusOf(summaryOf(), true),
          [STATUS]: () => {
            looks += 1;
            return looks === 1 ? refusal(503, 'the file index is busy', 'index_busy') : statusOf(summaryOf(), false);
          },
        }),
      ),
    );
    await until(mounted, c => c.querySelector('[data-finder-row]') !== null, 'the first rows');
    const button = must(mounted.container.querySelector<HTMLButtonElement>('[data-finder-rescan]'), 'rescan');
    await interact(() => button.dispatchEvent(clickEvent()));
    await until(
      mounted,
      c => c.querySelector('[data-finder-rescan]')?.textContent?.includes('Rescan') === true,
      'the end',
    );
    expect(looks).toBeGreaterThanOrEqual(2);
    expect(mounted.container.querySelector('[data-finder-refused]')).toBeNull();
    await mounted.unmount();
  });
});
