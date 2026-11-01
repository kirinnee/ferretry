import { describe, expect, test } from 'bun:test';
import type { AttachmentView, SharedDraftItem } from '@ferretry/protocol';
import { useState } from 'react';
import {
  SHARED_LOCATION_ID,
  type SharedComposerItems,
  useSharedComposerItems,
} from '../../src/components/composer-shared-items.ts';
import type { LocationDraft } from '../../src/components/location-chip.tsx';
import type { PendingAttachment } from '../../src/components/session-chat-model.ts';
import type { SharedDraft, SharedDraftRemoteUpload } from '../../src/hooks/use-shared-draft.ts';
import { daemonConnection } from '../../src/lib/daemon-connection.ts';
import { daemonSessionScope } from '../../src/lib/daemon-scope.ts';
import '../support/dom.ts';
import { render, run, runAsync } from '../support/react.ts';
import { settleUntil } from '../support/settle.ts';

const daemon = daemonConnection({ daemonId: 'items', baseUrl: 'https://items.example.test', deviceId: 'device' });

const view = (id: string, filename = `${id}.png`, mime = 'image/png'): AttachmentView => ({
  id,
  filename,
  mime,
  size: 2048,
  sha256: 'a'.repeat(64),
  createdAt: '2026-11-01T00:00:00.000Z',
});

const entry = (localId: string, status: PendingAttachment['status'], attached?: AttachmentView): PendingAttachment => ({
  localId,
  file: new File([new Uint8Array([1])], attached?.filename ?? `${localId}.png`, { type: 'image/png' }),
  status,
  ...(attached === undefined ? {} : { view: attached }),
});

const photo = (id: string, name = `${id}.png`, mime = 'image/png'): SharedDraftItem => ({
  kind: 'attachment',
  id,
  name,
  mime,
  bytes: 2048,
});

const settle = async (): Promise<void> =>
  await runAsync(async () => {
    for (let index = 0; index < 10; index += 1) await Promise.resolve();
  });

/**
 * The composer's view of the world, every piece of it under the test's hand: the shared draft's items
 * (as every device agrees on them), this device's attachment entries, its place, and the session.
 */
const mount = (
  options: {
    readonly entries?: readonly PendingAttachment[];
    readonly items?: readonly SharedDraftItem[];
    readonly uploads?: readonly SharedDraftRemoteUpload[];
    readonly fetcher?: (input: RequestInfo | URL) => Promise<Response>;
  } = {},
) => {
  const changes: { add?: readonly SharedDraftItem[]; remove?: readonly string[] }[] = [];
  const reported: (readonly string[])[] = [];
  const removedLocally: string[] = [];
  const urls = { made: 0, revoked: [] as string[] };
  const world: {
    items?: SharedComposerItems;
    setItems?: (items: readonly SharedDraftItem[]) => void;
    setEntries?: (entries: readonly PendingAttachment[]) => void;
    setUploads?: (uploads: readonly SharedDraftRemoteUpload[]) => void;
    setSession?: (sessionId: string) => void;
    location?: LocationDraft | null;
    setLocation?: (location: LocationDraft | null) => void;
  } = {};
  const Composer = () => {
    const [items, setItems] = useState(options.items ?? []);
    const [entries, setEntries] = useState(options.entries ?? []);
    const [uploads, setUploads] = useState(options.uploads ?? []);
    const [sessionId, setSession] = useState('s1');
    const [location, setLocation] = useState<LocationDraft | null>(null);
    Object.assign(world, { setItems, setEntries, setUploads, setSession, location, setLocation });
    const shared = {
      items,
      uploads,
      changeItems: change => {
        changes.push(change);
        setItems(current => [
          ...current.filter(item => !(change.remove ?? []).includes(item.id)),
          ...(change.add ?? []).filter(
            item => !current.some(existing => existing.id === item.id && !(change.remove ?? []).includes(item.id)),
          ),
        ]);
      },
      reportUploading: names => reported.push(names),
    } as Pick<SharedDraft, 'items' | 'uploads' | 'changeItems' | 'reportUploading'> as SharedDraft;
    world.items = useSharedComposerItems({
      daemon,
      scope: daemonSessionScope(daemon, sessionId),
      shared,
      attachments: {
        entries,
        readyIds: entries.flatMap(each => (each.status === 'ready' && each.view !== undefined ? [each.view.id] : [])),
        remove: gone => {
          removedLocally.push(gone.localId);
          setEntries(current => current.filter(each => each.localId !== gone.localId));
        },
      },
      location,
      setLocation,
      ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher as never }),
      urls: {
        create: () => `blob:preview-${++urls.made}`,
        revoke: url => urls.revoked.push(url),
      },
    });
    return null;
  };
  const root = render(<Composer />);
  const items = (): SharedComposerItems => {
    if (world.items === undefined) throw new Error('not rendered');
    return world.items;
  };
  return { world, items, changes, reported, removedLocally, urls, root };
};

