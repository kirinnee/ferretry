/**
 * WHAT THE RUNNER READS OFF A PAGE, and what a saved fixture therefore looks like.
 *
 * One page function, run in the page's isolated world through the same `browser.eval` path an agent uses: it
 * returns the document as plain HTML with everything a scorer never reads (scripts, styles, images, canvases)
 * taken out so a heavy page fits the eval result cap, plus three facts a document cannot say about itself:
 * the HTTP status of the navigation, the host it ended up on, and every form control's CURRENT value (a value a
 * script set is a property, not an attribute, so `outerHTML` would drop it). Those facts ride in `<meta>` tags
 * of the head so one string is the whole input of a scorer, and a fixture is one file.
 */

/** The meta names a capture carries; the capture writes them and the scorers read them. */
export const CAPTURE_META = { status: 'fy-status', host: 'fy-host', challenge: 'fy-challenge' } as const;

/** Past this many characters a capture says it was cut, and every scorer then reads it as unreadable. */
const CAPTURE_MAX_CHARS = 120_000;

/** The marker a cut capture carries on its `<html>` element. */
export const CAPTURE_TRUNCATED_ATTRIBUTE = 'data-fy-truncated';

/** The page function, as the source `browser.eval` takes. Self-contained: it runs inside the page. */
export const CAPTURE_SOURCE = `() => {
  const limit = ${String(CAPTURE_MAX_CHARS)};
  const live = Array.from(document.querySelectorAll('input, textarea, select'));
  const root = document.documentElement.cloneNode(true);
  const copies = Array.from(root.querySelectorAll('input, textarea, select'));
  live.forEach((control, index) => {
    const copy = copies[index];
    if (copy === undefined) return;
    if (control.tagName === 'TEXTAREA') copy.textContent = control.value;
    else if (control.tagName === 'INPUT') copy.setAttribute('value', control.value);
  });
  for (const element of Array.from(root.querySelectorAll('script, style, noscript, svg, canvas, link, img, picture, video, audio, .modal-container'))) element.remove();
  for (const element of Array.from(root.querySelectorAll('[style], [onclick]'))) {
    element.removeAttribute('style');
    element.removeAttribute('onclick');
  }
  const navigation = performance.getEntriesByType('navigation')[0];
  const status = navigation !== undefined && typeof navigation.responseStatus === 'number' ? navigation.responseStatus : 0;
  const head = root.querySelector('head');
  const stamp = (name, value) => {
    const meta = document.createElement('meta');
    meta.setAttribute('name', name);
    meta.setAttribute('content', value);
    if (head !== null) head.appendChild(meta);
  };
  stamp('${CAPTURE_META.status}', String(status));
  stamp('${CAPTURE_META.host}', location.host);
  let html = '<!doctype html>' + root.outerHTML;
  if (html.length > limit) {
    root.setAttribute('${CAPTURE_TRUNCATED_ATTRIBUTE}', 'true');
    html = '<!doctype html>' + root.outerHTML.slice(0, limit);
  }
  return html;
}`;

/** `html` with the daemon's challenge verdict stamped into its head, for a scorer that reads it. */
export function withChallenge(html: string, provider: string | undefined): string {
  if (provider === undefined) return html;
  const meta = `<meta name="${CAPTURE_META.challenge}" content="${provider}">`;
  return html.includes('</head>') ? html.replace('</head>', `${meta}</head>`) : `${meta}${html}`;
}
