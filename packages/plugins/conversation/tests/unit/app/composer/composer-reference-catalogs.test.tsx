import { describe, expect, test } from 'bun:test';
import { render, run, runAsync } from '@ferretry/app/testing';
import type { ReactTestRenderer } from 'react-test-renderer';
import type { ReferenceCatalogPrefix } from '../../../../contract/index.ts';
import {
  HOSTED_REFERENCE_PREFIXES,
  readReferenceCatalog,
  useComposerReferenceCatalogs,
} from '../../../../app/composer/composer-reference-catalogs.ts';
import type { ConversationCaller } from '../../../../app/composer/seam.ts';
import { type RecordedCall, fakeClient } from '../../../support/app/fake-client.ts';

const ENTRIES: Readonly<Partial<Record<ReferenceCatalogPrefix, readonly { token: string; label: string }[]>>> = {
  '&': [{ token: 'F12', label: 'Ship autocomplete' }],
  '!': [{ token: 'A3', label: 'Choose a renderer' }],
  '/': [{ token: 'floop', label: 'Review until every lens is satisfied.' }],
  $: [{ token: 'floop', label: 'Review until every lens is satisfied.' }],
};

/** The daemon's answer for one prefix: what its provider supplies, or `provided: false` when nobody does. */
const answerFor = (call: RecordedCall, ferret = call.params.ferretId ?? '') => {
  const prefix = call.query.prefix as ReferenceCatalogPrefix;
  const entries = ENTRIES[prefix];
  return { ferret, prefix, provided: entries !== undefined, entries: entries ?? [] };
};

function CatalogProbe({
  client,
  ferretId,
  prefixes,
  onCatalogs,
}: {
  readonly client: Partial<ConversationCaller>;
  readonly ferretId: string;
  readonly prefixes?: readonly ReferenceCatalogPrefix[];
  readonly onCatalogs?: (catalogs: ReturnType<typeof useComposerReferenceCatalogs>) => void;
}) {
  const catalogs = useComposerReferenceCatalogs(client, ferretId, prefixes);
  onCatalogs?.(catalogs);
  const count = (prefix: ReferenceCatalogPrefix): string => String(catalogs.entries[prefix]?.length ?? '-');
  return <output>{`${count('&')}:${count('!')}:${count('/')}:${count('$')}`}</output>;
}

const output = (view: ReactTestRenderer): string => view.root.findByType('output').children.join('');

