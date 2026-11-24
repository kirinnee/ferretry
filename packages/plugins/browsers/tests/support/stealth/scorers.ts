/**
 * THE SCORERS: one pure function per public bot-check page, from the page as `capture.ts` read it to a `Reading`.
 *
 * THE RULE THEY ALL KEEP: a page that is not exactly what the scorer was written against is `unreadable` — "could
 * not read score", with the reason — never a pass and never a quiet zero. A site that renames a row, drops a
 * section or has not finished running its own tests yet produces an `unreadable`, so a regression in this suite is
 * loud and a real score is never guessed. Every scorer therefore names what it requires BEFORE it judges anything,
 * and the unit tests pin both a passing and a failing saved page, plus the unreadable one.
 */
import { Window } from 'happy-dom';
import { CAPTURE_META, CAPTURE_TRUNCATED_ATTRIBUTE } from './capture.ts';

type Measure = number | string | boolean;

export type Reading =
  | {
      readonly kind: 'scored';
      readonly pass: boolean;
      /** The raw numbers behind the verdict, for the scorecard. Never an address, a token or a cookie. */
      readonly numbers: Readonly<Record<string, Measure>>;
      /** The named tests that failed (empty on a pass). */
      readonly failed: readonly string[];
    }
  | { readonly kind: 'unreadable'; readonly reason: string };

const unreadable = (reason: string): Reading => ({ kind: 'unreadable', reason: `could not read score: ${reason}` });

const scored = (
  pass: boolean,
  numbers: Readonly<Record<string, Measure>>,
  failed: readonly string[] = [],
): Reading => ({ kind: 'scored', pass, numbers, failed });

const round = (value: number): number => Math.round(value * 1000) / 1000;

/** Run `read` over the captured page, then drop the window: the scorers hold no DOM between calls. */
function readDocument(html: string, read: (document: Document, host: string | undefined) => Reading): Reading {
  const window = new Window({
    settings: {
      disableJavaScriptEvaluation: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
      disableIframePageLoading: true,
      handleDisabledFileLoadingAsSuccess: true,
    },
  });
  try {
    window.document.write(html);
    const document = window.document as unknown as Document;
    if (document.documentElement.hasAttribute(CAPTURE_TRUNCATED_ATTRIBUTE))
      return unreadable('the page was too large to capture whole');
    return read(document, metaContent(document, CAPTURE_META.host));
  } finally {
    void window.happyDOM.close();
  }
}

function metaContent(document: Document, name: string): string | undefined {
  return document.querySelector(`meta[name="${name}"]`)?.getAttribute('content') ?? undefined;
}

const textOf = (element: Element | null | undefined): string =>
  (element?.textContent ?? '').replace(/\s+/gu, ' ').trim();

/** Host guard: a scorer reads only its own site, so a redirect to a parking page or a proxy block page is loud. */
function onHost(host: string | undefined, expected: string): string | undefined {
  if (host === undefined) return 'the capture does not say which host it came from';
  return host === expected ? undefined : `the page is on ${host}, not ${expected}`;
}

// ---------------------------------------------------------------------------------------------------------------
// bot.sannysoft.com
// ---------------------------------------------------------------------------------------------------------------

/** The rows the pass rule names: a pass needs every one of them present and passed, whatever the rest says. */
const SANNYSOFT_NAMED_ROWS = ['WebDriver', 'WebDriver Advanced', 'Chrome', 'Permissions'] as const;
const SANNYSOFT_MIN_ROWS = 25;
const SANNYSOFT_MIN_RATIO = 0.95;

