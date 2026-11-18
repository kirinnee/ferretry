/**
 * A PICTURE THAT OPENS FULL-SIZE. The owner's ask: "i need picture that can zoom — is that a low res image?"
 *
 * An image in a message is drawn at the column's width and at most 60% of the screen, so a large picture is
 * a shrunken copy of itself and a reader cannot tell whether it is sharp. This wraps that same `<img>` in a
 * button; pressing it (tap, click, or Enter / Space) opens THE APP'S ONE VIEWER (`ImageViewer`, the same
 * lightbox a composer chip opens) on the SAME bytes — no second, downscaled copy is made, and the `src` is
 * the one the inline picture already holds. The viewer reads its natural resolution from that picture itself
 * and says it ("33% · 3000×2000"), with Zoom in / out, Fit and Actual size beside the wheel, pinch, drag and
 * double tap.
 *
 * This file owns only the trigger and what is specific to a message picture:
 *   - focus returns to the picture button when the viewer closes (by hand too, because Safari does not focus
 *     a button on a tap and the viewer can only restore what it saw focused);
 *   - a `data:` picture is not offered "Open in a new tab" (a browser refuses to navigate to one);
 *   - THE SINK IS UNCHANGED: the viewer's `<img>` takes the URL the inline one was given — a `blob:` this page
 *     minted or the block's own `data:` URL — so nothing new reaches the page and no CSP widens.
 */

import { ImageViewer, type ViewerImage } from '@ferretry/app/ui';
import { type ImgHTMLAttributes, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import './fy-render-image-zoom.css';

const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
};

/** What a saved copy is called: the picture's own description, with the extension its `data:` mime names. */
const downloadName = (alt: string, src: string): string => {
  const base =
    alt
      .trim()
      .replace(/[\\/:*?"<>|]+/gu, ' ')
      .slice(0, 80)
      .trim() || 'picture';
  const mime = /^data:([^;,]+)/u.exec(src)?.[1];
  const extension = mime === undefined ? undefined : EXTENSIONS[mime];
  return extension === undefined ? base : `${base}.${extension}`;
};

const noIndexChange = (): void => undefined;

export interface FyRenderZoomImageProps
  extends Pick<ImgHTMLAttributes<HTMLImageElement>, 'alt' | 'className' | 'onError' | 'src'> {
  readonly alt: string;
  readonly src: string;
  /** Carried onto the inline `<img>` so a test or a screenshot can find which stage drew it. */
  readonly 'data-fy-render-media'?: string;
}

/** An inline picture that opens in the viewer. The `<img>` it renders is the one the caller would have. */
export function FyRenderZoomImage({ alt, className, onError, src, ...rest }: FyRenderZoomImageProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const close = useCallback(() => setOpen(false), []);
  const images = useMemo<readonly ViewerImage[]>(
    () => [
      {
        alt,
        failed: false,
        filename: downloadName(alt, src),
        key: src,
        openable: !src.startsWith('data:'),
        src,
      },
    ],
    [alt, src],
  );

  const wasOpen = useRef(false);
  useLayoutEffect(() => {
    if (wasOpen.current && !open) triggerRef.current?.focus();
    wasOpen.current = open;
  }, [open]);

  return (
    <>
      <button
        aria-haspopup="dialog"
        aria-label={`Open full size: ${alt}`}
        className="fy-zoom-open"
        data-fy-render-zoom-trigger="true"
        onClick={() => setOpen(true)}
        ref={triggerRef}
        type="button"
      >
        <img alt={alt} className={className} onError={onError} src={src} {...rest} />
      </button>
      {open ? <ImageViewer images={images} index={0} onClose={close} onIndexChange={noIndexChange} /> : null}
    </>
  );
}