const flushCatalogs = async (): Promise<void> => {
  await runAsync(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
};

const readWith = async (answer: (call: RecordedCall) => unknown) => {
  let latest: ReturnType<typeof useComposerReferenceCatalogs> | undefined;
  const client = fakeClient(answer);
  const view = render(<CatalogProbe client={client} ferretId="ferret-a" onCatalogs={value => (latest = value)} />);
  await flushCatalogs();
  run(() => view.unmount());
  return latest;
};

describe('useComposerReferenceCatalogs', () => {
  test('reads each hosted prefix once through the one route, and supports a host without a client', async () => {
    const client = fakeClient(call => answerFor(call));
    const view = render(<CatalogProbe client={client} ferretId="ferret-a" />);

    await flushCatalogs();
    expect(output(view)).toBe('1:1:1:1');
    expect(client.calls.map(call => [call.route, call.params.ferretId, call.query.prefix])).toEqual(
      HOSTED_REFERENCE_PREFIXES.map(prefix => ['GET /v1/ferrets/:ferretId/references', 'ferret-a', prefix]),
    );

    run(() => view.update(<CatalogProbe client={{}} ferretId="ferret-a" />));
    expect(output(view)).toBe('-:-:-:-');
    run(() => view.unmount());
  });

  test('a prefix nobody provides reads as no entries, never as a failure', async () => {
    const catalogs = await readWith(call => ({ ...answerFor(call), provided: false, entries: [] }));
    expect(catalogs?.entries).toEqual({ '&': [], '!': [], '/': [], $: [] });
    expect(catalogs?.provided).toEqual({ '&': false, '!': false, '/': false, $: false });
    expect(catalogs?.failures).toEqual({});
  });

  test('publishes a fast family before slow siblings without issuing a second read', async () => {
    let resolveAgenda: ((value: unknown) => void) | undefined;
    const client = fakeClient(call =>
      call.query.prefix === '!'
        ? new Promise(resolve => {
            resolveAgenda = resolve;
          }).then(() => answerFor(call))
        : answerFor(call),
    );
    const view = render(<CatalogProbe client={client} ferretId="ferret-a" />);

    await flushCatalogs();
    expect(output(view)).toBe('1:-:1:1');
    expect(client.calls).toHaveLength(4);

    if (resolveAgenda === undefined) throw new Error('slow catalog read did not start');
    resolveAgenda(undefined);
    await flushCatalogs();
    expect(output(view)).toBe('1:1:1:1');
    expect(client.calls).toHaveLength(4);
    run(() => view.unmount());
  });

  test('keeps the other families when one read fails, and says so under that prefix', async () => {
    const catalogs = await readWith(call => {
      if (call.query.prefix === '!') throw new Error('asks unavailable');
      return answerFor(call);
    });
    expect(catalogs?.entries['!']).toBeUndefined();
    expect(catalogs?.entries['&']).toHaveLength(1);
    expect(catalogs?.failures).toEqual({ '!': 'asks unavailable' });
  });

  test('refuses an answer about another ferret without erasing the other families', async () => {
    const catalogs = await readWith(call =>
      call.query.prefix === '&' ? answerFor(call, 'ferret-b') : answerFor(call),
    );
    expect(catalogs?.entries['&']).toBeUndefined();
    expect(catalogs?.entries['/']).toHaveLength(1);
    expect(catalogs?.failures['&']).toContain('ferret-b');
  });

  test('refuses an answer that is not a catalog', async () => {
    const catalogs = await readWith(call => (call.query.prefix === '$' ? { entries: 'nope' } : answerFor(call)));
    expect(catalogs?.entries.$).toBeUndefined();
    expect(catalogs?.failures.$).toContain('no entries');
  });

  test('fences a late answer after ferret navigation', async () => {
    const pending: Array<(value: unknown) => void> = [];
    const client = fakeClient(call =>
      new Promise(resolve => {
        pending.push(value => resolve(value));
      }).then(() => answerFor(call, 'ferret-a')),
    );
    const view = render(<CatalogProbe client={client} ferretId="ferret-a" />);
    run(() => view.update(<CatalogProbe client={{}} ferretId="ferret-b" />));
    for (const resolve of pending) resolve(undefined);

    await flushCatalogs();
    expect(output(view)).toBe('-:-:-:-');
    run(() => view.unmount());
  });

  test('settled() is the read in flight, and nothing once it is done', async () => {
    let latest: ReturnType<typeof useComposerReferenceCatalogs> | undefined;
    const client = fakeClient(call => answerFor(call));
    const view = render(<CatalogProbe client={client} ferretId="ferret-a" onCatalogs={value => (latest = value)} />);
    const inFlight = latest?.settled();
    expect(inFlight).toBeInstanceOf(Promise);
    await flushCatalogs();
    expect(latest?.settled()).toBeUndefined();
    run(() => view.unmount());
  });

  test('refresh reads every prefix again', async () => {
    let latest: ReturnType<typeof useComposerReferenceCatalogs> | undefined;
    const client = fakeClient(call => answerFor(call));
    const view = render(<CatalogProbe client={client} ferretId="ferret-a" onCatalogs={value => (latest = value)} />);
    await flushCatalogs();
    run(() => latest?.refresh());
    await flushCatalogs();
    expect(client.calls).toHaveLength(HOSTED_REFERENCE_PREFIXES.length * 2);
    expect(output(view)).toBe('1:1:1:1');
    run(() => view.unmount());
  });
});

describe('readReferenceCatalog', () => {
  test('sends the query only when there is one', async () => {
    const client = fakeClient(call => answerFor(call));
    const signal = new AbortController().signal;
    await readReferenceCatalog(client, 'ferret-a', '@', signal, 'src');
    await readReferenceCatalog(client, 'ferret-a', '@', signal, '');
    expect(client.calls.map(call => call.query)).toEqual([{ prefix: '@', q: 'src' }, { prefix: '@' }]);
  });

  test('refuses an answer for another prefix', async () => {
    const client = fakeClient(call => ({ ...answerFor(call), prefix: '&' }));
    await expect(readReferenceCatalog(client, 'ferret-a', '!', new AbortController().signal)).rejects.toThrow(
      'the & catalog for !',
    );
  });

  test('never asks when the menu already closed', async () => {
    const client = fakeClient(call => answerFor(call));
    const controller = new AbortController();
    controller.abort(new Error('closed'));
    await expect(readReferenceCatalog(client, 'ferret-a', '!', controller.signal)).rejects.toThrow('closed');
    expect(client.calls).toEqual([]);
  });
});
