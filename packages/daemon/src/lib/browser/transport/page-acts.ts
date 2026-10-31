import {
  BROWSER_MAX_COORDINATE,
  BROWSER_REF_PATTERN,
  type BrowserElementTarget,
  type BrowserModifier,
  type BrowserMouseButton,
  type BrowserReadMode,
  type BrowserScreenshotFormat,
  type BrowserTarget,
} from '@ferretry/protocol';

/**
 * WHAT THE BROWSER WORKER DOES TO ONE PAGE, over the few Playwright calls it needs.
 *
 * The worker program is a thin shell around these: it finds the page, hands it here, and reports the
 * page list after. Written against {@link ActablePage} — the slice of a Playwright `Page` these acts
 * touch, which a Playwright page satisfies as it is — so each act is tested with a fake page and no
 * browser.
 *
 * A REF IS A PLAYWRIGHT `aria-ref`. A snapshot in Playwright's `ai` mode writes `[ref=e12]` beside each
 * element and remembers what each ref pointed at; `aria-ref=e12` finds it again. A ref the page no
 * longer knows — it navigated, or was never snapshotted — is refused with the fix, never guessed at.
 */

/** How long one act may wait for its element before it is refused. */
export const BROWSER_ACT_TIMEOUT_MS = 30_000;
/** The most a read hands back; the daemon clips again to its own wire bound. */
export const BROWSER_MAX_READ_CHARS = 200_000;
/** The most matching lines a `find` hands back. */
export const BROWSER_MAX_FIND_LINES = 200;

export interface ActableLocator {
  first(): ActableLocator;
  count(): Promise<number>;
  click(options: {
    readonly timeout: number;
    readonly button?: BrowserMouseButton;
    readonly clickCount?: number;
    readonly modifiers?: BrowserModifier[];
  }): Promise<void>;
  fill(value: string, options: { readonly timeout: number }): Promise<void>;
  pressSequentially(text: string, options: { readonly timeout: number }): Promise<void>;
  press(key: string, options: { readonly timeout: number }): Promise<void>;
  innerText(options: { readonly timeout: number }): Promise<string>;
  ariaSnapshot(options: {
    readonly timeout: number;
    readonly mode?: 'ai' | 'default';
    readonly depth?: number;
    readonly boxes?: boolean;
  }): Promise<string>;
  screenshot(options: { readonly timeout: number; readonly type: BrowserScreenshotFormat }): Promise<Uint8Array>;
}

export interface ActablePage {
  locator(selector: string): ActableLocator;
  ariaSnapshot(options: {
    readonly timeout: number;
    readonly mode?: 'ai' | 'default';
    readonly depth?: number;
    readonly boxes?: boolean;
  }): Promise<string>;
  screenshot(options: {
    readonly timeout: number;
    readonly type: BrowserScreenshotFormat;
    readonly fullPage: boolean;
  }): Promise<Uint8Array>;
  readonly mouse: {
    click(
      x: number,
      y: number,
      options: { readonly button?: BrowserMouseButton; readonly clickCount?: number },
    ): Promise<void>;
  };
  readonly keyboard: { down(key: string): Promise<void>; up(key: string): Promise<void> };
}

export interface BrowserClickOptions {
  readonly button?: BrowserMouseButton;
  readonly double?: boolean;
  readonly modifiers?: readonly BrowserModifier[];
}

export interface BrowserTypeOptions {
  readonly submit?: boolean;
  readonly slowly?: boolean;
}

export interface BrowserReadOptions {
  readonly target?: BrowserElementTarget;
  readonly mode?: BrowserReadMode;
  readonly find?: string;
  readonly depth?: number;
  readonly boxes?: boolean;
}

export interface BrowserScreenshotOptions {
  readonly target?: BrowserElementTarget;
  readonly fullPage?: boolean;
  readonly format?: BrowserScreenshotFormat;
}

/** The selector Playwright resolves an element target with. */
export function browserSelectorOf(target: BrowserElementTarget): string {
  return target.kind === 'ref' ? `aria-ref=${target.ref}` : target.selector;
}

/** What an agent is told about a ref the page no longer knows. */
export function staleRefMessage(ref: string): string {
  return `${ref} is not on the page's latest snapshot (it changed, or was never read): read the page again with mode "snapshot" and use a fresh ref`;
}

/** The one element a target names. A ref the page no longer knows is refused here, with the fix. */
export async function browserElementOf(page: ActablePage, target: BrowserElementTarget): Promise<ActableLocator> {
  const element = page.locator(browserSelectorOf(target)).first();
  if (target.kind !== 'ref') return element;
  const found = await element.count().catch(() => 0);
  if (found === 0) throw new Error(staleRefMessage(target.ref));
  return element;
}

