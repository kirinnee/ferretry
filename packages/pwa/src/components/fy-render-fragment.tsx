/**
 * An `html` block, rendered as a STATIC FRAGMENT directly in the message.
 *
 * THE OWNER'S DECISION: "no need to render full HTML — just render HTML fragments that don't allow
 * scripts, directly." So nothing an agent writes here runs. There is no frame, no shell and no
 * message port; the markup is sanitized by DOMPurify against a strict allowlist and the result is
 * appended as DOM NODES into a closed shadow root that is part of the message.
 *
 * WHAT IS STRIPPED, and every line of it is enforced by the sanitizer configured below rather than by
 * review: every `<script>` and every element that can run, frame, submit or reconfigure the document —
 * `iframe`, `frame`, `object`, `embed`, `portal`, `form` and its controls, `base`, `meta`, `link`,
 * `template` — plus SVG's `foreignObject`, `use` and SMIL animation. Every `on*` handler. Every URL
 * that is not plainly one of three things: an `https:` link (which opens a new tab, `noopener
 * noreferrer`), a `data:image/` picture, or `media:<file>` from the session's media folder, which is
 * read through the reader's own grant and shown as a `blob:` this page minted. `javascript:`, other
 * `data:` and every relative or same-origin URL are dropped — a fragment has no business addressing the
 * app. In CSS, inline or in a `<style>`, `@import` and every `url(…)` or `image-set(…)` that is not a
 * `data:image/` are neutralised, so styling cannot fetch anything either.
 *
 * WHAT CONTAINS WHAT IS LEFT. The closed shadow root keeps the fragment's `<style>` from reaching the
 * app and the app's selectors from reaching the fragment — custom properties still inherit, which is
 * exactly how the theme tokens arrive. The host carries `contain: layout paint` and clips, so a
 * `position: fixed` overlay is fixed to the fragment, not to the viewport, and cannot cover the app.
 * The page's CSP is the backstop under all of it: `img-src`, `font-src` and `connect-src` refuse a
 * remote load the sanitizer missed, and `require-trusted-types-for 'script'` refuses any string at a
 * script sink — the sanitizer's own parse runs under the one dedicated `fy-fragment` policy
 * (`lib/trusted-types.ts`), and this file never assigns markup to a sink at all.
 *
 * IT HOLDS NO CREDENTIAL — the same narrow `readWorkspaceMedia` capability every media block gets.
 *
 * ITS LINKS OPEN WHERE EVERY OTHER LINK DOES. The anchors are inert DOM, not `ExternalLink`s, so one
 * click listener on the shadow root hands an ordinary tap on any of them to `useLinkBehaviour` —
 * Settings › Appearance › "Open links in" — and leaves a modified click to the anchor's own new tab.
 */
import createDOMPurify, { type Config, type DOMPurify } from 'dompurify';
import { useEffect, useRef } from 'react';
import { useLinkBehaviour } from '../features/browser/external-link.tsx';
import {
  type FyRenderImageMime,
  type FyRenderWorkspaceReader,
  fyRenderMediaMime,
  fyRenderRasterRefusal,
} from '../lib/fy-render.ts';
import { fragmentParsingPolicy } from '../lib/trusted-types.ts';

/** Elements a static explanation never needs and that could run, frame, submit or retarget. */
const FORBID_TAGS = [
  'script',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'portal',
  'form',
  'input',
  'button',
  'select',
  'option',
  'textarea',
  'base',
  'meta',
  'link',
  'template',
  'noscript',
  'foreignObject',
  'use',
  'animate',
  'animateMotion',
  'animateTransform',
  'set',
  'audio',
  'video',
  'source',
  'track',
];

/** Attributes that address something, beyond the handlers DOMPurify always removes. */
const FORBID_ATTR = ['action', 'formaction', 'srcset', 'ping', 'background', 'poster', 'srcdoc', 'xmlns:xlink'];