/** Sannysoft: every table cell classed `passed` or `failed` is a row; pass at ≥ 95% and no named row failed. */
export function scoreSannysoft(html: string): Reading {
  return readDocument(html, (document, host) => {
    const wrongHost = onHost(host, 'bot.sannysoft.com');
    if (wrongHost !== undefined) return unreadable(wrongHost);
    const rows = new Map<string, boolean>();
    for (const row of Array.from(document.querySelectorAll('tr'))) {
      const [label, result] = Array.from(row.querySelectorAll('td'));
      if (label === undefined || result === undefined) continue;
      const passed = result.classList.contains('passed');
      if (!passed && !result.classList.contains('failed')) continue;
      const name = textOf(label).replace(/\s*\((?:Old|New)\)\s*$/u, '');
      rows.set(name, passed);
    }
    if (rows.size < SANNYSOFT_MIN_ROWS)
      return unreadable(`only ${String(rows.size)} decided rows, expected at least ${String(SANNYSOFT_MIN_ROWS)}`);
    const missing = SANNYSOFT_NAMED_ROWS.filter(name => !rows.has(name));
    if (missing.length > 0) return unreadable(`no result for the named rows: ${missing.join(', ')}`);
    const failed = [...rows].filter(([, passed]) => !passed).map(([name]) => name);
    const ratio = (rows.size - failed.length) / rows.size;
    const namedFailed = SANNYSOFT_NAMED_ROWS.filter(name => rows.get(name) === false);
    return scored(
      ratio >= SANNYSOFT_MIN_RATIO && namedFailed.length === 0,
      { rows: rows.size, failedRows: failed.length, ratio: round(ratio) },
      failed,
    );
  });
}

// ---------------------------------------------------------------------------------------------------------------
// bot.incolumitas.com
// ---------------------------------------------------------------------------------------------------------------

const INCOLUMITAS_MIN_TESTS = 20;
/** The behavioral score below which the page itself calls the visitor a bot is 0.5; the plan asks 0.7. */
const INCOLUMITAS_MIN_BEHAVIORAL = 0.7;

/** Every string leaf of a parsed JSON value, by its dotted path. */
function leaves(value: unknown, path: string, into: Map<string, string>): void {
  if (typeof value === 'string') into.set(path, value);
  else if (typeof value === 'object' && value !== null)
    for (const [key, inner] of Object.entries(value)) leaves(inner, path === '' ? key : `${path}.${key}`, into);
}

function jsonIn(document: Document, id: string): { value: unknown } | string {
  const text = textOf(document.getElementById(id));
  if (text === '') return `the "${id}" results are empty (the page has not run its tests)`;
  try {
    return { value: JSON.parse(text) as unknown };
  } catch {
    return `the "${id}" results are not JSON`;
  }
}

/**
 * incolumitas: the page prints its own tests as two JSON blocks, each leaf `OK` or a failure word. Pass when every
 * leaf is `OK` and, if the page produced a behavioral score at all, it is at least 0.7. The score needs pointer
 * activity this suite never makes (a GET page load only), so on a quiet page it is reported as absent, not failed.
 */
export function scoreIncolumitas(html: string): Reading {
  return readDocument(html, (document, host) => {
    const wrongHost = onHost(host, 'bot.incolumitas.com');
    if (wrongHost !== undefined) return unreadable(wrongHost);
    const found = new Map<string, string>();
    for (const id of ['new-tests', 'detection-tests']) {
      const block = jsonIn(document, id);
      if (typeof block === 'string') return unreadable(block);
      leaves(block.value, id === 'new-tests' ? 'new' : 'old', found);
    }
    if (found.size < INCOLUMITAS_MIN_TESTS)
      return unreadable(`only ${String(found.size)} tests, expected at least ${String(INCOLUMITAS_MIN_TESTS)}`);
    const failed = [...found].filter(([, result]) => result !== 'OK').map(([name]) => name);
    const shown = textOf(document.getElementById('behavioralScore'));
    const behavioral = /^\d(?:\.\d+)?$/u.test(shown) ? Number(shown) : undefined;
    const numbers: Record<string, Measure> = {
      tests: found.size,
      failedTests: failed.length,
      behavioral: behavioral === undefined ? 'not scored (no pointer input)' : behavioral,
    };
    const behavioralOk = behavioral === undefined || behavioral >= INCOLUMITAS_MIN_BEHAVIORAL;
    return scored(
      failed.length === 0 && behavioralOk,
      numbers,
      behavioralOk ? failed : [...failed, 'behavioral score'],
    );
  });
}

// ---------------------------------------------------------------------------------------------------------------
// bot-detector.rebrowser.net
// ---------------------------------------------------------------------------------------------------------------

