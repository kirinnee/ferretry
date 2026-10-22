/**
 * The stage of a `src:` block — a picture, a recording or a document whose
 * bytes live in the session's workspace or behind an https link.
 *
 * IT MOUNTS ONCE THE BLOCK IS NEAR THE VIEWPORT, like every other decoder in
 * `FyRenderBlock`, so a long transcript reads and fetches only what a reader
 * scrolls toward. Unmounting it — new bytes, a retry — aborts any read in flight
 * and revokes the object URL it made.
 *
 * A WORKSPACE FILE IS READ AS THE READER, through one narrow capability:
 * `readWorkspaceMedia(path) → bytes | refusal`, handed down from the session's
 * reference surface. This component never holds a connection, a token, a daemon
 * URL or a session id; the reader resolves the `@path` exactly as an `@file`
 * click does and the daemon's grant check decides it (`docs/grants.md`,
 * `filesystem` _use_). The bytes become a short-lived object URL, so the only
 * address a media element ever sees is a `blob:` this page minted.
 *
 * AN HTTPS SOURCE IS THE READER'S BROWSER TALKING TO A STRANGER, and with the
 * gesture gone it does so as soon as the block is near — `docs/fy-render.md`
 * says so plainly. `video` and `audio` hand the URL to the native player — the
 * one consumer `media-src https:` admits. `image` does NOT widen `img-src`:
 * Markdown renders `![](url)` as an `<img>` on every surface, so a page-wide
 * widening would make every remote image an automatic request. The parent fetches
 * it instead — no credentials, no referrer, capped — runs the same pre-decode
 * admission an inline image passes, and shows the result as a `blob:`. A host
 * that refuses a cross-origin read gets a link instead. `pdf` over https is
 * always a link: embedding it would mean widening `frame-src` for a stranger's
 * document, and a link fetches nothing until it is followed.
 *
 * A PDF AND EVERY REFUSAL ARE A FILE ROW, never a broken player and never the
 * bytes of a file this reader may not open.
 */
import { Download, ExternalLink, FileText, FileWarning } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { ExternalLink as ExternalAnchor } from '../features/browser/external-link.tsx';
import {
  FY_RENDER_LIMITS,
  type FyRenderImageMime,
  type FyRenderMediaBlock,
  type FyRenderWorkspaceReader,
  type FyRenderWorkspaceScope,
  fyRenderMediaMime,
  fyRenderRasterRefusal,
  fyRenderReadBoundedBytes,
} from '../lib/fy-render.ts';

/** Why a block shows a card instead of its media, as a closed set. */
export type FyRenderMediaFallback =
  | 'no-workspace'
  | 'missing'
  | 'denied'
  | 'not-served'
  | 'too-large'
  | 'unsupported'
  | 'unavailable'
  | 'blocked'
  | 'decode';

type Stage =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly url: string; readonly bytes: number | null }
  | { readonly phase: 'link' }
  | {
      readonly phase: 'fallback';
      readonly reason: FyRenderMediaFallback;
      readonly detail: string | null;
      /** The daemon's rule, for a `not-served` refusal: said in the sentence, never folded away. */
      readonly rule?: string;
    };

export interface FyRenderMediaProps {
  readonly block: FyRenderMediaBlock;
  /** Absent outside a session workspace; a workspace `src:` then says so rather than guessing. */
  readonly readWorkspaceMedia?: FyRenderWorkspaceReader;
  /** Told whether this stage is a compact file row rather than a picture or a player. */
  readonly onShape?: (row: boolean) => void;
}

const noun: Record<FyRenderMediaBlock['type'], string> = {
  audio: 'recording',
  image: 'picture',
  pdf: 'PDF',
  video: 'video',
};

const megabytes = (bytes: number): string => `${Math.round(bytes / (1024 * 1024))} MB`;

