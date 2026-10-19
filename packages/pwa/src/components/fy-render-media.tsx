/**
 * The stage of a `src:` block — a picture, a recording or a document whose
 * bytes live in the session's workspace or behind an https link.
 *
 * IT MOUNTS ONLY AFTER THE READER PRESSES RENDER, like every other decoder in
 * `FyRenderBlock`, so a transcript full of media blocks reads nothing and
 * fetches nothing until somebody asks. Unmounting it — new bytes, Reload,
 * scrolling the row away — aborts any read in flight and revokes the object URL
 * it made.
 *
 * A WORKSPACE FILE IS READ AS THE READER, through one narrow capability:
 * `readWorkspaceMedia(path) → bytes | refusal`, handed down from the session's
 * reference surface. This component never holds a connection, a token, a daemon
 * URL or a session id; the reader resolves the `@path` exactly as an `@file`
 * click does and the daemon's grant check decides it (`docs/grants.md`,
 * `filesystem` _use_). The bytes become a short-lived object URL, so the only
 * address a media element ever sees is a `blob:` this page minted.
 *
 * AN HTTPS SOURCE IS THE READER'S BROWSER TALKING TO A STRANGER, after the
 * gesture, and the consent note says so. `video` and `audio` hand the URL to the
 * native player — the one consumer `media-src https:` admits. `image` does NOT
 * widen `img-src`: Markdown renders `![](url)` as an `<img>` on every surface
 * without a gesture, so a page-wide widening would make every remote image an
 * automatic request. The parent fetches it instead — no credentials, no
 * referrer, capped — runs the same pre-decode admission an inline image passes,
 * and shows the result as a `blob:`. A host that refuses a cross-origin read
 * gets a link instead. `pdf` over https is always a link: embedding it would
 * mean widening `frame-src` for a stranger's document.
 *
 * EVERY REFUSAL IS A CARD THAT SAYS WHICH, never a broken player and never the
 * bytes of a file this reader may not open.
 */
import { Download, ExternalLink } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  FY_RENDER_LIMITS,
  type FyRenderImageMime,
  type FyRenderMediaBlock,
  type FyRenderWorkspaceReader,
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
  | { readonly phase: 'ready'; readonly url: string }
  | { readonly phase: 'link' }
  | { readonly phase: 'fallback'; readonly reason: FyRenderMediaFallback; readonly detail: string | null };

export interface FyRenderMediaProps {
  readonly block: FyRenderMediaBlock;
  /** Absent outside a session workspace; a workspace `src:` then says so rather than guessing. */
  readonly readWorkspaceMedia?: FyRenderWorkspaceReader;
}

const noun: Record<FyRenderMediaBlock['type'], string> = {
  audio: 'recording',
  image: 'picture',
  pdf: 'PDF',
  video: 'video',
};

const megabytes = (bytes: number): string => `${Math.round(bytes / (1024 * 1024))} MB`;

/** The reader's sentence for each card. One fixed sentence per reason, no machine wording. */
const fallbackSentence = (block: FyRenderMediaBlock, reason: FyRenderMediaFallback): string => {
  const what = noun[block.type];
  const where = block.src.kind === 'workspace' ? block.src.path : new URL(block.src.url).host;
  switch (reason) {
    case 'no-workspace':
      return `This ${what} is a file in the session's workspace, which this view cannot read.`;
    case 'missing':
      return `${where} was not found in this session's workspace.`;
    case 'denied':
      return `You do not have access to ${where} in this session's workspace.`;
    case 'not-served':
      return `${where} is not served from this session's workspace — it is gitignored, a protected secret, or outside the folder.`;
    case 'too-large':
      return block.src.kind === 'workspace'
        ? `${where} is larger than the ${megabytes(FY_RENDER_LIMITS.workspaceMediaBytes)} a workspace file can be shown at.`
        : `This ${what} is larger than the ${megabytes(FY_RENDER_LIMITS.httpsImageBytes)} an image link can be shown at.`;
    case 'unsupported':
      return `This ${what} is in a format that cannot be shown here.`;
    case 'unavailable':
      return block.src.kind === 'workspace'
        ? 'The workspace could not be read just now. Reload to try again.'
        : `${where} did not answer with the ${what}. Reload to try again.`;
    case 'blocked':
      return `${where} does not allow this app to show its ${what}. It can still be opened as a link.`;
    case 'decode':
      return `Your browser could not show this ${what}.`;
  }
};

