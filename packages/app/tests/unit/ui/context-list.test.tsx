import { afterEach, describe, expect, it } from 'bun:test';
import {
  ContextFailure,
  chipsFor,
  contextEmptyCopy,
  loadFailureReason,
  matchesQuery,
  plainFailure,
  useContextRead,
} from '../../../src/ui/context-list.tsx';
import { settleUntil } from '../../../src/testing/settle.ts';
import { interact, type Mounted, mount } from '../../support/dom.ts';

let open: Mounted | null = null;
afterEach(async () => {
  await open?.unmount();
  open = null;
});

describe('searching and counting a list', () => {
  it('matches case- and locale-insensitively over every field a row offers', () => {
    expect(matchesQuery('  DEP ', 'deploy', null)).toBe(true);
    expect(matchesQuery('zzz', 'deploy', undefined, 'This project')).toBe(false);
    expect(matchesQuery('', 'anything')).toBe(true);
  });

  it('counts each chip over the rows the search leaves', () => {
    const chips = chipsFor(
      ['all', 'odd'] as const,
      { all: 'All', odd: 'Odd' },
      [1, 2, 3],
      (row, chip) => chip === 'all' || row % 2 === 1,
    );
    expect(chips).toEqual([
      { key: 'all', label: 'All', count: 3 },
      { key: 'odd', label: 'Odd', count: 2 },
    ]);
  });

  it('says a filtered-out list is not an empty one', () => {
    expect(contextEmptyCopy('Nothing yet.', 0, '', 'All')).toBe('Nothing yet.');
    expect(contextEmptyCopy('Nothing yet.', 3, '', 'Project')).toBe('Nothing under Project.');
    expect(contextEmptyCopy('Nothing yet.', 3, ' x ', 'Project')).toBe('Nothing under Project matches “x”.');
  });
});

describe('a failure in plain words', () => {
  it('names the machine when it did not answer or could not be reached, keeping the raw text for Details', () => {
    expect(plainFailure('request timed out', 'Studio', 'read skills')).toEqual({
      headline: 'Studio isn’t answering right now',
      details: 'request timed out',
    });
    expect(plainFailure('failed to fetch', 'Studio', 'read skills').headline).toBe('Studio isn’t reachable right now');
  });

  it('says the act that failed for anything else, and for a refusal the machine itself worded', () => {
    expect(plainFailure('boom', 'Studio', 'read skills')).toEqual({
      headline: 'Couldn’t read skills',
      details: 'boom',
    });
    expect(plainFailure('network error at the provider', 'Studio', 'sign in', true).headline).toBe('Couldn’t sign in');
    expect(plainFailure('this device has not granted it', 'Studio', 'x').headline).toBe(
      'this device has not granted it',
    );
    expect(plainFailure('', 'Studio', 'read skills')).toEqual({ headline: 'Couldn’t read skills' });
  });

  it('draws the headline, the details behind a disclosure and a Try again that calls back', async () => {
    let retried = 0;
    open = await mount(
      <ContextFailure
        machineName="Studio"
        what="read skills"
        reason="boom"
        onRetry={() => {
          retried += 1;
        }}
      />,
    );
    expect(open.container.querySelector('[role="alert"]')?.textContent).toContain('Couldn’t read skills');
    expect(open.container.querySelector('[data-context-failed-details]')?.textContent).toContain('boom');
    await interact(() => open?.container.querySelector<HTMLButtonElement>('[data-context-retry]')?.click());
    expect(retried).toBe(1);
  });

  it('uses the error’s own sentence, else a plain one', () => {
    expect(loadFailureReason(new Error('the daemon said no'))).toBe('the daemon said no');
    expect(loadFailureReason(new Error('  '))).toBe('The daemon did not answer.');
    expect(loadFailureReason('x')).toBe('The daemon did not answer.');
  });
});

describe('a lazy read', () => {
  function Probe({
    loader,
    wanted,
  }: {
    readonly loader: (signal: AbortSignal) => Promise<string>;
    readonly wanted: boolean;
  }) {
    const { load, reload } = useContextRead(loader, wanted);
    return (
      <div>
        <span data-state>{load.kind === 'ready' ? `ready:${load.value}` : load.kind}</span>
        <button type="button" data-reload onClick={reload} />
      </div>
    );
  }
  const state = (): string => open?.container.querySelector('[data-state]')?.textContent ?? '';
  const wait = (want: string) => settleUntil(() => state() === want, `the read to be ${want}`, interact);

  it('reads nothing until it is wanted, then once, and again only on retry', async () => {
    let reads = 0;
    const loader = async () => {
      reads += 1;
      return `v${reads}`;
    };
    open = await mount(<Probe loader={loader} wanted={false} />);
    expect(state()).toBe('idle');
    expect(reads).toBe(0);
    await open.render(<Probe loader={loader} wanted />);
    await wait('ready:v1');
    await interact(() => open?.container.querySelector<HTMLButtonElement>('[data-reload]')?.click());
    await wait('ready:v2');
    expect(reads).toBe(2);
  });

  it('keeps the rows on screen through a refresh, but not across a different list', async () => {
    const first = async () => 'one';
    let release: (value: string) => void = () => undefined;
    const second = () => new Promise<string>(resolve => (release = resolve));
    open = await mount(<Probe loader={first} wanted />);
    await wait('ready:one');
    await open.render(<Probe loader={second} wanted />);
    expect(state()).toBe('loading');
    await interact(async () => release('two'));
    await wait('ready:two');
  });

  it('says a failed read as a value and recovers on retry', async () => {
    let fail = true;
    const loader = async () => {
      if (fail) throw new Error('nope');
      return 'fine';
    };
    open = await mount(<Probe loader={loader} wanted />);
    await wait('failed');
    fail = false;
    await interact(() => open?.container.querySelector<HTMLButtonElement>('[data-reload]')?.click());
    await wait('ready:fine');
  });
});
