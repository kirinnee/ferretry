import { afterEach, describe, expect, it } from 'bun:test';
import type { SessionView } from '@ferretry/protocol';
import { useCompactAtSessionActions } from '../../../../src/features/session-actions/compact-at-session-actions.tsx';
import type { SessionActionEntry, SessionActionFormHost } from '../../../../src/features/session-actions/registry.ts';
import { daemonConnection } from '../../../../src/lib/daemon-connection.ts';
import type { DaemonFetch } from '../../../../src/lib/runtime-models.ts';
import { interact, mount, must, type Mounted } from '../../../support/dom.ts';
import { schemaValidSessionView } from '../../../support/schema-valid-sessions.ts';
import { sessionView } from '../../../support/sessions.ts';

const daemon = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceId: 'a-token' });

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

type Build = (context: { view: SessionView; canControl: boolean }) => SessionActionEntry | null;

const host = (notes: string[], closes: number[]): SessionActionFormHost => ({
  close: () => closes.push(1),
  open: () => undefined,
  notify: note => notes.push(note),
  compact: false,
});

/** Mounts a probe around the hook and hands back the CURRENT build function (it changes after a save). */
const probe = async (fetcher: DaemonFetch): Promise<{ build: Build; root: () => HTMLElement }> => {
  const latest: { build?: Build } = {};
  const Probe = () => {
    latest.build = useCompactAtSessionActions({ connection: daemon, fetcher }).contributions[0]?.build as Build;
    return null;
  };
  mounted = await mount(<Probe />);
  return { build: context => must(latest.build, 'the build function')(context), root: () => document.body };
};

const READ = { own: 250_000, effective: 250_000, window: 1_000_000, restartRequired: true, note: 'At next launch.' };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

const form = (entry: SessionActionEntry | null) => {
  expect(entry?.kind).toBe('form');
  return entry as Extract<SessionActionEntry, { kind: 'form' }>;
};

const flush = () => interact(() => new Promise(resolve => setTimeout(resolve, 0)));

describe('the Compact memory at… action', () => {
  it('is hidden from someone who cannot control the ferret', async () => {
    const { build } = await probe(async () => json(200, READ));
    expect(build({ view: sessionView('s1'), canControl: false })).toBeNull();
  });

  it('says Default for a ferret with no value, and describes one that has a value', async () => {
    const { build } = await probe(async () => json(200, READ));
    expect(form(build({ view: sessionView('s1'), canControl: true })).detail).toBe('Default');
    const own = form(build({ view: sessionView('s1', { config: { compactAt: 250_000 } }), canControl: true }));
    expect(own.detail).toBe('250k');
    expect(own.label).toBe('Compact memory at…');
  });

  it('shows a note while it reads, then the form on what the daemon answered', async () => {
    let release: (response: Response) => void = () => undefined;
    const pending = new Promise<Response>(resolve => {
      release = resolve;
    });
    const { build } = await probe(async () => pending);
    const entry = form(build({ view: sessionView('s1'), canControl: true }));
    const shown = await mount(<div>{entry.render(host([], []))}</div>);
    expect(shown.container.textContent).toContain('Reading the current setting…');
    await interact(() => release(json(200, READ)));
    await flush();
    const radio = must(shown.container.querySelector('input[type="radio"][value="250000"]'), 'the 250k choice');
    expect((radio as HTMLInputElement).checked).toBe(true);
    await shown.unmount();
  });

  it('still opens a working form when the read fails, on the ferret’s own value', async () => {
    const { build } = await probe(async () => json(500, { error: 'nope' }));
    const entry = form(build({ view: sessionView('s1', { config: { compactAt: 400_000 } }), canControl: true }));
    const shown = await mount(<div>{entry.render(host([], []))}</div>);
    await flush();
    const radio = must(shown.container.querySelector('input[type="radio"][value="400000"]'), 'the 400k choice');
    expect((radio as HTMLInputElement).checked).toBe(true);
    await shown.unmount();
  });

  it('saves through the daemon, tells the owner its note, and remembers the value for the menu', async () => {
    const methods: Array<string | undefined> = [];
    const fetcher: DaemonFetch = async (_url, init) => {
      methods.push(init?.method);
      if (init?.method === 'PATCH')
        return json(200, {
          view: schemaValidSessionView('s1'),
          effective: 200_000,
          restartRequired: true,
          note: 'At next launch.',
        });
      return json(200, { effective: 'auto', restartRequired: false, note: 'Default.' });
    };
    const { build } = await probe(fetcher);
    const notes: string[] = [];
    const closes: number[] = [];
    const entry = form(build({ view: sessionView('s1'), canControl: true }));
    const shown = await mount(<div>{entry.render(host(notes, closes))}</div>);
    await flush();
    await interact(() =>
      (must(shown.container.querySelector('input[type="radio"][value="200000"]'), '200k') as HTMLInputElement).click(),
    );
    await interact(() =>
      must(shown.container.querySelector('form'), 'the form').dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      ),
    );
    await flush();
    expect(methods).toEqual([undefined, 'PATCH']);
    expect(notes).toEqual(['At next launch.']);
    expect(closes).toEqual([1]);
    expect(form(build({ view: sessionView('s1'), canControl: true })).detail).toBe('200k');
    expect(form(build({ view: sessionView('s2'), canControl: true })).detail).toBe('Default');
    await shown.unmount();
  });
});