const REBROWSER_MIN_DECIDED = 15;

/**
 * rebrowser bot detector: one table row per test, led by 🟢 passed, 🔴 detected, 🟡 warning or ⚪️ not triggered
 * (a test only an automation script can trigger). Pass when no test is red; warnings and the not-triggered tests are
 * counted and named but do not fail the page, because some of them (a headless "no pointing device") are the page's
 * own caveats and not a detection.
 */
export function scoreRebrowser(html: string): Reading {
  return readDocument(html, (document, host) => {
    const wrongHost = onHost(host, 'bot-detector.rebrowser.net');
    if (wrongHost !== undefined) return unreadable(wrongHost);
    const tally = { green: 0, red: 0, yellow: 0, white: 0 };
    const red: string[] = [];
    const yellow: string[] = [];
    for (const row of Array.from(document.querySelectorAll('#detections-table tbody tr'))) {
      const label = textOf(row.querySelector('td'));
      const [mark, ...name] = Array.from(label);
      if (mark === undefined) continue;
      const test = name.join('').replace(/️/gu, '').trim();
      if (label.startsWith('🟢')) tally.green += 1;
      else if (label.startsWith('🔴')) {
        tally.red += 1;
        red.push(test);
      } else if (label.startsWith('🟡')) {
        tally.yellow += 1;
        yellow.push(test);
      } else if (label.startsWith('⚪')) tally.white += 1;
    }
    const decided = tally.green + tally.red + tally.yellow;
    if (decided < REBROWSER_MIN_DECIDED)
      return unreadable(`only ${String(decided)} decided tests, expected at least ${String(REBROWSER_MIN_DECIDED)}`);
    return scored(
      tally.red === 0,
      {
        passed: tally.green,
        detected: tally.red,
        warnings: tally.yellow,
        notTriggered: tally.white,
        warned: yellow.join(','),
      },
      red,
    );
  });
}

// ---------------------------------------------------------------------------------------------------------------
// recaptcha-demo.appspot.com (reCAPTCHA v3, Google's own demo)
// ---------------------------------------------------------------------------------------------------------------

/** The score the plan wants from a real person's browser. */
const RECAPTCHA_MIN_SCORE = 0.7;

/** reCAPTCHA v3: the demo's backend answer is printed as JSON in `.response`; its `score` is the number. */
export function scoreRecaptchaV3(html: string): Reading {
  return readDocument(html, (document, host) => {
    const wrongHost = onHost(host, 'recaptcha-demo.appspot.com');
    if (wrongHost !== undefined) return unreadable(wrongHost);
    const shown = textOf(document.querySelector('#recaptcha-steps .response'));
    let answer: unknown;
    try {
      answer = JSON.parse(shown);
    } catch {
      return unreadable('the demo backend has not answered yet (no JSON in its response)');
    }
    const body = typeof answer === 'object' && answer !== null ? (answer as Record<string, unknown>) : {};
    if (!('success' in body))
      return unreadable('the demo backend has not answered yet (its placeholder is still shown)');
    if (body.success !== true) return unreadable('the demo backend did not accept the token');
    const score = body.score;
    if (typeof score !== 'number' || score < 0 || score > 1)
      return unreadable('the answer carries no score between 0 and 1');
    return scored(score >= RECAPTCHA_MIN_SCORE, { score }, score >= RECAPTCHA_MIN_SCORE ? [] : ['score']);
  });
}

// ---------------------------------------------------------------------------------------------------------------
// nopecha.com/demo/turnstile (a real managed Cloudflare Turnstile widget, not the always-pass test keys)
// ---------------------------------------------------------------------------------------------------------------

/** A token shorter than this is a placeholder, not an issued token. */
const TURNSTILE_MIN_TOKEN = 20;

/**
 * Turnstile demo: each rendered widget carries a hidden `cf-turnstile-response` input. Pass when every widget
 * holds an issued token with NO interaction (the stealth pass; a solver-issued token is the solver's own number,
 * D7). The token itself is checked for length only and never leaves this function.
 */
