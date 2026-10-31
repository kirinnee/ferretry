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
/** How long a look at an element's own attributes may take: the element is already there. */
export const BROWSER_PROBE_TIMEOUT_MS = 2_000;
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
  getAttribute(name: string, options: { readonly timeout: number }): Promise<string | null>;
  innerText(options: { readonly timeout: number }): Promise<string>;
  ariaSnapshot(options: {
    readonly timeout: number;
    readonly mode?: 'ai' | 'default';
    readonly depth?: number;
    readonly boxes?: boolean;
  }): Promise<string>;
  screenshot(options: { readonly timeout: number; readonly type: BrowserScreenshotFormat }): Promise<Uint8Array>;
  setInputFiles(files: string[], options: { readonly timeout: number }): Promise<void>;
  /** Runs a function expression (as text) in the element; the answer is read, never trusted. */
  evaluate(expression: string): Promise<unknown>;
  scrollIntoViewIfNeeded(options: { readonly timeout: number }): Promise<void>;
  boundingBox(options: {
    readonly timeout: number;
  }): Promise<{ readonly x: number; readonly y: number; readonly width: number; readonly height: number } | null>;
}

/** The file dialog a click opened. */
export interface ActableFileChooser {
  setFiles(files: string[], options: { readonly timeout: number }): Promise<void>;
}

/** A raw DevTools session on the page — only for the acts Playwright has no call for. */
export interface ActableCdp {
  send(method: string, params: Readonly<Record<string, unknown>>): Promise<unknown>;
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
  waitForEvent(event: 'filechooser', options: { readonly timeout: number }): Promise<ActableFileChooser>;
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

/**
 * Whether this element is a password input. A real secret never belongs in a tool call, so the acts that
 * put text in a field look first and say so; a field the check cannot read is simply not flagged.
 */
export async function isPasswordField(element: Pick<ActableLocator, 'getAttribute'>): Promise<boolean> {
  const type = await element.getAttribute('type', { timeout: BROWSER_PROBE_TIMEOUT_MS }).catch(() => null);
  return type?.trim().toLowerCase() === 'password';
}

/** What typing into a field found worth telling the agent. */
export interface BrowserTypeOutcome {
  readonly passwordField: boolean;
}

/** Replaces what a field holds with `text` — at once, or one key at a time — and presses Enter if asked. */
export async function typeInto(
  page: ActablePage,
  target: BrowserElementTarget,
  text: string,
  options: BrowserTypeOptions = {},
): Promise<BrowserTypeOutcome> {
  const field = await browserElementOf(page, target);
  const passwordField = await isPasswordField(field);
  if (options.slowly === true) {
    await field.fill('', { timeout: BROWSER_ACT_TIMEOUT_MS });
    await field.pressSequentially(text, { timeout: BROWSER_ACT_TIMEOUT_MS });
  } else await field.fill(text, { timeout: BROWSER_ACT_TIMEOUT_MS });
  if (options.submit === true) await field.press('Enter', { timeout: BROWSER_ACT_TIMEOUT_MS });
  return { passwordField };
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

/** How the files reach the page: into a file field (a dialog counts), or dropped on the element like a drag from the desktop. */
export type BrowserUploadMode = 'input' | 'drop';

const IS_FILE_INPUT = '(element) => element.tagName === "INPUT" && element.type === "file"';

/**
 * Hands `paths` (already confined by the daemon, absolute) to the page.
 *
 * INPUT: a `<input type=file>` takes them directly; anything else is clicked while the page's file
 * dialog is awaited, and the dialog is answered with them — the way a person's click would. DROP: the
 * element is scrolled into view and a drag-enter, drag-over and drop carrying the files land on its
 * centre, for a drop zone that has no input behind it.
 */
export async function uploadFiles(
  page: ActablePage,
  cdp: ActableCdp,
  target: BrowserElementTarget,
  paths: readonly string[],
  mode: BrowserUploadMode = 'input',
): Promise<void> {
  if (paths.length === 0) throw new Error('there is nothing to upload');
  const element = await browserElementOf(page, target);
  if (mode === 'input') {
    if ((await element.evaluate(IS_FILE_INPUT)) === true) {
      await element.setInputFiles([...paths], { timeout: BROWSER_ACT_TIMEOUT_MS });
      return;
    }
    const chooser = page.waitForEvent('filechooser', { timeout: BROWSER_ACT_TIMEOUT_MS });
    // A click that opens no dialog leaves this rejecting on the timeout; it is awaited below either way.
    chooser.catch(() => undefined);
    await element.click({ timeout: BROWSER_ACT_TIMEOUT_MS });
    await (await chooser).setFiles([...paths], { timeout: BROWSER_ACT_TIMEOUT_MS });
    return;
  }
  await element.scrollIntoViewIfNeeded({ timeout: BROWSER_ACT_TIMEOUT_MS });
  const box = await element.boundingBox({ timeout: BROWSER_ACT_TIMEOUT_MS });
  if (box === null || box.width <= 0 || box.height <= 0)
    throw new Error('that element has no visible area to drop onto');
  const x = Math.round(box.x + box.width / 2);
  const y = Math.round(box.y + box.height / 2);
  const data = { items: [], files: [...paths], dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver', 'drop'] as const)
    await cdp.send('Input.dispatchDragEvent', { type, x, y, data });
}

/** The one-sentence refusal a window-mode browser earns for a PDF. */
export const PDF_NEEDS_HEADLESS =
  'PDF export needs the headless browser mode: a visible Chrome window cannot print to PDF, so switch the session browser to headless and try again';

/** The page printed to PDF, as base64. */
export async function printPdf(cdp: ActableCdp): Promise<string> {
  let answer: unknown;
  try {
    answer = await cdp.send('Page.printToPDF', { printBackground: true, transferMode: 'ReturnAsBase64' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not implemented|not supported/iu.test(message)) throw new Error(PDF_NEEDS_HEADLESS);
    throw error;
  }
  const data = (answer as { readonly data?: unknown } | null)?.data;
  if (typeof data !== 'string' || data === '') throw new Error('the browser printed nothing');
  return data;
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
