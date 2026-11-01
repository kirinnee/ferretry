/**
 * THE COMPOSER'S FILES AND PLACE, SHARED WITH THE OWNER'S OTHER DEVICES (&F331 phase 3).
 *
 * The ＋, a drop and a paste still go through ONE flow, `useComposerAttachments`: the file is uploaded
 * from the device it was picked on, exactly as before. What this adds is everything after that:
 *
 * - a file that finished uploading joins the shared draft, so every other device shows its chip;
 * - a chip removed on any device goes from every device;
 * - files another device attached show here too, named by the draft and drawn from the daemon's own
 *   copy, and a send from here names them like any other;
 * - a file still uploading on another device shows here as a placeholder ("uploading on <device>");
 * - the shared place (location) is one item, kept the same way.
 *
 * A file waiting offline for the outbox stays this device's own until it is uploaded: nobody else can
 * fetch bytes that have not reached the daemon.
 */
import type { SharedDraftAttachment, SharedDraftItem, SharedDraftLocation } from '@ferretry/protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SharedDraft } from '../hooks/use-shared-draft.ts';
import { loadAttachmentBlob } from '../lib/attachment-source.ts';
import { isImageMime } from '../lib/attachments.ts';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import type { DaemonSessionScope } from '../lib/daemon-scope.ts';
import type { LocationFix } from '../lib/location-share.ts';
import type { DaemonFetch } from '../lib/runtime-models.ts';
import type { LocationDraft } from './location-chip.tsx';
import type { PendingAttachment } from './session-chat-model.ts';

/** The one place a draft carries. */
export const SHARED_LOCATION_ID = 'location';

const REMOTE_PREFIX = 'shared:';
const UPLOADING_PREFIX = 'uploading:';

const isAttachment = (item: SharedDraftItem): item is SharedDraftAttachment => item.kind === 'attachment';

/** Presence names a file another device is uploading, not its type; its name is the best guess there is. */
const typeFromName = (name: string): string => {
  const extension = name.split('.').at(-1)?.toLowerCase();
  if (extension === 'png' || extension === 'gif' || extension === 'webp') return `image/${extension}`;
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg';
  if (extension === 'pdf') return 'application/pdf';
  return '';
};

const attachmentItem = (entry: PendingAttachment): SharedDraftAttachment | undefined =>
  entry.status === 'ready' && entry.view !== undefined
    ? {
        kind: 'attachment',
        id: entry.view.id,
        name: entry.view.filename,
        mime: entry.view.mime,
        bytes: entry.view.size,
      }
    : undefined;

const locationItem = (fix: LocationFix): SharedDraftLocation => ({
  kind: 'location',
  id: SHARED_LOCATION_ID,
  latitude: fix.latitude,
  longitude: fix.longitude,
  accuracyMeters: fix.accuracyMeters,
  capturedAt: fix.capturedAt,
  ...(fix.place === undefined ? {} : { place: fix.place }),
});

const fixOf = (item: SharedDraftLocation): LocationFix => ({
  latitude: item.latitude,
  longitude: item.longitude,
  accuracyMeters: item.accuracyMeters,
  capturedAt: item.capturedAt,
  ...(item.place === undefined ? {} : { place: item.place }),
});

const sameFix = (a: LocationFix | null, b: LocationFix | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.latitude === b.latitude &&
    a.longitude === b.longitude &&
    a.accuracyMeters === b.accuracyMeters &&
    a.capturedAt === b.capturedAt &&
    a.place === b.place);

/** The few pieces of the attachment flow this needs. */
interface ComposerAttachmentsView {
  readonly entries: readonly PendingAttachment[];
  readonly readyIds: readonly string[];
  readonly remove: (entry: PendingAttachment) => void;
}

/** Object URLs a browser makes; injected so a test can count them. */
interface PreviewUrls {
  create(blob: Blob): string;
  revoke(url: string): void;
}

const browserUrls: PreviewUrls = {
  create: blob => URL.createObjectURL(blob),
  revoke: url => URL.revokeObjectURL(url),
};

export interface UseSharedComposerItemsInput {
  readonly daemon: DaemonConnection;
  readonly scope: DaemonSessionScope;
  readonly shared: SharedDraft;
  readonly attachments: ComposerAttachmentsView;
  readonly location: LocationDraft | null;
  readonly setLocation: (location: LocationDraft | null) => void;
  readonly fetcher?: DaemonFetch;
  readonly urls?: PreviewUrls;
}

