import {
  BROWSER_DEFAULT_DRAG_STEPS,
  type BrowserAction,
  BrowserActionSchema,
  type BrowserElementTarget,
  type BrowserMouseButton,
  type BrowserTarget,
  browserTargetOf,
  parseBrowserKeyChord,
} from '@ferretry/protocol';
import {
  type ActableLocator,
  type ActablePage,
  BROWSER_ACT_TIMEOUT_MS,
  browserElementOf,
  identifierFieldHost,
  isPasswordField,
} from './page-acts.ts';

/**
 * THE POINTER AND KEYS ACTS — hover, drag, mouse, press, scroll, select, check, fill-form and highlight,
 * over the few extra Playwright calls they need, written against {@link PointerPage} so each is tested
 * with a fake page and no browser.
 *
 * An act arrives as the same flat wire action the daemon parsed; the worker parses it again with the same
 * schema — it is its own program and trusts no line it reads — so the grammar lives in one place.
 */

export interface PointerLocator extends ActableLocator {
  hover(options: { readonly timeout: number }): Promise<void>;
  focus(options: { readonly timeout: number }): Promise<void>;
  dragTo(target: PointerLocator, options: { readonly timeout: number }): Promise<void>;
  scrollIntoViewIfNeeded(options: { readonly timeout: number }): Promise<void>;
  selectOption(values: string[], options: { readonly timeout: number }): Promise<string[]>;
  setChecked(checked: boolean, options: { readonly timeout: number }): Promise<void>;
  highlight(options: { readonly style: string }): Promise<unknown>;
}

export interface PointerPage extends ActablePage {
  locator(selector: string): PointerLocator;
  getByText(text: string): PointerLocator;
  evaluate<Arg>(pageFunction: (arg: Arg) => void, arg: Arg): Promise<unknown>;
  hideHighlight(): Promise<void>;
  readonly mouse: ActablePage['mouse'] & {
    move(x: number, y: number, options?: { readonly steps?: number }): Promise<void>;
    down(options?: { readonly button?: BrowserMouseButton }): Promise<void>;
    up(options?: { readonly button?: BrowserMouseButton }): Promise<void>;
    wheel(deltaX: number, deltaY: number): Promise<void>;
  };
  readonly keyboard: ActablePage['keyboard'] & { press(key: string): Promise<void> };
}

type PointerKind = 'hover' | 'drag' | 'mouse' | 'press' | 'scroll' | 'select' | 'check' | 'fill-form' | 'highlight';

/** One of the nine acts, as the wire action that carries it. */
export type PointerAct = Extract<BrowserAction, { readonly action: PointerKind }>;

const POINTER_KINDS: ReadonlySet<string> = new Set<PointerKind>([
  'hover',
  'drag',
  'mouse',
  'press',
  'scroll',
  'select',
  'check',
  'fill-form',
  'highlight',
]);

/** What a pointer act found worth telling the agent. */
export interface PointerOutcome {
  readonly passwordField: boolean;
  /**
   * A fill-form act: the fields (by their place in the act) that were identifier boxes (an email or username box,
   * `identifierFieldHost`), each with its document's host. Absent: none was.
   */
  readonly identifiers?: readonly { readonly index: number; readonly host: string }[];
}

/** The outline an agent paints around an element: loud, and clear of the page's own styling. */
export const BROWSER_HIGHLIGHT_STYLE =
  'outline: 3px solid #f59e0b; outline-offset: 2px; background-color: rgba(245, 158, 11, 0.12)';

/** An act as the worker receives it, checked: it must be one of the nine. */
export function pointerActParam(value: unknown): PointerAct {
  const act = BrowserActionSchema.parse(value);
  if (!POINTER_KINDS.has(act.action)) throw new Error(`${act.action} is not a pointer act`);
  return act as PointerAct;
}

const elementOf = (fields: { readonly selector?: string | undefined; readonly ref?: string | undefined }) =>
  browserTargetOf(fields) as BrowserElementTarget | undefined;

const timeout = { timeout: BROWSER_ACT_TIMEOUT_MS };

export async function performPointerAct(page: PointerPage, act: PointerAct): Promise<PointerOutcome> {
  switch (act.action) {
    case 'hover':
      await hover(page, browserTargetOf(act) as BrowserTarget);
      return { passwordField: false };
    case 'drag':
      await drag(page, act);
      return { passwordField: false };
    case 'mouse':
      await mouse(page, act);
      return { passwordField: false };
    case 'press':
      await press(page, act);
      return { passwordField: false };
    case 'scroll':
      await scroll(page, act);
      return { passwordField: false };
    case 'select':
      await (await field(page, elementOf(act))).selectOption([...act.values], timeout);
      return { passwordField: false };
    case 'check':
      await (await field(page, elementOf(act))).setChecked(act.checked, timeout);
      return { passwordField: false };
    case 'fill-form':
      return await fillForm(page, act);
    case 'highlight':
      await highlight(page, act);
      return { passwordField: false };
  }
}