export async function clickOn(
  page: ActablePage,
  target: BrowserTarget,
  options: BrowserClickOptions = {},
): Promise<void> {
  const clickCount = options.double === true ? 2 : 1;
  const button = options.button ?? 'left';
  if (target.kind !== 'point') {
    await (
      await browserElementOf(page, target)
    ).click({
      timeout: BROWSER_ACT_TIMEOUT_MS,
      button,
      clickCount,
      ...(options.modifiers === undefined ? {} : { modifiers: [...options.modifiers] }),
    });
    return;
  }
  // A point has no element to hold modifiers for it: the keys go down around the click, and always up.
  const held: BrowserModifier[] = [];
  try {
    for (const modifier of options.modifiers ?? []) {
      await page.keyboard.down(modifier);
      held.push(modifier);
    }
    await page.mouse.click(target.x, target.y, { button, clickCount });
  } finally {
    for (const modifier of held.reverse()) await page.keyboard.up(modifier).catch(() => undefined);
  }
}

/** Replaces what a field holds with `text` — at once, or one key at a time — and presses Enter if asked. */
export async function typeInto(
  page: ActablePage,
  target: BrowserElementTarget,
  text: string,
  options: BrowserTypeOptions = {},
): Promise<void> {
  const field = await browserElementOf(page, target);
  if (options.slowly === true) {
    await field.fill('', { timeout: BROWSER_ACT_TIMEOUT_MS });
    await field.pressSequentially(text, { timeout: BROWSER_ACT_TIMEOUT_MS });
  } else await field.fill(text, { timeout: BROWSER_ACT_TIMEOUT_MS });
  if (options.submit === true) await field.press('Enter', { timeout: BROWSER_ACT_TIMEOUT_MS });
}

/**
 * Reads a page, or one element of it. A snapshot is Playwright's `ai` mode: the accessibility tree with
 * a ref beside every element and the contents of frames. A `find` keeps only the lines that contain the
 * text, case-insensitively — each line carries its own ref, so the agent can act on what it found.
 */
export async function readPage(page: ActablePage, options: BrowserReadOptions = {}): Promise<string> {
  const mode = options.mode ?? 'text';
  const scope = options.target === undefined ? undefined : await browserElementOf(page, options.target);
  let text: string;
  if (mode === 'text')
    text = await (scope ?? page.locator('body').first()).innerText({ timeout: BROWSER_ACT_TIMEOUT_MS });
  else if (mode === 'a11y')
    text = await (scope ?? page.locator('body').first()).ariaSnapshot({ timeout: BROWSER_ACT_TIMEOUT_MS });
  else {
    const snapshot = {
      timeout: BROWSER_ACT_TIMEOUT_MS,
      mode: 'ai' as const,
      ...(options.depth === undefined ? {} : { depth: options.depth }),
      ...(options.boxes === true ? { boxes: true } : {}),
    };
    text = await (scope ?? page).ariaSnapshot(snapshot);
    if (options.find !== undefined) text = findSnapshotLines(text, options.find);
  }
  return text.slice(0, BROWSER_MAX_READ_CHARS);
}

/** The lines of a snapshot that contain `needle`, case-insensitively, at most {@link BROWSER_MAX_FIND_LINES}. */
export function findSnapshotLines(snapshot: string, needle: string): string {
  const wanted = needle.toLocaleLowerCase();
  return snapshot
    .split('\n')
    .filter(line => line.toLocaleLowerCase().includes(wanted))
    .slice(0, BROWSER_MAX_FIND_LINES)
    .map(line => line.trim())
    .join('\n');
}

/** A screenshot of the viewport, the full page, or one element, as base64. */
export async function shootPage(
  page: ActablePage,
  options: BrowserScreenshotOptions = {},
): Promise<{ readonly base64: string; readonly format: BrowserScreenshotFormat }> {
  const format = options.format ?? 'png';
  const bytes =
    options.target === undefined
      ? await page.screenshot({ timeout: BROWSER_ACT_TIMEOUT_MS, type: format, fullPage: options.fullPage === true })
      : await (
          await browserElementOf(page, options.target)
        ).screenshot({ timeout: BROWSER_ACT_TIMEOUT_MS, type: format });
  return { base64: Buffer.from(bytes).toString('base64'), format };
}

/**
 * A target as the worker receives it, checked: the daemon already parsed the call, but the worker is
 * its own program and trusts no line it reads.
 */
export function browserTargetParam(value: unknown): BrowserTarget | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('target must be an object');
  const raw = value as Record<string, unknown>;
  if (raw.kind === 'selector' && typeof raw.selector === 'string' && raw.selector)
    return { kind: 'selector', selector: raw.selector };
  if (raw.kind === 'ref' && typeof raw.ref === 'string' && BROWSER_REF_PATTERN.test(raw.ref))
    return { kind: 'ref', ref: raw.ref };
  if (raw.kind === 'point' && isCoordinate(raw.x) && isCoordinate(raw.y)) return { kind: 'point', x: raw.x, y: raw.y };
  throw new Error('target is not a ref, a selector or a point');
}

/** The same, for an act that takes only an element. */
export function browserElementParam(value: unknown): BrowserElementTarget | undefined {
  const target = browserTargetParam(value);
  if (target?.kind === 'point') throw new Error('this act takes a ref or a selector, not a point');
  return target;
}

const isCoordinate = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= BROWSER_MAX_COORDINATE;