export function scoreTurnstile(html: string): Reading {
  return readDocument(html, (document, host) => {
    const wrongHost = onHost(host, 'nopecha.com');
    if (wrongHost !== undefined) return unreadable(wrongHost);
    const widgets = Array.from(document.querySelectorAll('input[name="cf-turnstile-response"]'));
    if (widgets.length === 0) return unreadable('no Turnstile widget rendered on the page');
    const issued = widgets.filter(widget => (widget.getAttribute('value') ?? '').length >= TURNSTILE_MIN_TOKEN).length;
    return scored(
      issued === widgets.length,
      { widgets: widgets.length, tokens: issued },
      issued === widgets.length ? [] : ['token'],
    );
  });
}

// ---------------------------------------------------------------------------------------------------------------
// the owner's real sign-in page: Navia (public login page; a GET, never a sign-in)
// ---------------------------------------------------------------------------------------------------------------

/**
 * A sign-in page the owner actually uses. It loads, or it is met by a challenge, a block or an empty shell. Pass when
 * the response status is below 400, the daemon recognised no challenge, and the page holds a sign-in form (a form
 * with a password field). Nothing is typed into it.
 */
export function scoreNavia(html: string): Reading {
  return readDocument(html, (document, host) => {
    const wrongHost = onHost(host, 'app.naviabenefits.com');
    if (wrongHost !== undefined) return unreadable(wrongHost);
    const status = Number(metaContent(document, CAPTURE_META.status));
    if (!Number.isInteger(status) || status < 100) return unreadable('the capture carries no response status');
    const challenge = metaContent(document, CAPTURE_META.challenge);
    const form = document.querySelector('form input[type="password"]') !== null;
    const failed = [
      ...(status >= 400 ? [`status ${String(status)}`] : []),
      ...(challenge === undefined ? [] : [`challenge ${challenge}`]),
      ...(form ? [] : ['sign-in form missing']),
    ];
    return scored(failed.length === 0, { status, challenge: challenge ?? 'none', form }, failed);
  });
}

// ---------------------------------------------------------------------------------------------------------------
// abrahamjuliot.github.io/creepjs
// ---------------------------------------------------------------------------------------------------------------

const CREEPJS_MAX_HEADLESS = 10;
const CREEPJS_MAX_STEALTH = 0;

/** The percentage in a CreepJS rating line such as `56% like headless: …`; `undefined` when the line is absent. */
function creepRating(document: Document, selector: string): number | undefined {
  const match = /^(\d{1,3})%/u.exec(textOf(document.querySelector(selector)));
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/**
 * CreepJS: three ratings on the Headless card — `headless`, `stealth` (a patched browser being caught) and `like
 * headless` (a softer resemblance, reported but not gating) — and the 64-hex FP ID. Pass when headless ≤ 10% and
 * stealth is 0%. Only the first 8 characters of the FP ID are kept in the numbers: enough to see whether two runs
 * look like the same browser, and not a full device fingerprint. The page no longer prints a "lies" count, so the
 * plan's "lies 0" is not scored; if the ratings or the FP ID go missing the page is unreadable, not a pass.
 */
export function scoreCreepJs(html: string): Reading {
  return readDocument(html, (document, host) => {
    const wrongHost = onHost(host, 'abrahamjuliot.github.io');
    if (wrongHost !== undefined) return unreadable(wrongHost);
    const headless = creepRating(document, '.headless-rating');
    const stealth = creepRating(document, '.stealth-rating');
    const likeHeadless = creepRating(document, '.like-headless-rating');
    if (headless === undefined || stealth === undefined || likeHeadless === undefined)
      return unreadable('the headless / stealth / like-headless ratings are not on the page');
    const id = /FPID:([0-9a-f]{64})/u.exec(
      textOf(document.querySelector('.fingerprint-header')).replace(/\s+/gu, ''),
    )?.[1];
    if (id === undefined) return unreadable('the FP ID is not complete on the page');
    const failed = [
      ...(headless > CREEPJS_MAX_HEADLESS ? ['headless'] : []),
      ...(stealth > CREEPJS_MAX_STEALTH ? ['stealth'] : []),
    ];
    return scored(failed.length === 0, { headless, stealth, likeHeadless, fingerprint: id.slice(0, 8) }, failed);
  });
}