/** Rounded to whole units — a reader is sizing a file, not auditing bytes. */
const humanBytes = (bytes: number): string =>
  bytes >= 1024 * 1024 ? megabytes(bytes) : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} bytes`;

/** The name a row shows: the workspace file's own, or the last segment of a link. */
const fileName = (block: FyRenderMediaBlock): string => {
  const path = block.src.kind === 'https' ? new URL(block.src.url).pathname : block.src.path;
  const last = path.split('/').filter(Boolean).at(-1);
  return last === undefined ? noun[block.type] : decodeURIComponentSafe(last);
};

const decodeURIComponentSafe = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/** A row action. Styled in `fy-render.css`, after the attachment card's, at the pointer-derived touch floor. */
const ROW_ACTION = 'fy-render-row-action';

/** The reader's sentence for each card. One fixed sentence per reason, no machine wording. */
const fallbackSentence = (block: FyRenderMediaBlock, reason: FyRenderMediaFallback, rule?: string): string => {
  const what = noun[block.type];
  const where = block.src.kind === 'https' ? new URL(block.src.url).host : block.src.path;
  /** The session's working tree, or its media folder — said as the reader would say it. */
  const folder = block.src.kind === 'media' ? "this session's media folder" : "this session's workspace";
  switch (reason) {
    case 'no-workspace':
      return `This ${what} is a file in ${folder}, which this view cannot read.`;
    case 'missing':
      return `${where} was not found in ${folder}.`;
    case 'denied':
      return `You do not have access to ${where} in ${folder}.`;
    case 'not-served':
      // THE RULE, SAID. "Gitignored, a secret, or outside the folder" left the reader — and the agent
      // that wrote the file — guessing which of three very different things had happened.
      return rule === undefined
        ? `${where} is not served from ${folder}.`
        : `${where} is not served from ${folder}: ${rule}.`;
    case 'too-large':
      return block.src.kind === 'https'
        ? `This ${what} is larger than the ${megabytes(FY_RENDER_LIMITS.httpsImageBytes)} an image link can be shown at.`
        : `${where} is larger than the ${megabytes(FY_RENDER_LIMITS.workspaceMediaBytes)} a workspace file can be shown at.`;
    case 'unsupported':
      return `This ${what} is in a format that cannot be shown here.`;
    case 'unavailable':
      return block.src.kind !== 'https'
        ? 'The workspace could not be read just now.'
        : `${where} did not answer with the ${what}.`;
    case 'blocked':
      return `${where} does not allow this app to show its ${what}. It can still be opened as a link.`;
    case 'decode':
      return `Your browser could not show this ${what}.`;
  }
};

export function FyRenderMedia({ block, readWorkspaceMedia, onShape }: FyRenderMediaProps) {
  const [stage, setStage] = useState<Stage>({ phase: 'loading' });

  // biome-ignore lint/correctness/useExhaustiveDependencies: the source is the identity; Reload is a new key
  useEffect(() => {
    const controller = new AbortController();
    let minted: string | null = null;
    const settle = (next: Stage): void => {
      if (!controller.signal.aborted) setStage(next);
    };
    const fallback = (reason: FyRenderMediaFallback, detail: string | null = null, rule?: string): void =>
      settle({ detail, phase: 'fallback', reason, ...(rule === undefined ? {} : { rule }) });
    /** The one place a `blob:` is made, so the cleanup below is the one place it goes. */
    const show = (bytes: Uint8Array<ArrayBuffer>, type: string): void => {
      if (controller.signal.aborted) return;
      minted = URL.createObjectURL(new Blob([bytes], { type }));
      settle({ bytes: bytes.byteLength, phase: 'ready', url: minted });
    };

    const fromWorkspace = async (path: string, folder: FyRenderWorkspaceScope): Promise<void> => {
      if (readWorkspaceMedia === undefined) return fallback('no-workspace');
      // Decided BEFORE the read, so an unshowable file costs no transfer at all.
      const mime = fyRenderMediaMime(block.type, path);
      if (mime === null) return fallback('unsupported', `No ${block.type} type is known for ${path}`);
      const read = await readWorkspaceMedia(path, controller.signal, folder);
      if (!read.ok) return fallback(read.reason, null, read.rule);
      if (read.bytes.byteLength > FY_RENDER_LIMITS.workspaceMediaBytes) return fallback('too-large');
      if (block.type === 'image') {
        const refusal = fyRenderRasterRefusal(read.bytes, mime as FyRenderImageMime);
        if (refusal !== null) return fallback('unsupported', refusal);
      }
      show(read.bytes, mime);
    };

    const imageFromLink = async (url: string): Promise<void> => {
      let response: Response;
      try {
        /**
         * A stranger's server, so nothing of this app rides along: no cookie
         * (`credentials: 'omit'`), no address of the conversation
         * (`referrerPolicy: 'no-referrer'`). `cors` is the default and is the
         * point — a host that has not opted in to being read refuses, and the
         * reader gets the link instead of a workaround.
         */
        response = await fetch(url, {
          credentials: 'omit',
          mode: 'cors',
          referrerPolicy: 'no-referrer',
          signal: controller.signal,
        });
      } catch (error) {
        return fallback('blocked', error instanceof Error ? error.message : null);
      }
      if (!response.ok) return fallback('unavailable', `HTTP ${response.status}`);
      const read = await fyRenderReadBoundedBytes(response, FY_RENDER_LIMITS.httpsImageBytes, 'image');
      if (!read.ok) return fallback(read.reason.endsWith('too large') ? 'too-large' : 'unavailable', read.reason);
      const refusal = fyRenderRasterRefusal(read.bytes, null);
      if (refusal !== null) return fallback('unsupported', refusal);
      show(read.bytes, '');
    };

    const source = block.src;
    if (source.kind !== 'https') void fromWorkspace(source.path, source.kind).catch(() => fallback('unavailable'));
    else if (block.type === 'image') void imageFromLink(source.url);
    else if (block.type === 'pdf') setStage({ phase: 'link' });
    else setStage({ bytes: null, phase: 'ready', url: source.url });

    return () => {
      controller.abort();
      if (minted !== null) URL.revokeObjectURL(minted);
    };
  }, [block.source]);

  const decodeFailed = (): void => setStage({ detail: null, phase: 'fallback', reason: 'decode' });
  const link = block.src.kind === 'https' ? block.src.url : null;
  const row = block.type === 'pdf' || stage.phase === 'fallback' || stage.phase === 'link';
  useEffect(() => onShape?.(row), [onShape, row]);

  /**
   * A FILE ROW, the shape an attachment already has in this transcript: an icon,
   * the file's name, one muted line of facts, and the actions. A PDF is always
   * one; so is every refusal, so a file this reader cannot see reads as a file
   * that is not there rather than as a broken player.
   */
  const fileRow = (props: {
    readonly icon: 'file' | 'warning';
    readonly meta: string;
    readonly detail?: string | null;
    readonly children?: ReactNode;
  }) => (
    <div className="fy-render-row" data-fy-render-row="true" title={props.detail ?? undefined}>
      {props.icon === 'file' ? (
        <FileText aria-hidden="true" className="fy-render-row-icon" size={18} />
      ) : (
        <FileWarning aria-hidden="true" className="fy-render-row-icon" data-tone="warn" size={18} />
      )}
      <div className="fy-render-row-body">
        <span className="fy-render-row-name" title={fileName(block)}>
          {fileName(block)}
        </span>
        <span className="fy-render-row-meta">{props.meta}</span>
        {props.children === undefined ? null : <span className="fy-render-row-actions">{props.children}</span>}
      </div>
    </div>
  );

  const openAction = (href: string, label: string) => (
    <ExternalAnchor aria-label={`${label} ${fileName(block)}`} className={ROW_ACTION} href={href}>
      <ExternalLink aria-hidden="true" size={14} /> {label}
    </ExternalAnchor>
  );

  if (stage.phase === 'loading')
    return block.type === 'pdf' ? (
      fileRow({ icon: 'file', meta: 'PDF · loading…' })
    ) : (
      // A quiet plane where the picture or player will be, so the prose under it does not jump.
      <div aria-hidden="true" className="fy-render-placeholder" data-fy-render-media="loading" />
    );

  if (stage.phase === 'link')
    return (
      <div data-fy-render-media="link">
        {fileRow({
          children: openAction(link as string, 'Open'),
          icon: 'file',
          meta: `PDF · ${new URL(link as string).host}`,
        })}
      </div>
    );

  if (stage.phase === 'fallback')
    return (
      <div data-fy-render-fallback={stage.reason} data-fy-render-media="fallback">
        {fileRow({
          children: link === null ? undefined : openAction(link, 'Open link'),
          detail: stage.detail,
          icon: 'warning',
          meta: fallbackSentence(block, stage.reason, stage.rule),
        })}
      </div>
    );

  switch (block.type) {
    case 'image':
      return (
        <img
          alt={block.alt}
          className="fy-render-image"
          data-fy-render-media="image"
          onError={decodeFailed}
          src={stage.url}
        />
      );
    case 'video':
      return (
        // biome-ignore lint/a11y/useMediaCaption: an agent's recording carries no caption track; the label describes it
        <video
          aria-label={block.alt}
          className="fy-render-video"
          controls
          data-fy-render-media="video"
          onError={decodeFailed}
          playsInline
          preload="metadata"
          src={stage.url}
        />
      );
    case 'audio':
      return (
        // biome-ignore lint/a11y/useMediaCaption: an agent's recording carries no caption track; the label describes it
        <audio
          aria-label={block.alt}
          className="fy-render-audio"
          controls
          data-fy-render-media="audio"
          onError={decodeFailed}
          preload="metadata"
          src={stage.url}
        />
      );
    case 'pdf':
      return (
        /**
         * A ROW, NOT A FRAME, and that is measured rather than preferred. A `blob:`
         * in an `<iframe sandbox="">` shows "This page has been blocked by Chrome":
         * Chromium will not run its PDF viewer in a sandboxed frame, and the app's
         * `default-src 'self'` refuses to frame a `blob:` at all. So the admitted
         * bytes stay a `blob:` this page minted and the reader opens or saves it in
         * the browser's own viewer; no daemon URL is ever in the link.
         */
        <div data-fy-render-media="pdf">
          {fileRow({
            children: (
              <>
                {openAction(stage.url, 'Open')}
                <a
                  aria-label={`Download ${fileName(block)}`}
                  className={ROW_ACTION}
                  download={fileName(block)}
                  href={stage.url}
                >
                  <Download aria-hidden="true" size={14} /> Download
                </a>
              </>
            ),
            icon: 'file',
            meta: stage.bytes === null ? 'PDF' : `PDF · ${humanBytes(stage.bytes)}`,
          })}
        </div>
      );
  }
}