async function field(page: PointerPage, target: BrowserElementTarget | undefined): Promise<PointerLocator> {
  if (target === undefined) throw new Error('name an element: a ref or a selector');
  return (await browserElementOf(page, target)) as PointerLocator;
}

async function hover(page: PointerPage, target: BrowserTarget): Promise<void> {
  if (target.kind === 'point') await page.mouse.move(target.x, target.y);
  else await (await field(page, target)).hover(timeout);
}

async function drag(page: PointerPage, act: Extract<PointerAct, { action: 'drag' }>): Promise<void> {
  const from = browserTargetOf({ selector: act.fromSelector, ref: act.fromRef, x: act.fromX, y: act.fromY });
  const to = browserTargetOf({ selector: act.toSelector, ref: act.toRef, x: act.toX, y: act.toY });
  if (from === undefined || to === undefined) throw new Error('name where the drag starts and where it ends');
  if (from.kind !== 'point' && to.kind !== 'point') {
    await (await field(page, from)).dragTo(await field(page, to), timeout);
    return;
  }
  if (from.kind !== 'point' || to.kind !== 'point')
    throw new Error('drag from an element to an element, or from a point to a point');
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // The button always comes back up, so a failed move never leaves the page holding a drag.
  try {
    await page.mouse.move(to.x, to.y, { steps: act.steps ?? BROWSER_DEFAULT_DRAG_STEPS });
  } finally {
    await page.mouse.up();
  }
}

async function mouse(page: PointerPage, act: Extract<PointerAct, { action: 'mouse' }>): Promise<void> {
  if (act.x !== undefined && act.y !== undefined) await page.mouse.move(act.x, act.y);
  if (act.mouseAction === 'down') await page.mouse.down({ button: act.button ?? 'left' });
  else if (act.mouseAction === 'up') await page.mouse.up({ button: act.button ?? 'left' });
  else if (act.mouseAction === 'wheel') await page.mouse.wheel(act.deltaX ?? 0, act.deltaY ?? 0);
}

async function press(page: PointerPage, act: Extract<PointerAct, { action: 'press' }>): Promise<void> {
  for (const chord of act.keys)
    if (parseBrowserKeyChord(chord) === undefined) throw new Error('a key is not in the key grammar');
  const target = elementOf(act);
  if (target !== undefined) await (await field(page, target)).focus(timeout);
  for (const chord of act.keys) await page.keyboard.press(chord);
}

async function scroll(page: PointerPage, act: Extract<PointerAct, { action: 'scroll' }>): Promise<void> {
  const target = elementOf(act);
  if (target !== undefined) {
    await (await field(page, target)).scrollIntoViewIfNeeded(timeout);
    return;
  }
  if (act.text !== undefined) {
    const place = page.getByText(act.text).first() as PointerLocator;
    if ((await place.count()) === 0) throw new Error('that text is not on the page');
    await place.scrollIntoViewIfNeeded(timeout);
    return;
  }
  await page.evaluate(
    ([left, top, pages]: readonly [number, number, number]) => {
      const scrolling = globalThis as unknown as {
        innerHeight: number;
        scrollBy(options: { left: number; top: number; behavior: 'instant' }): void;
      };
      scrolling.scrollBy({ left, top: top + pages * scrolling.innerHeight, behavior: 'instant' });
    },
    [act.deltaX ?? 0, act.deltaY ?? 0, act.pages ?? 0] as const,
  );
}

async function fillForm(page: PointerPage, act: Extract<PointerAct, { action: 'fill-form' }>): Promise<PointerOutcome> {
  let passwordField = false;
  const identifiers: { index: number; host: string }[] = [];
  for (const [index, entry] of act.fields.entries()) {
    const element = await field(page, elementOf(entry));
    if (entry.checked !== undefined) await element.setChecked(entry.checked, timeout);
    else if (entry.option !== undefined) await element.selectOption([entry.option], timeout);
    else {
      if (await isPasswordField(element)) passwordField = true;
      else {
        const host = await identifierFieldHost(element);
        if (host !== undefined) identifiers.push({ index, host });
      }
      await element.fill(entry.text ?? entry.value ?? '', timeout);
    }
  }
  return { passwordField, ...(identifiers.length === 0 ? {} : { identifiers }) };
}

async function highlight(page: PointerPage, act: Extract<PointerAct, { action: 'highlight' }>): Promise<void> {
  if (act.clear === true) await page.hideHighlight();
  else await (await field(page, elementOf(act))).highlight({ style: BROWSER_HIGHLIGHT_STYLE });
}