export function FyRenderMedia({ block, readWorkspaceMedia }: FyRenderMediaProps) {
  const [stage, setStage] = useState<Stage>({ phase: 'loading' });

  // biome-ignore lint/correctness/useExhaustiveDependencies: the source is the identity; Reload is a new key
  useEffect(() => {
    const controller = new AbortController();
    let minted: string | null = null;
    const settle = (next: Stage): void => {
      if (!controller.signal.aborted) setStage(next);
    };
    const fallback = (reason: FyRenderMediaFallback, detail: string | null = null): void =>
      settle({ detail, phase: 'fallback', reason });
    /** The one place a `blob:` is made, so the cleanup below is the one place it goes. */
    const show = (bytes: Uint8Array<ArrayBuffer>, type: string): void => {
      if (controller.signal.aborted) return;
      minted = URL.createObjectURL(new Blob([bytes], { type }));
      settle({ phase: 'ready', url: minted });
    };

    const fromWorkspace = async (path: string): Promise<void> => {
      if (readWorkspaceMedia === undefined) return fallback('no-workspace');
      // Decided BEFORE the read, so an unshowable file costs no transfer at all.
      const mime = fyRenderMediaMime(block.type, path);
      if (mime === null) return fallback('unsupported', `No ${block.type} type is known for ${path}`);
      const read = await readWorkspaceMedia(path, controller.signal);
      if (!read.ok) return fallback(read.reason);
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
    if (source.kind === 'workspace') void fromWorkspace(source.path).catch(() => fallback('unavailable'));
    else if (block.type === 'image') void imageFromLink(source.url);
    else if (block.type === 'pdf') setStage({ phase: 'link' });
    else setStage({ phase: 'ready', url: source.url });

    return () => {
      controller.abort();
      if (minted !== null) URL.revokeObjectURL(minted);
    };
  }, [block.source]);

  const decodeFailed = (): void => setStage({ detail: null, phase: 'fallback', reason: 'decode' });
  const link = block.src.kind === 'https' ? block.src.url : null;
  const openLink =
    link === null ? null : (
      <a className="kt-btn kt-btn--sm fy-render-link" href={link} rel="noopener noreferrer" target="_blank">
        <ExternalLink aria-hidden="true" size={14} /> Open {noun[block.type]} link
      </a>
    );

  if (stage.phase === 'loading')
    return (
      <div className="kt-fs-note" data-fy-render-media="loading" role="status">
        Loading the {noun[block.type]}…
      </div>
    );

  if (stage.phase === 'link')
    return (
      <div className="kt-fs-note fy-render-fallback" data-fy-render-media="link">
        <span>This PDF is on {new URL(link as string).host}. It opens in a new tab rather than inside the app.</span>
        {openLink}
      </div>
    );

  if (stage.phase === 'fallback')
    return (
      <div
        className="kt-fs-note fy-render-fallback"
        data-fy-render-fallback={stage.reason}
        data-fy-render-media="fallback"
        data-tone="warn"
      >
        <span role="status">{fallbackSentence(block, stage.reason)}</span>
        {stage.detail === null ? null : (
          <details className="kt-fs-why">
            <summary>Why</summary>
            <p className="kt-fs-why-body fy-render-why-body">{stage.detail}</p>
          </details>
        )}
        {openLink}
      </div>
    );

  switch (block.type) {
    case 'image':
      return (
        <img
          // Empty for the reason `fy-render-block.tsx` gives: the caption names the figure.
          alt=""
          className="kt-rich-file-image fy-render-image"
          data-fy-render-media="image"
          onError={decodeFailed}
          src={stage.url}
        />
      );
    case 'video':
      return (
        // biome-ignore lint/a11y/useMediaCaption: an agent's recording carries no caption track; the figure caption describes it
        <video
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
        // biome-ignore lint/a11y/useMediaCaption: an agent's recording carries no caption track; the figure caption describes it
        <audio
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
         * A CARD, NOT A FRAME, and that is measured rather than preferred. The file
         * preview's shape — a `blob:` in an `<iframe sandbox="">` — shows "This
         * page has been blocked by Chrome": Chromium will not run its PDF viewer
         * in a sandboxed frame, and the app's `default-src 'self'` refuses to frame
         * a `blob:` at all. Making it work means widening `frame-src` AND dropping
         * the sandbox on bytes an agent chose, for a viewer a new tab gives for
         * free. So the admitted bytes stay a `blob:` this page minted and the reader
         * opens or saves it; no daemon URL is ever in the link.
         */
        <div className="kt-fs-note fy-render-fallback" data-fy-render-media="pdf">
          <span>The PDF is ready. It opens in a new tab, where the browser's own viewer shows it.</span>
          <span className="fy-render-links">
            <a className="kt-btn kt-btn--sm fy-render-link" href={stage.url} rel="noopener noreferrer" target="_blank">
              <ExternalLink aria-hidden="true" size={14} /> Open PDF
            </a>
            <a
              className="kt-btn kt-btn--sm fy-render-link"
              download={block.src.kind === 'workspace' ? block.src.path.split('/').at(-1) : 'document.pdf'}
              href={stage.url}
            >
              <Download aria-hidden="true" size={14} /> Download
            </a>
          </span>
        </div>
      );
  }
}
