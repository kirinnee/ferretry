/**
 * TRUSTED TYPES: the browser, not review, keeps markup out of the app's script sinks (docs/cross-daemon.md §2b).
 *
 * `public/_headers` says `require-trusted-types-for 'script'` and names exactly two policies. From then
 * on Chromium refuses a plain string at every sink that can turn text into script — `innerHTML`, a
 * worker's script URL — and only a value one of these policies made is accepted. Before, the four
 * places the app writes raw markup were safe because a reviewer read them; now they are safe because
 * nothing else CAN write markup, and a fifth one added later fails in the browser instead of passing
 * review.
 *
 * The two policies, each the narrowest rule its one job allows:
 *
 * - `fy-highlight` makes the markup a code view shows from highlight.js output (or `escapeHtml`). It
 *   accepts a string only when every tag in it is `<span class="…">` or `</span>` and no other `<` or
 *   `>` is left: that is the whole shape highlight.js emits, because it escapes the source it
 *   tokenizes. Anything else is refused by the policy itself, and {@link trustedHighlight} escapes
 *   such a string first, so a broken highlighter shows its markup as text rather than running it.
 * - `fy-worker` makes the script URL of the app's own workers, and only two exist: the signed service
 *   worker every registration names (`sw.verified.js`, with a machine label for a push registration),
 *   and the on-device speech worker the build emits beside the app (`/assets/parakeet-worker-<hash>.js`,
 *   or its dev-server address). A registration and a `new Worker` are script sinks to the browser, so
 *   without a policy neither could start at all.
 *
 * Where the browser has no Trusted Types (Safari, Firefox, the unit tests) both helpers return the
 * same string, checked by the same rules, so behaviour never forks on the engine.
 */

import { escapeHtml } from './highlight.ts';
import { RELEASE_WORKER_FILE } from './release-manifest.ts';

/** The policy names `public/_headers` allows, and nothing else may create one. */
export const TRUSTED_TYPE_POLICIES = ['fy-highlight', 'fy-worker'] as const;

interface TrustedTypePolicyLike {
  createHTML?(input: string): unknown;
  createScriptURL?(input: string): unknown;
}

/** The slice of `window.trustedTypes` this module uses. */
export interface TrustedTypePolicyFactoryLike {
  createPolicy(
    name: string,
    rules: { createHTML?: (input: string) => string; createScriptURL?: (input: string) => string },
  ): TrustedTypePolicyLike;
}

/** Every tag highlight.js writes. */
const HIGHLIGHT_TAG = /<span class="[A-Za-z0-9_ -]*">|<\/span>/gu;

/** Whether a string is markup highlight.js could have written: its spans and escaped text, nothing else. */
export const isHighlightMarkup = (html: string): boolean => !/[<>]/u.test(html.replace(HIGHLIGHT_TAG, ''));

/** The app's one signed worker file (`sw.verified.js`) under the app's base path, optionally labelled for one machine's push scope. */
const WORKER_SCRIPT = new RegExp(
  `^(?:/[A-Za-z0-9._-]+)*/${RELEASE_WORKER_FILE.replaceAll('.', '\\.')}(?:\\?machine=[^&#]*)?$`,
  'u',
);

/**
 * The speech worker (`src/worker/parakeet-worker.ts`): Vite's content-hashed build output, or the
 * address its dev server serves the same module at. Nothing else under `/assets/` is a worker.
 */
const SPEECH_WORKER_SCRIPT =
  /^(?:\/assets\/parakeet-worker-[A-Za-z0-9_-]+\.js|\/src\/worker\/parakeet-worker\.ts\?worker_file&type=module)$/u;

/** Whether a URL is one of the app's own worker scripts: the service worker or the speech worker. */
export const isWorkerScriptUrl = (url: string): boolean => WORKER_SCRIPT.test(url) || SPEECH_WORKER_SCRIPT.test(url);

export interface TrustedTypes {
  /** Highlighter output as a value `innerHTML` accepts; anything not highlighter-shaped is escaped first. */
  readonly html: (markup: string) => TrustedHTML | string;
  /** The app's own worker URL as a value a registration or a `new Worker` accepts. Throws for any other URL. */
  readonly scriptUrl: (url: string) => string;
}

const refuse = (what: string): never => {
  throw new TypeError(`refused by Trusted Types: ${what}`);
};

const checkedHtml = (input: string): string =>
  isHighlightMarkup(input) ? input : refuse('markup that is not highlighter output');
const checkedScriptUrl = (input: string): string =>
  isWorkerScriptUrl(input) ? input : refuse(`a worker script that is not the app's own (${input})`);

/** The two policies over one factory, or the same rules over plain strings where there is none. */
export const createTrustedTypes = (factory: TrustedTypePolicyFactoryLike | undefined): TrustedTypes => {
  const highlight = factory?.createPolicy('fy-highlight', { createHTML: checkedHtml });
  const worker = factory?.createPolicy('fy-worker', { createScriptURL: checkedScriptUrl });
  return {
    html: markup => {
      const safe = isHighlightMarkup(markup) ? markup : escapeHtml(markup);
      return highlight?.createHTML === undefined ? safe : (highlight.createHTML(safe) as TrustedHTML);
    },
    // A TrustedScriptURL stringifies to its URL, and every registration API takes one where it takes a
    // string, so it travels typed as the string it is.
    scriptUrl: url =>
      worker?.createScriptURL === undefined ? checkedScriptUrl(url) : (worker.createScriptURL(url) as string),
  };
};

let shared: TrustedTypes | undefined;

/**
 * The page's policies, created once: the browser refuses a second policy of the same name, so every
 * caller shares these.
 */
export const trustedTypes = (): TrustedTypes => {
  shared ??= createTrustedTypes((globalThis as { trustedTypes?: TrustedTypePolicyFactoryLike }).trustedTypes);
  return shared;
};

/** Highlighter output, ready for `dangerouslySetInnerHTML`. */
export const trustedHighlight = (markup: string): TrustedHTML | string => trustedTypes().html(markup);

/** The app's own worker URL, ready for `navigator.serviceWorker.register` or `new Worker`. */
export const trustedWorkerUrl = (url: string): string => trustedTypes().scriptUrl(url);
