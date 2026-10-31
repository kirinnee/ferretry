import { afterEach, describe, expect, it } from 'bun:test';
import type { WorkHit, WorkSearchResponse } from '@ferretry/protocol';
import { useWorkSearch, type WorkSearchAsk, type WorkSearchRead } from '../../src/hooks/use-work-search.ts';
import type { WorkSearchPort } from '../../src/lib/work-search.ts';
import { interact, type Mounted, mount } from '../support/dom.ts';

const hit = (id: string): WorkHit => ({
  kind: 'task',
  id,
  projectId: 'ferretry',
  sessionId: null,
  title: `Card ${id}`,
  state: 'open',
  standing: 'Doing',
  updatedAt: '2026-10-30T10:00:00.000Z',
  match: { field: 'title', line: `Card ${id}` },
  score: 1,
});

const answer = (...ids: string[]): WorkSearchResponse => ({
  hits: ids.map(hit),
  total: ids.length,
  indexed: { tasks: ids.length, agenda: 0 },
});

interface Pending {
  readonly ask: WorkSearchAsk;
  readonly signal: AbortSignal | undefined;
  readonly resolve: (response: WorkSearchResponse) => void;
  readonly reject: (error: Error) => void;
}

const controllablePort = () => {
  const pending: Pending[] = [];
  const port: WorkSearchPort = {
    search: (ask, signal) =>
      new Promise<WorkSearchResponse>((resolve, reject) => {
        pending.push({ ask, signal, resolve, reject });
      }),
  };
  return { port, pending };
};

let live: Mounted | undefined;
let latest: WorkSearchRead | undefined;

afterEach(async () => {
  await live?.unmount();
  live = undefined;
  latest = undefined;
});

function Probe(props: { port: WorkSearchPort; daemonKey: string; q: string }) {
  latest = useWorkSearch(props.port, props.daemonKey, { q: props.q }, 0);
  return null;
}

const show = async (port: WorkSearchPort, daemonKey: string, q: string): Promise<void> => {
  const element = <Probe port={port} daemonKey={daemonKey} q={q} />;
  if (live === undefined) live = await mount(element);
  else await live.render(element);
};

const tick = async (): Promise<void> => {
  await interact(() => new Promise(resolve => setTimeout(resolve, 5)));
};

const read = (): WorkSearchRead => {
  if (latest === undefined) throw new Error('the probe has not rendered');
  return latest;
};

describe('the work search hook when a search is refused', () => {
  it('keeps the last good answer, marked failed, when a later search for the same machine fails', async () => {
    const { port, pending } = controllablePort();
    await show(port, 'daemon-a', 'relay');
    await tick();
    await interact(async () => pending[0]?.resolve(answer('F1')));
    expect(read().hits.map(found => found.id)).toEqual(['F1']);

    await show(port, 'daemon-a', 'relay handshake');
    await tick();
    await interact(async () => pending[1]?.reject(new Error('offline')));
    expect(read()).toMatchObject({ total: 1, pending: false, failed: true });
    expect(read().hits.map(found => found.id)).toEqual(['F1']);
  });

  it("never carries another machine's answer into a failure", async () => {
    const { port, pending } = controllablePort();
    await show(port, 'daemon-a', 'relay');
    await tick();
    await interact(async () => pending[0]?.resolve(answer('F1')));

    await show(port, 'daemon-b', 'relay');
    await tick();
    await interact(async () => pending[1]?.reject(new Error('offline')));
    expect(read()).toMatchObject({ hits: [], total: 0, failed: true });
  });

  it('ignores a failure that arrives after the search was abandoned', async () => {
    const { port, pending } = controllablePort();
    await show(port, 'daemon-a', 'relay');
    await tick();
    await show(port, 'daemon-a', 'relay handshake');
    await tick();
    expect(pending[0]?.signal?.aborted).toBe(true);

    await interact(async () => pending[0]?.reject(new Error('aborted late')));
    expect(read().failed).toBe(false);
    await interact(async () => pending[1]?.resolve(answer('F2')));
    expect(read().hits.map(found => found.id)).toEqual(['F2']);
  });

  it('ignores an answer that arrives after the search was abandoned', async () => {
    const { port, pending } = controllablePort();
    await show(port, 'daemon-a', 'relay');
    await tick();
    await show(port, 'daemon-a', 'relay handshake');
    await tick();
    await interact(async () => pending[0]?.resolve(answer('F9')));
    expect(read().hits).toEqual([]);
  });
});
