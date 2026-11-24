/**
 * THE PAGE'S SIDE OF SOLVING A CAPTCHA (B5 D7): what a check on the page asks for, and where its answer goes back.
 *
 * The browser worker runs both functions INSIDE the page (`page.evaluate`), so each is self-contained, its helpers nested
 * in it. Neither reads page content beyond the widget's own markers (a site key, an action name, the frames' addresses),
 * and the token only ever flows IN: {@link injectCaptchaToken} answers a yes or no, never the token or anything the page
 * said back.
 *
 * Covered: Cloudflare Turnstile, reCAPTCHA v2 and v3, hCaptcha. Anything else (DataDome, Arkose, HUMAN, Cloudflare's
 * "Just a moment" page with no widget) has no token these APIs sell, and stays with the owner.
 */

/** The checks a token API can answer. */
export const CAPTCHA_KINDS = ['turnstile', 'recaptcha-v2', 'recaptcha-v3', 'hcaptcha'] as const;
export type CaptchaKind = (typeof CAPTCHA_KINDS)[number];

/** A check the page is showing, as the page itself names it. */
export interface CaptchaWidget {
  readonly kind: CaptchaKind;
  readonly siteKey: string;
  /** The widget's own action name (`data-action`, or reCAPTCHA v3's `render` action), when it has one. */
  readonly action?: string;
}

/** What {@link injectCaptchaToken} is handed: the check's kind and the token the solver returned. */
export interface CaptchaAnswer {
  readonly kind: CaptchaKind;
  readonly token: string;
}

/** Looks for a solvable widget in the page's main document and its frames' addresses. `null` when there is none. */
export function probeCaptcha(): { kind: CaptchaKind; siteKey: string; action?: string } | null {
  const attribute = (element: Element | null, name: string): string | undefined => {
    const value = element?.getAttribute(name)?.trim();
    return value === undefined || value === '' ? undefined : value;
  };
  const frames = Array.from(document.querySelectorAll('iframe')).map(frame => frame.getAttribute('src') ?? '');
  const scripts = Array.from(document.querySelectorAll('script[src]')).map(script => script.getAttribute('src') ?? '');
  const parameter = (address: string, name: string): string | undefined => {
    try {
      return new URL(address, location.href).searchParams.get(name) ?? undefined;
    } catch {
      return undefined;
    }
  };
  const found = (kind: CaptchaKind, siteKey: string | undefined, action?: string) =>
    siteKey === undefined ? null : { kind, siteKey, ...(action === undefined ? {} : { action }) };

  const turnstile = document.querySelector('.cf-turnstile[data-sitekey]');
  const turnstileFrame = frames.find(address => address.includes('challenges.cloudflare.com'));
  if (turnstile !== null)
    return found('turnstile', attribute(turnstile, 'data-sitekey'), attribute(turnstile, 'data-action'));
  if (turnstileFrame !== undefined) {
    const key = /\/(0x[0-9A-Za-z_-]{8,})(?:\/|$|\?)/u.exec(turnstileFrame)?.[1];
    if (key !== undefined) return found('turnstile', key);
  }

  const hcaptcha = document.querySelector('.h-captcha[data-sitekey]');
  const hcaptchaFrame = frames.find(address => address.includes('hcaptcha.com'));
  if (hcaptcha !== null) return found('hcaptcha', attribute(hcaptcha, 'data-sitekey'));
  if (hcaptchaFrame !== undefined) {
    const key = /[#&?]sitekey=([0-9a-f-]{20,})/iu.exec(hcaptchaFrame)?.[1];
    if (key !== undefined) return found('hcaptcha', key);
  }

  const recaptcha = document.querySelector('.g-recaptcha[data-sitekey]');
  if (recaptcha !== null) return found('recaptcha-v2', attribute(recaptcha, 'data-sitekey'));
  const recaptchaFrame = frames.find(address => /\/recaptcha\/(?:api2|enterprise)\/anchor/u.test(address));
  const frameKey = recaptchaFrame === undefined ? undefined : parameter(recaptchaFrame, 'k');
  // A script that loads the library with `render=<key>` (not `explicit`) is v3 unless a visible v2 box is shown.
  const v3Script = scripts.find(
    address => /recaptcha\/(?:api|enterprise)\.js/u.test(address) && address.includes('render='),
  );
  const v3Key = v3Script === undefined ? undefined : parameter(v3Script, 'render');
  const v3Action = attribute(document.querySelector('[data-action]'), 'data-action');
  if (recaptchaFrame !== undefined && frameKey !== undefined)
    return recaptchaFrame.includes('size=invisible') && v3Key !== undefined && v3Key !== 'explicit'
      ? found('recaptcha-v3', v3Key, v3Action)
      : found('recaptcha-v2', frameKey);
  if (v3Key !== undefined && v3Key !== 'explicit') return found('recaptcha-v3', v3Key, v3Action);
  return null;
}

/**
 * Hands the solver's token to the widget the way the widget itself would: into its response field (made if the page has not
 * rendered one yet), then into the callback the page registered for it. `true` when the page took the token anywhere.
 */
export function injectCaptchaToken(answer: { kind: CaptchaKind; token: string }): boolean {
  const names =
    answer.kind === 'turnstile'
      ? ['cf-turnstile-response']
      : answer.kind === 'hcaptcha'
        ? ['h-captcha-response', 'g-recaptcha-response']
        : ['g-recaptcha-response'];
  // The widget's own box; or, for one that is only a frame, the form that holds the frame (else the frame's parent).
  const frame = Array.from(document.querySelectorAll('iframe')).find(each =>
    /challenges\.cloudflare\.com|hcaptcha\.com|recaptcha/u.test(each.getAttribute('src') ?? ''),
  );
  const container =
    document.querySelector(
      answer.kind === 'turnstile' ? '.cf-turnstile' : answer.kind === 'hcaptcha' ? '.h-captcha' : '.g-recaptcha, form',
    ) ??
    frame?.closest('form') ??
    frame?.parentElement ??
    null;
  let placed = false;
  for (const name of names) {
    let field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${name}"]`);
    if (field === null && container !== null) {
      const created = document.createElement('input');
      created.type = 'hidden';
      created.name = name;
      container.appendChild(created);
      field = created;
    }
    if (field !== null) {
      field.value = answer.token;
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
      placed = true;
    }
  }
  const registered = container?.getAttribute('data-callback');
  const callbacks: ((token: string) => unknown)[] = [];
  const named = registered === null || registered === undefined ? undefined : (window as never)[registered];
  if (typeof named === 'function') callbacks.push(named as (token: string) => unknown);
  // reCAPTCHA keeps the callback it was rendered with in its own client table.
  const clients = (window as unknown as { ___grecaptcha_cfg?: { clients?: Record<string, unknown> } }).___grecaptcha_cfg
    ?.clients;
  const walk = (value: unknown, depth: number): void => {
    if (value === null || typeof value !== 'object' || depth > 4) return;
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'callback' && typeof inner === 'function') callbacks.push(inner as (token: string) => unknown);
      else walk(inner, depth + 1);
    }
  };
  if (answer.kind.startsWith('recaptcha') && clients !== undefined) walk(clients, 0);
  for (const callback of callbacks) {
    try {
      void callback(answer.token);
      placed = true;
    } catch {
      // A callback that throws has not taken the token; the field above may still have.
    }
  }
  return placed;
}
