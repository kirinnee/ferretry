/**
 * The transcript's attachment strip, ported from
 * `ui/src/components/AttachmentImage.tsx`.
 *
 * Three surfaces, all of them inherited from the original unchanged:
 *
 *  - a THUMBNAIL for anything that renders as an image, which expands into a
 *    real modal `<dialog>` (top layer, backdrop, focus trap) rather than a
 *    hand-rolled overlay;
 *  - a DOCUMENT CARD for everything else, stating the type, the size, whether
 *    text was extracted for the agent, and offering Open/Download once the
 *    bytes have actually arrived;
 *  - a GALLERY that shows `initialLimit` at rest with a "Show N more" control,
 *    because a tool group can attach a lot at once.
 *
 * Loading is lazy: nothing is fetched until the strip is within 320px of the
 * viewport, which is what keeps a long transcript from pulling every
 * attachment it ever mentioned.
 *
 * WHAT CHANGED FOR FERRETRY. The original addressed attachments by
 * `${sessionId}/${attachmentId}` against a page-global client. Attachment ids
 * are daemon-local, so two pairings can name two different files with the same
 * pair of ids, and a cache keyed on that pair would happily hand one daemon's
 * bytes to another. Every read and every cache slot here carries the daemon:
 * `DaemonAttachmentBlobCache` keys on `(daemonId, sessionId, attachmentId)` and
 * the gallery takes the connection as a prop.
 */

import { Download, ExternalLink, FileText, ImageOff, X } from 'lucide-react';
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { useDialogFocus } from '../hooks/use-dialog-focus.ts';
import {
  daemonAttachmentScope,
  DaemonAttachmentBlobCache,
  type AttachmentBlobUrlPort,
  type DaemonAttachmentScope,
} from '../lib/attachment-blob-cache.ts';
import { loadAttachmentBlob } from '../lib/attachment-source.ts';
import {
  attachmentTypeLabel,
  formatAttachmentSize,
  isBrowserOpenableAttachment,
  isImageMime,
  textExtractionFailureCopy,
  type StoredTranscriptAttachment,
  type TranscriptImage,
} from '../lib/attachments.ts';
import { cn } from '../lib/class-names.ts';
import type { DaemonConnection } from '../lib/daemon-connection.ts';
import { daemonSessionScope } from '../lib/daemon-scope.ts';

/** The browser's own object-URL pair, isolated so tests never touch it. */
const browserBlobUrls: AttachmentBlobUrlPort = {
  create: blob => URL.createObjectURL(blob),
  revoke: url => URL.revokeObjectURL(url),
};

/** The daemon read, injected so a test or the visual harness stays offline. */
export type AttachmentBlobLoader = (daemon: DaemonConnection, scope: DaemonAttachmentScope) => Promise<Blob>;

const defaultLoader: AttachmentBlobLoader = (daemon, scope) => loadAttachmentBlob(daemon, scope, scope.attachmentId);

interface GalleryEnvironment {
  readonly cache: DaemonAttachmentBlobCache | null;
  readonly load: AttachmentBlobLoader;
  readonly urls: AttachmentBlobUrlPort;
}

const AttachmentGalleryContext = createContext<GalleryEnvironment>({
  cache: null,
  load: defaultLoader,
  urls: browserBlobUrls,
});

export interface AttachmentGalleryProviderProps {
  children: ReactNode;
  /** Overrides the daemon read; the harness and tests supply their own bytes. */
  load?: AttachmentBlobLoader;
  /** Overrides `URL.createObjectURL`, which jsdom-class DOMs do not implement. */
  urls?: AttachmentBlobUrlPort;
}

/**
 * One shared blob cache for a whole screen. Without it each attachment holds a
 * cache of one and re-fetches on every remount, which is what a virtualised
 * transcript does constantly.
 */
export const AttachmentGalleryProvider = ({
  children,
  load = defaultLoader,
  urls = browserBlobUrls,
}: AttachmentGalleryProviderProps) => {
  const cache = useRef<DaemonAttachmentBlobCache | null>(null);
  cache.current ??= new DaemonAttachmentBlobCache(urls);
  useEffect(() => () => cache.current?.dispose(), []);
  return (
    <AttachmentGalleryContext.Provider value={{ cache: cache.current, load, urls }}>
      {children}
    </AttachmentGalleryContext.Provider>
  );
};