const SANITIZE: Config = {
  ALLOW_DATA_ATTR: false,
  FORBID_ATTR,
  FORBID_TAGS,
  // `style` is allowed and contained; `<style>` too, both rewritten below.
  ADD_TAGS: ['style'],
  FORCE_BODY: true,
  RETURN_DOM_FRAGMENT: true,
  USE_PROFILES: { html: true, svg: true, svgFilters: true },
};

/** The only image sources a fragment may name. */
const DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp|svg\+xml)[;,]/iu;
const MEDIA_SOURCE = /^media:([^\s\\]+)$/u;
const HTTPS_LINK = /^https:\/\//iu;

/** The attribute a `media:` picture is parked in until its bytes are read. */
const MEDIA_ATTRIBUTE = 'data-fy-media';

/**
 * CSS that cannot load anything. `@import` goes; every `url(…)` and `image-set(…)` that is not a
 * `data:image/` becomes `none`. Over-eager on purpose — a fragment that loses a decorative background
 * is the right way to be wrong.
 */
export const neutraliseCss = (css: string): string =>
  css
    .replace(/@import[^;]*;?/giu, '')
    .replace(/(?:-webkit-)?image-set\s*\([^)]*\)/giu, 'none')
    .replace(/url\s*\(\s*(['"]?)(?!data:image\/)[^)]*\)/giu, 'none');

/** A `media:` path that stays inside the folder, or `null`. */
const mediaPath = (value: string): string | null => {
  const match = MEDIA_SOURCE.exec(value.trim());
  const path = match?.[1];
  if (path === undefined || path.startsWith('/')) return null;
  return path.split('/').some(segment => segment === '' || segment === '.' || segment === '..') ? null : path;
};

let purifier: DOMPurify | undefined;

/**
 * THIS module's own DOMPurify, made from the live `window` the first time a fragment is drawn — not
 * the shared default instance, so no other code's hooks or settings can reach these rules, and not at
 * import, because an instance made before a document exists cannot sanitize anything. Its hooks judge
 * every element: the URL rules above, and the CSS rewrite for `style` attributes and `<style>`.
 */
const fragmentPurifier = (): DOMPurify => {
  if (purifier !== undefined) return purifier;
  const made = createDOMPurify(window);
  made.addHook('uponSanitizeAttribute', (node, data) => {
    const name = data.attrName.toLowerCase();
    if (name === 'style') {
      data.attrValue = neutraliseCss(data.attrValue);
      return;
    }
    if (name === 'href' || name === 'xlink:href') {
      data.keepAttr = node.nodeName.toLowerCase() === 'a' && HTTPS_LINK.test(data.attrValue.trim());
      return;
    }
    if (name === 'src') {
      const media = mediaPath(data.attrValue);
      if (media !== null && node.nodeName.toLowerCase() === 'img') {
        node.setAttribute(MEDIA_ATTRIBUTE, media);
        data.keepAttr = false;
        return;
      }
      data.keepAttr = node.nodeName.toLowerCase() === 'img' && DATA_IMAGE.test(data.attrValue.trim());
    }
  });
  // The parked media path is set by this hook itself, after `data-*` was refused for author markup.
  made.addHook('afterSanitizeAttributes', node => {
    if (node.nodeName.toLowerCase() === 'style') node.textContent = neutraliseCss(node.textContent ?? '');
    if (node.nodeName.toLowerCase() === 'a' && node.hasAttribute('href')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
  purifier = made;
  return made;
};

/**
 * An agent's html as an inert DOM fragment: sanitized, URL-scrubbed and CSS-neutralised. Never a
 * string at a sink — the caller appends the nodes.
 */
export const sanitizeFyRenderFragment = (source: string): DocumentFragment => {
  const policy = fragmentParsingPolicy();
  return fragmentPurifier().sanitize(source, {
    ...SANITIZE,
    ...(policy === null ? {} : { TRUSTED_TYPES_POLICY: policy as unknown as Config['TRUSTED_TYPES_POLICY'] }),
  }) as unknown as DocumentFragment;
};

/**
 * The fragment's own baseline, inside its shadow root: the column's type and colour, pictures and
 * tables that fit the column, and the theme's tokens for borders and code. An author stylesheet
 * overrides any of it — but only inside this root.
 */
const BASE_STYLE = `
:host { display: block; color: var(--fg); font: inherit; line-height: inherit; }
img, svg { max-width: 100%; height: auto; }
table { border-collapse: collapse; max-width: 100%; display: block; overflow-x: auto; }
th, td { border: 1px solid var(--border-strong); padding: 4px 8px; text-align: left; }
code, pre { font-family: var(--font-mono); font-size: var(--code-font-size); }
pre { white-space: pre-wrap; }
a { color: var(--accent); }
`;

export interface FyRenderFragmentProps {
  readonly source: string;
  /** The block's description, which names the fragment for assistive technology. */
  readonly alt: string;
  readonly readWorkspaceMedia?: FyRenderWorkspaceReader;
}

export function FyRenderFragment({ source, alt, readWorkspaceMedia }: FyRenderFragmentProps) {
  const hostRef = useRef<HTMLElement | null>(null);
  /** CLOSED: no script — there is none — and no app code reaches in through `host.shadowRoot`. */
  const rootRef = useRef<ShadowRoot | null>(null);
  const links = useLinkBehaviour();
  // The latest handler, read at click time: the listener is attached once per root, not per render.
  const activate = useRef(links.activate);
  activate.current = links.activate;

  // biome-ignore lint/correctness/useExhaustiveDependencies: the source is the identity; the reader is a stable capability
  useEffect(() => {
    const host = hostRef.current;
    if (host === null || typeof host.attachShadow !== 'function') return;
    rootRef.current ??= host.attachShadow({ mode: 'closed' });
    const root = rootRef.current;
    const style = document.createElement('style');
    style.textContent = BASE_STYLE;
    root.replaceChildren(style, sanitizeFyRenderFragment(source));

    // `media:` pictures, read as the reader and shown as a `blob:` this page minted.
    const controller = new AbortController();
    const minted: string[] = [];
    for (const image of Array.from(root.querySelectorAll<HTMLImageElement>(`img[${MEDIA_ATTRIBUTE}]`))) {
      const path = image.getAttribute(MEDIA_ATTRIBUTE) as string;
      image.removeAttribute(MEDIA_ATTRIBUTE);
      // The same admission a media block's picture passes: a known raster type by extension, then its
      // container checks — so an animated loop nobody can pause is refused here too.
      const mime = fyRenderMediaMime('image', path);
      if (readWorkspaceMedia === undefined || mime === null) continue;
      void readWorkspaceMedia(path, controller.signal, 'media')
        .then(read => {
          if (!read.ok || controller.signal.aborted) return;
          if (fyRenderRasterRefusal(read.bytes, mime as FyRenderImageMime) !== null) return;
          const url = URL.createObjectURL(new Blob([read.bytes], { type: mime }));
          minted.push(url);
          image.src = url;
        })
        .catch(() => undefined);
    }
    return () => {
      controller.abort();
      for (const url of minted) URL.revokeObjectURL(url);
    };
  }, [source]);

  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const click = (event: Event): void => {
      if (!(event instanceof MouseEvent)) return;
      const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!(anchor instanceof HTMLAnchorElement)) return;
      activate.current(event, {
        href: anchor.getAttribute('href') ?? undefined,
        ...(anchor.hasAttribute('download') ? { download: anchor.getAttribute('download') ?? true } : {}),
        element: anchor,
      });
    };
    root.addEventListener('click', click);
    return () => root.removeEventListener('click', click);
  }, []);

  return (
    <>
      <section aria-label={alt} className="fy-render-fragment" data-fy-render-fragment="true" ref={hostRef} />
      {links.sheet}
    </>
  );
}