export interface SharedComposerItems {
  /** Every chip to draw: this device's files, then the others' files, then their uploads in progress. */
  readonly entries: readonly PendingAttachment[];
  /** Every file a send names, from every device, in the order they were attached. */
  readonly attachmentIds: readonly string[];
  /** Removes a chip here and on every device. */
  readonly remove: (entry: PendingAttachment) => void;
  /** Opens a chip's file; another device's is read from the daemon first. */
  readonly open: (entry: PendingAttachment, show: (file: File) => void) => void;
  /** The message has gone: forget what was shared from here. */
  readonly sent: () => void;
}

/** Pictures another device attached, drawn from the daemon's copy. Revoked when the chip goes. */
function useRemotePreviews(
  daemon: DaemonConnection,
  scope: DaemonSessionScope,
  items: readonly SharedDraftAttachment[],
  fetcher: DaemonFetch | undefined,
  urls: PreviewUrls,
): ReadonlyMap<string, string> {
  const [previews, setPreviews] = useState<ReadonlyMap<string, string>>(new Map());
  const loading = useRef(new Set<string>());
  const live = useRef(previews);
  live.current = previews;
  const wanted = items.filter(item => isImageMime(item.mime)).map(item => item.id);
  /** What is wanted NOW: a load that lands after its chip went is thrown away, not shown. */
  const wantedNow = useRef(new Set(wanted));
  wantedNow.current = new Set(wanted);
  const mounted = useRef(true);
  const urlsNow = useRef(urls);
  urlsNow.current = urls;
  const key = wanted.join('\n');
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` stands for `wanted`, which is new every render
  useEffect(() => {
    for (const [id, url] of live.current)
      if (!wantedNow.current.has(id)) {
        urls.revoke(url);
        setPreviews(map => {
          const next = new Map(map);
          next.delete(id);
          return next;
        });
      }
    for (const id of wantedNow.current) {
      if (live.current.has(id) || loading.current.has(id)) continue;
      loading.current.add(id);
      void loadAttachmentBlob(daemon, scope, id, undefined, ...(fetcher === undefined ? [] : [fetcher]))
        .then(blob => {
          if (!mounted.current || !wantedNow.current.has(id)) return;
          const url = urls.create(blob);
          setPreviews(map => new Map(map).set(id, url));
        })
        .catch(() => {
          // No preview: the chip still names the file, and opening it tries again.
        })
        .finally(() => loading.current.delete(id));
    }
  }, [daemon, fetcher, key, scope, urls]);
  // Everything goes with the composer — and only then: a caller handing in new `urls` is not leaving.
  useEffect(
    () => () => {
      mounted.current = false;
      for (const url of live.current.values()) urlsNow.current.revoke(url);
    },
    [],
  );
  return previews;
}

export function useSharedComposerItems({
  daemon,
  scope,
  shared,
  attachments,
  location,
  setLocation,
  fetcher,
  urls = browserUrls,
}: UseSharedComposerItemsInput): SharedComposerItems {
  const { changeItems, items, reportUploading, uploads } = shared;
  /**
   * This device's files that joined the draft, and whether the draft has shown them back yet. Only one
   * that was seen and then went missing was removed elsewhere — one not seen yet is still on its way.
   */
  const shared_ = useRef(new Map<string, boolean>());
  const syncedFix = useRef<LocationFix | null>(null);
  /**
   * Files uploaded to the session the composer showed BEFORE a switch. The attachment flow forgets them
   * in the same commit, but its state still lists them for this one pass — and sharing one would put a
   * file from one session into another session's draft.
   */
  const before = useRef(new Set<string>());
  const entriesNow = useRef(attachments.entries);
  entriesNow.current = attachments.entries;
  const scopeKey = `${scope.daemonId}\n${scope.sessionId}`;
  const firstScope = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the scope is the reset trigger, not an input
  useEffect(() => {
    shared_.current = new Map();
    syncedFix.current = null;
    if (firstScope.current) {
      firstScope.current = false;
      return;
    }
    before.current = new Set(entriesNow.current.flatMap(entry => (entry.view === undefined ? [] : [entry.view.id])));
  }, [scopeKey]);

  // This device's finished uploads join the draft; one removed on another device goes from here too.
  useEffect(() => {
    const shown = new Set(items.map(item => item.id));
    const add: SharedDraftAttachment[] = [];
    for (const entry of attachments.entries) {
      const item = attachmentItem(entry);
      if (item === undefined || before.current.has(item.id)) continue;
      const seen = shared_.current.get(item.id);
      if (seen === undefined) {
        shared_.current.set(item.id, false);
        add.push(item);
      } else if (shown.has(item.id)) shared_.current.set(item.id, true);
      else if (seen) {
        shared_.current.delete(item.id);
        attachments.remove(entry);
      }
    }
    if (add.length > 0) changeItems({ add });
  }, [attachments, changeItems, items]);

  // The others see what this device is still uploading.
  const uploadingNames = attachments.entries
    .filter(entry => entry.status === 'uploading')
    .map(entry => entry.file.name);
  const uploadingKey = uploadingNames.join('\n');
  // biome-ignore lint/correctness/useExhaustiveDependencies: `uploadingKey` stands for the names
  useEffect(() => {
    reportUploading(uploadingNames);
  }, [reportUploading, uploadingKey]);

  // The place: a change here is sent; a change elsewhere is taken.
  const sharedLocation = items.find((item): item is SharedDraftLocation => item.kind === 'location');
  useEffect(() => {
    const mine = location?.kind === 'ready' ? location.fix : null;
    const theirs = sharedLocation === undefined ? null : fixOf(sharedLocation);
    if (mine !== syncedFix.current) {
      syncedFix.current = mine;
      if (mine === null) changeItems({ remove: [SHARED_LOCATION_ID] });
      else if (!sameFix(mine, theirs)) changeItems({ remove: [SHARED_LOCATION_ID], add: [locationItem(mine)] });
      return;
    }
    if (sameFix(mine, theirs)) return;
    syncedFix.current = theirs;
    setLocation(theirs === null ? null : { kind: 'ready', fix: theirs });
  }, [changeItems, location, setLocation, sharedLocation]);

  const localIds = useMemo(
    () => new Set(attachments.entries.flatMap(entry => (entry.view === undefined ? [] : [entry.view.id]))),
    [attachments.entries],
  );
  const remoteItems = useMemo(
    () => items.filter(isAttachment).filter(item => !localIds.has(item.id)),
    [items, localIds],
  );
  const previews = useRemotePreviews(daemon, scope, remoteItems, fetcher, urls);

  const entries = useMemo((): readonly PendingAttachment[] => {
    const remote = remoteItems.map((item): PendingAttachment => {
      const objectUrl = previews.get(item.id);
      return {
        localId: `${REMOTE_PREFIX}${item.id}`,
        file: new File([], item.name, { type: item.mime }),
        size: item.bytes,
        status: 'ready',
        ...(objectUrl === undefined ? {} : { objectUrl }),
      };
    });
    const placeholders = uploads.map(
      (upload, index): PendingAttachment => ({
        localId: `${UPLOADING_PREFIX}${index}:${upload.device}:${upload.name}`,
        file: new File([], upload.name, { type: typeFromName(upload.name) }),
        status: 'uploading',
        note: `uploading on ${upload.device}`,
        removable: false,
      }),
    );
    return [...attachments.entries, ...remote, ...placeholders];
  }, [attachments.entries, previews, remoteItems, uploads]);

  const attachmentIds = useMemo(
    () => [...new Set([...items.filter(isAttachment).map(item => item.id), ...attachments.readyIds])],
    [attachments.readyIds, items],
  );

  const remove = useCallback(
    (entry: PendingAttachment): void => {
      if (entry.localId.startsWith(UPLOADING_PREFIX)) return;
      if (entry.localId.startsWith(REMOTE_PREFIX)) {
        changeItems({ remove: [entry.localId.slice(REMOTE_PREFIX.length)] });
        return;
      }
      const id = entry.view?.id;
      if (id !== undefined && shared_.current.has(id)) {
        shared_.current.delete(id);
        changeItems({ remove: [id] });
      }
      attachments.remove(entry);
    },
    [attachments, changeItems],
  );

  const open = useCallback(
    (entry: PendingAttachment, show: (file: File) => void): void => {
      if (!entry.localId.startsWith(REMOTE_PREFIX)) {
        show(entry.file);
        return;
      }
      void loadAttachmentBlob(
        daemon,
        scope,
        entry.localId.slice(REMOTE_PREFIX.length),
        undefined,
        ...(fetcher === undefined ? [] : [fetcher]),
      )
        .then(blob => show(new File([blob], entry.file.name, { type: entry.file.type })))
        .catch(() => {
          // It could not be read just now; the chip stays, and a second tap tries again.
        });
    },
    [daemon, fetcher, scope],
  );

  const sent = useCallback((): void => {
    shared_.current = new Map();
    syncedFix.current = null;
  }, []);

  return { entries, attachmentIds, remove, open, sent };
}