const download = (id: string) => Response.json({ attachment: view(id), base64: 'aGk=' });

describe('useSharedComposerItems', () => {
  test("puts this device's finished upload into the shared draft, once", async () => {
    const { world, changes, root } = mount({ entries: [entry('l1', 'uploading')] });
    await settle();
    expect(changes).toEqual([]);

    run(() => world.setEntries?.([entry('l1', 'ready', view('att_1'))]));
    await settle();

    expect(changes).toEqual([{ add: [photo('att_1')] }]);
    run(() => root.unmount());
  });

  test("shows another device's files as chips, with the daemon's copy as the picture, and sends them too", async () => {
    // Arrange
    const asked: string[] = [];
    const { items, root, urls, world } = mount({
      entries: [entry('l1', 'ready', view('mine'))],
      items: [photo('mine'), photo('theirs', 'screenshot.png'), photo('doc', 'notes.pdf', 'application/pdf')],
      fetcher: async input => {
        asked.push(String(input));
        return download('theirs');
      },
    });
    await settleUntil(
      () => items().entries.some(each => each.objectUrl !== undefined),
      'the picture from the daemon',
      runAsync,
    );

    // Assert
    const remote = items().entries.filter(each => each.localId.startsWith('shared:'));
    expect(remote.map(each => [each.file.name, each.size, each.objectUrl])).toEqual([
      ['screenshot.png', 2048, 'blob:preview-1'],
      ['notes.pdf', 2048, undefined],
    ]);
    // Only the picture is fetched for a preview.
    expect(asked).toEqual(['https://items.example.test/v1/sessions/s1/attachments/theirs']);
    expect(items().attachmentIds).toEqual(['mine', 'theirs', 'doc']);

    // The picture is let go the moment its chip goes, not only when the composer does.
    run(() => world.setItems?.([photo('mine'), photo('doc', 'notes.pdf', 'application/pdf')]));
    await settle();
    expect(urls.revoked).toEqual(['blob:preview-1']);
    expect(items().entries.some(each => each.objectUrl !== undefined)).toBe(false);
    run(() => root.unmount());
  });

  test('removing a chip removes it on every device; a file removed elsewhere goes from here too', async () => {
    // Arrange — this device's file, already seen back in the draft, and another device's.
    const { world, items, changes, removedLocally, root } = mount({
      entries: [entry('l1', 'ready', view('mine'))],
      items: [photo('theirs')],
      fetcher: async () => download('theirs'),
    });
    await settle();
    await settle();

    // Act — remove theirs here; then another device removes mine.
    const theirs = items().entries.find(each => each.localId === 'shared:theirs') as PendingAttachment;
    run(() => items().remove(theirs));
    run(() => world.setItems?.([]));
    await settle();

    // Assert
    expect(changes).toEqual([{ add: [photo('mine')] }, { remove: ['theirs'] }]);
    expect(removedLocally).toEqual(['l1']);
    run(() => root.unmount());
  });

  test("removes this device's own shared file everywhere, and an unshared one only here", async () => {
    const { items, changes, removedLocally, root } = mount({
      entries: [entry('l1', 'ready', view('mine')), entry('l2', 'failed')],
    });
    await settle();
    const [mine, failed] = items().entries as [PendingAttachment, PendingAttachment];

    run(() => items().remove(failed));
    run(() => items().remove(mine));

    expect(changes).toEqual([{ add: [photo('mine')] }, { remove: ['mine'] }]);
    expect(removedLocally).toEqual(['l2', 'l1']);
    run(() => root.unmount());
  });

  test("shows another device's uploads as placeholders nobody here can remove, and tells the others about its own", async () => {
    const { items, reported, changes, root } = mount({
      entries: [entry('l1', 'uploading')],
      uploads: [
        { device: 'Kirin’s iPhone', name: 'photo.JPG' },
        { device: 'Kirin’s iPhone', name: 'spec.pdf' },
        { device: 'Kirin’s iPhone', name: 'notes' },
        { device: 'Kirin’s iPhone', name: 'network-trace.png' },
      ],
    });
    await settle();

    // Its type is guessed from its name, which is all presence carries.
    expect(
      items()
        .entries.slice(1)
        .map(each => each.file.type),
    ).toEqual(['image/jpeg', 'application/pdf', '', 'image/png']);
    const placeholder = items().entries.at(-1) as PendingAttachment;
    expect(placeholder).toMatchObject({ status: 'uploading', note: 'uploading on Kirin’s iPhone', removable: false });
    run(() => items().remove(placeholder));
    expect(changes).toEqual([]);
    expect(reported).toEqual([['l1.png']]);
    run(() => root.unmount());
  });

  test('opens another device’s document by reading it from the daemon; this device’s own as it is', async () => {
    const shown: File[] = [];
    const { items, root } = mount({
      entries: [entry('l1', 'ready', view('mine'))],
      items: [photo('doc', 'notes.pdf', 'application/pdf')],
      fetcher: async () => download('doc'),
    });
    await settle();
    const doc = items().entries.find(each => each.localId === 'shared:doc') as PendingAttachment;
    const mine = items().entries[0] as PendingAttachment;

    await runAsync(async () => items().open(doc, file => shown.push(file)));
    await settleUntil(() => shown.length === 1, 'the document from the daemon', runAsync);
    run(() => items().open(mine, file => shown.push(file)));

    expect(shown.map(file => [file.name, file.size])).toEqual([
      ['notes.pdf', 2],
      ['mine.png', 1],
    ]);
    run(() => root.unmount());
  });

  test('a document that cannot be read just now leaves the chip as it is', async () => {
    const shown: File[] = [];
    const { items, root } = mount({
      items: [photo('doc', 'notes.pdf', 'application/pdf'), photo('pic')],
      fetcher: async () => new Response('nope', { status: 500 }),
    });
    await settle();
    const doc = items().entries.find(each => each.localId === 'shared:doc') as PendingAttachment;
    await runAsync(async () => items().open(doc, file => shown.push(file)));
    await settle();
    expect(shown).toEqual([]);
    expect(items().entries.find(each => each.localId === 'shared:pic')?.objectUrl).toBeUndefined();
    run(() => root.unmount());
  });

  test('never shares a file from the session the composer showed before a switch', async () => {
    const { world, changes, root } = mount({ entries: [entry('l1', 'ready', view('old'))] });
    await settle();

    run(() => world.setSession?.('s2'));
    await settle();
    run(() => world.setEntries?.([entry('l2', 'ready', view('new'))]));
    await settle();

    expect(changes).toEqual([{ add: [photo('old')] }, { add: [photo('new')] }]);
    run(() => root.unmount());
  });

  test('shares the place picked here, takes a place picked elsewhere, and clears it when either removes it', async () => {
    // Arrange
    const fix = { latitude: 1.29, longitude: 103.85, accuracyMeters: 12, capturedAt: 5 };
    const { world, changes, root } = mount();
    await settle();

    // Act — this device picks a place, then names it.
    run(() => world.setLocation?.({ kind: 'ready', fix }));
    await settle();
    run(() => world.setLocation?.({ kind: 'ready', fix: { ...fix, place: 'office' } }));
    await settle();

    // Assert
    const item = { kind: 'location' as const, id: SHARED_LOCATION_ID, ...fix };
    expect(changes).toEqual([
      { remove: [SHARED_LOCATION_ID], add: [item] },
      { remove: [SHARED_LOCATION_ID], add: [{ ...item, place: 'office' }] },
    ]);

    // Another device moves it; then removes it.
    run(() => world.setItems?.([{ ...item, latitude: 2, place: 'home' } as SharedDraftItem]));
    await settle();
    expect(world.location).toEqual({ kind: 'ready', fix: { ...fix, latitude: 2, place: 'home' } });
    run(() => world.setItems?.([]));
    await settle();
    expect(world.location).toBeNull();

    // Removed here: it goes everywhere.
    run(() => world.setLocation?.({ kind: 'ready', fix }));
    await settle();
    run(() => world.setLocation?.(null));
    await settle();
    expect(changes.at(-1)).toEqual({ remove: [SHARED_LOCATION_ID] });
    run(() => root.unmount());
  });

  test('forgets what it shared once the message is sent', async () => {
    const { world, items, changes, root } = mount({ entries: [entry('l1', 'ready', view('a'))] });
    await settle();
    run(() => items().sent());
    run(() => world.setEntries?.([]));
    run(() => world.setItems?.([]));
    await settle();
    run(() => world.setEntries?.([entry('l2', 'ready', view('a'))]));
    await settle();
    expect(changes).toEqual([{ add: [photo('a')] }, { add: [photo('a')] }]);
    run(() => root.unmount());
  });
});