/**
 * The shared cache when a provider is above us, a private one-slot cache when
 * there is not. An attachment rendered outside a provider still has to release
 * its object URL on unmount.
 */
const useAttachmentCache = (): { cache: DaemonAttachmentBlobCache; load: AttachmentBlobLoader } => {
  const environment = useContext(AttachmentGalleryContext);
  const local = useRef<DaemonAttachmentBlobCache | null>(null);
  local.current ??= new DaemonAttachmentBlobCache(environment.urls, 1);
  useEffect(() => () => local.current?.dispose(), []);
  return { cache: environment.cache ?? local.current, load: environment.load };
};

/**
 * True once the element is near the viewport. A DOM without
 * `IntersectionObserver` (and the eager case) reports visible immediately
 * rather than never loading anything.
 */
const useNearViewport = (ref: RefObject<HTMLElement | null>, eager: boolean): boolean => {
  const [visible, setVisible] = useState(eager);
  useEffect(() => {
    if (visible || eager) return;
    const element = ref.current;
    if (!element) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      entries => {
        if (entries.some(entry => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '320px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [eager, ref, visible]);
  return visible;
};

/** An attachment renders as an image when it says so, or when only its name does. */
export const isImageAttachment = (image: TranscriptImage): boolean =>
  image.kind === 'inline' ||
  isImageMime(image.mime) ||
  (!image.mime && /\.(?:png|jpe?g|gif|webp)$/i.test(image.filename));

/**
 * The card's Open/Download affordance, at the original's 44px touch floor.
 *
 * The original rendered one `<a>` whose `href` appeared only once the bytes
 * arrived, marked `aria-disabled` and swallowing its own click until then. A
 * link without an href is not a link — biome's `useValidAnchor` says so and
 * the build agrees — so the element swaps: a real `<a href>` once the blob URL
 * exists, a genuinely `disabled` button before that. Same classes, same dim,
 * same 44px box; the difference is that the pre-load state is now announced as
 * an unavailable control instead of as a link that quietly does nothing.
 */
const ACTION_CLASS =
  'inline-flex min-h-[44px] min-w-[44px] items-center gap-1 rounded-control px-2 text-muted hover:bg-surface hover:text-fg disabled:opacity-50';

interface AttachmentCardProps {
  daemon: DaemonConnection;
  attachment: StoredTranscriptAttachment;
}

const AttachmentDocumentCard = ({ daemon, attachment }: AttachmentCardProps) => {
  const { cache, load } = useAttachmentCache();
  const host = useRef<HTMLDivElement | null>(null);
  const visible = useNearViewport(host, false);
  const [src, setSrc] = useState('');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!visible) return;
    const scope = daemonAttachmentScope(daemonSessionScope(daemon, attachment.sessionId), attachment.attachmentId);
    let active = true;
    setSrc('');
    setFailed(false);
    void cache
      .acquire(scope, () => load(daemon, scope))
      .then(url => {
        if (active) setSrc(url);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
      cache.release(scope);
    };
  }, [attachment.attachmentId, attachment.sessionId, cache, daemon, load, visible]);

  const type = attachmentTypeLabel(attachment.mime);
  const metadata = [attachment.mime, formatAttachmentSize(attachment.size)].filter(Boolean).join(' · ');
  return (
    <div
      ref={host}
      className="flex min-w-0 max-w-full gap-2 rounded-control border border-border-soft bg-surface-2 p-2 text-left"
    >
      <FileText size={18} className="mt-0.5 shrink-0 text-muted" aria-hidden="true" />
      <div className="min-w-0 flex-1 text-meta leading-tight">
        <span className="block truncate text-fg" title={attachment.filename}>
          {attachment.filename}
        </span>
        <span className="block truncate text-faint" title={metadata}>
          {type}
          {metadata ? ` · ${metadata}` : ''}
        </span>
        {attachment.textExtraction && (
          <span className="block text-faint">
            text extracted for agent{attachment.textExtraction.truncated ? ' · truncated' : ''}
          </span>
        )}
        {attachment.textExtractionFailure && (
          <span className="block text-warn" role="status">
            {textExtractionFailureCopy(attachment.textExtractionFailure.code)}
          </span>
        )}
        {failed ? (
          <span className="block text-warn">file could not be opened</span>
        ) : (
          <>
            {!src && (
              <span className="block text-muted" role="status">
                loading file…
              </span>
            )}
            <span className="mt-1 flex flex-wrap gap-1">
              {isBrowserOpenableAttachment(attachment.mime) &&
                (src ? (
                  <a
                    href={src}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={ACTION_CLASS}
                    aria-label={`Open ${attachment.filename}`}
                  >
                    <ExternalLink size={14} aria-hidden="true" /> Open
                  </a>
                ) : (
                  <button type="button" disabled className={ACTION_CLASS} aria-label={`Open ${attachment.filename}`}>
                    <ExternalLink size={14} aria-hidden="true" /> Open
                  </button>
                ))}
              {src ? (
                <a
                  href={src}
                  download={attachment.filename}
                  className={ACTION_CLASS}
                  aria-label={`Download ${attachment.filename}`}
                >
                  <Download size={14} aria-hidden="true" /> Download
                </a>
              ) : (
                <button type="button" disabled className={ACTION_CLASS} aria-label={`Download ${attachment.filename}`}>
                  <Download size={14} aria-hidden="true" /> Download
                </button>
              )}
            </span>
          </>
        )}
      </div>
    </div>
  );
};

interface AttachmentThumbnailProps {
  daemon: DaemonConnection;
  image: TranscriptImage;
}

const AttachmentThumbnail = ({ daemon, image }: AttachmentThumbnailProps) => {
  const { cache, load } = useAttachmentCache();
  const host = useRef<HTMLDivElement | null>(null);
  const visible = useNearViewport(host, image.kind === 'inline');
  const [src, setSrc] = useState(image.kind === 'inline' ? image.src : '');
  const [failed, setFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  // `open` on a <dialog> is modeless. showModal() supplies the real top layer,
  // backdrop, pointer inertness and accessibility modality claimed below.
  // Declared before useDialogFocus so the dialog enters the top layer before
  // that hook moves focus into it.
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!expanded || !src || !dialog) return;
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, [expanded, src]);
  const dialogFocus = useDialogFocus(expanded, dialogRef, () => setExpanded(false));

  useEffect(() => {
    setExpanded(false);
    setFailed(false);
    if (image.kind === 'inline') {
      setSrc(image.src);
      return;
    }
    setSrc('');
    if (!visible) return;
    const scope = daemonAttachmentScope(daemonSessionScope(daemon, image.sessionId), image.attachmentId);
    let active = true;
    void cache
      .acquire(scope, async () => {
        const blob = await load(daemon, scope);
        if (!isImageMime(blob.type)) throw new Error('attachment response was not an image');
        return blob;
      })
      .then(url => {
        if (active) setSrc(url);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
      cache.release(scope);
    };
  }, [cache, daemon, image, load, visible]);

  const filename = image.kind === 'attachment' ? image.filename : image.alt;
  const alt = image.kind === 'attachment' ? (image.alt ?? image.filename) : image.alt;
  const size = image.kind === 'attachment' ? formatAttachmentSize(image.size) : '';

  return (
    <div ref={host} className="min-w-0">
      {failed ? (
        <div className="flex min-h-[72px] min-w-[160px] items-center gap-2 rounded-control border border-border-soft bg-surface-2 px-3 py-2 text-left text-meta text-muted">
          <ImageOff size={18} className="shrink-0" aria-hidden="true" />
          <span className="min-w-0">
            <span className="block truncate text-fg-soft">{filename}</span>
            {size && <span className="block text-faint">{size}</span>}
            <span className="block text-warn">no longer available</span>
          </span>
        </div>
      ) : src ? (
        <button
          type="button"
          className="block min-h-[44px] min-w-[44px] overflow-hidden rounded-control border border-border-soft bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          onClick={() => setExpanded(true)}
          aria-label={`Expand ${alt}`}
        >
          <img
            src={src}
            alt={alt}
            loading="lazy"
            className="max-h-[280px] max-w-full object-contain"
            onError={() => setFailed(true)}
          />
        </button>
      ) : (
        <div
          className="min-h-[72px] min-w-[160px] animate-pulse rounded-control border border-border-soft bg-surface-2 motion-reduce:animate-none"
          role="status"
          aria-label={`Loading ${alt}`}
        />
      )}

      {expanded && src && (
        <dialog
          ref={dialogRef}
          tabIndex={-1}
          aria-modal="true"
          onKeyDown={dialogFocus.onKeyDown}
          className="fixed inset-0 z-50 m-auto max-h-[96dvh] max-w-[96vw] overflow-auto rounded-panel border border-border bg-surface p-2 text-fg shadow-2xl backdrop:bg-black/70"
          aria-label={`Expanded image: ${alt}`}
          onCancel={event => {
            event.preventDefault();
            setExpanded(false);
          }}
          onClose={() => setExpanded(false)}
          onClick={event => {
            if (event.currentTarget === event.target) setExpanded(false);
          }}
        >
          <div className="relative min-h-[44px] min-w-[44px]">
            <button
              type="button"
              className="absolute right-0 top-0 z-10 inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-control border border-border bg-surface/90 text-fg shadow"
              onClick={() => setExpanded(false)}
              aria-label="Close expanded image"
            >
              <X size={18} aria-hidden="true" />
            </button>
            <img src={src} alt={alt} className="h-auto max-h-[90dvh] max-w-[92vw] object-contain" />
          </div>
        </dialog>
      )}
    </div>
  );
};

export interface TranscriptAttachmentGalleryProps {
  /** The pairing that owns every attachment in `images`. */
  daemon: DaemonConnection;
  images: readonly TranscriptImage[];
  /** Tool groups show four at rest; user messages omit this and show all. */
  initialLimit?: number;
  className?: string;
}

/**
 * Stable React keys for a list that may legitimately repeat an attachment.
 *
 * The original disambiguated duplicates with the array index, which makes the
 * key change whenever the list is reordered or an earlier entry is removed —
 * remounting an already-loaded image. Numbering repeats of the same identity
 * instead keeps every key tied to what the entry IS.
 */
const galleryKeys = (images: readonly TranscriptImage[]): string[] => {
  const seen = new Map<string, number>();
  return images.map(image => {
    const identity =
      image.kind === 'attachment'
        ? `${image.sessionId}/${image.attachmentId}`
        : `inline/${image.alt}/${image.src.length}`;
    const repeat = seen.get(identity) ?? 0;
    seen.set(identity, repeat + 1);
    return repeat === 0 ? identity : `${identity}#${repeat}`;
  });
};

export const TranscriptAttachmentGallery = ({
  daemon,
  images,
  initialLimit,
  className,
}: TranscriptAttachmentGalleryProps) => {
  const [showAll, setShowAll] = useState(false);
  if (images.length === 0) return null;
  const visible = initialLimit && !showAll ? images.slice(0, initialLimit) : images;
  const hidden = images.length - visible.length;
  const keys = galleryKeys(visible);
  return (
    <div className={cn('min-w-0 space-y-1.5', className)}>
      <div className="flex min-w-0 flex-wrap items-start gap-2">
        {visible.map((image, index) =>
          image.kind === 'attachment' && !isImageAttachment(image) ? (
            <AttachmentDocumentCard key={keys[index]} daemon={daemon} attachment={image} />
          ) : (
            <AttachmentThumbnail key={keys[index]} daemon={daemon} image={image} />
          ),
        )}
      </div>
      {hidden > 0 && (
        <button
          type="button"
          className="inline-flex min-h-[44px] items-center rounded-control px-2 text-meta text-muted hover:bg-surface-2 hover:text-fg"
          onClick={() => setShowAll(true)}
        >
          Show {hidden} more attachment{hidden === 1 ? '' : 's'}
        </button>
      )}
    </div>
  );
};
