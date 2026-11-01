import { AGENT_TOOL_DEFAULT_SCRIPT_MS, AGENT_TOOL_MAX_SCRIPT_MS, type BrowserElementTarget } from '@ferretry/protocol';
import { type ActableCdp, type ActablePage, browserElementOf } from './page-acts.ts';

/**
 * AN AGENT'S OWN SCRIPT, RUN IN A WORLD OF ITS OWN (`browser.eval`, owner-gated: docs/agent-tools.md).
 *
 * The script runs in an ISOLATED WORLD Ferretry creates on the page's main frame: it shares the page's
 * DOM but none of its JavaScript. The page's variables, functions and framework state are not visible
 * to the script, and nothing the page defines — a patched `JSON.stringify`, a getter on `document` —
 * can reach into it or change what it reports. It is evaluated through DevTools, so a page's Content
 * Security Policy does not refuse it, exactly as DevTools' own console is not refused.
 *
 * AN ELEMENT CROSSES WORLDS BY A MARK. Playwright finds the element (a ref or a selector) in its own
 * world; the two worlds share only the DOM, so the element is tagged with a one-time attribute, found
 * by it in the isolated world, and untagged afterwards whatever happened. The page can observe that
 * attribute for the length of the call; it cannot learn anything from it.
 *
 * The answer is text: the value as JSON, or `String(value)` when it is not serialisable. The daemon
 * clips and scrubs it like every other page text.
 */

/** The most a script's answer may hand back; the daemon clips again to its own wire bound. */
export const PAGE_SCRIPT_MAX_RESULT_CHARS = 200_000;
/** The longest origin a world may report; a longer one is dropped (it reads as unreadable), never cut. */
export const PAGE_SCRIPT_ORIGIN_MAX_CHARS = 2_048;
/** How long one read of a world's origin may take. */
const ORIGIN_READ_MS = 5_000;
/** The name the isolated world carries in DevTools. */
export const PAGE_SCRIPT_WORLD = 'ferretry-agent-script';

/** The attribute that marks the script's element, for the one call that needs it. */
const MARK = 'data-ferretry-script';

export interface PageScript {
  /** A function expression, `() => …` or `(element) => …`, as the agent wrote it. */
  readonly source: string;
  readonly target?: BrowserElementTarget;
  readonly timeoutMs?: number;
}

/** What a script handed back, as text, and the origin of the world it ran in. */
export interface PageScriptResult {
  readonly text: string;
  /**
   * The origin of the document the script's world belongs to (secrev-1282a M2, delta F1): read by DevTools in SEPARATE
   * evaluations of `location.origin` on that same world, one before the agent's code and one after, and given only when
   * both agree. Nothing the agent's evaluation returns is read for it: its source can break out of the wrapper and
   * return anything. A world belongs to one document, so a navigation destroys it and the second read fails. Absent when
   * it could not be read, the two reads differ, or the origin is opaque (`null`) or too long.
   */
  readonly origin?: string;
}

/** Just enough of a DOM element for the mark: the functions below run in the page, not here. */
interface MarkableElement {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

/** `name=value`, as one string: the page function takes one. */
const putMark = (element: MarkableElement, mark: string): void => {
  const at = mark.indexOf('=');
  element.setAttribute(mark.slice(0, at), mark.slice(at + 1));
};
const takeMark = (element: MarkableElement, name: string): void => {
  element.removeAttribute(name);
};

/** A one-time mark for a script's element. */
export type MarkMint = () => string;

/**
 * The expression the isolated world evaluates. The agent's source is spliced in as the expression it
 * already is — it can only ever be the agent's own code, in the agent's own world. The mark is
 * spliced in as a JSON string, so no mark can break out of its quotes.
 */
export function pageScriptExpression(source: string, mark: string | undefined): string {
  const element = mark === undefined ? 'undefined' : `document.querySelector(${JSON.stringify(`[${MARK}="${mark}"]`)})`;
  return `(async () => {
  const fn = (${source}
);
  if (typeof fn !== 'function') throw new TypeError('the script is not a function: write () => … or (element) => …');
  const value = await fn(${element});
  if (value === undefined) return 'undefined';
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
})()`;
}

/** The first line of what a script threw, or of why DevTools refused it. */
function thrown(details: unknown): string {
  const record = details as { exception?: { description?: unknown }; text?: unknown } | undefined;
  const text =
    typeof record?.exception?.description === 'string'
      ? record.exception.description
      : typeof record?.text === 'string'
        ? record.text
        : 'the script failed';
  return `the script threw: ${text.replace(/[\r\n][\s\S]*$/u, '')}`;
}

/**
 * The origin of the world `contextId`, read by DevTools in an evaluation of its own with no agent code in it. `location`
 * and its `origin` are unforgeable even in that world. `undefined` when the read fails or the origin is opaque or too long.
 */
async function worldOrigin(cdp: ActableCdp, contextId: number): Promise<string | undefined> {
  const read = (await withinTime(
    cdp.send('Runtime.evaluate', { expression: 'location.origin', contextId, returnByValue: true }),
    ORIGIN_READ_MS,
  ).catch(() => undefined)) as { result?: { value?: unknown }; exceptionDetails?: unknown } | undefined;
  const value = read?.exceptionDetails === undefined ? read?.result?.value : undefined;
  return typeof value === 'string' && value !== 'null' && value.length <= PAGE_SCRIPT_ORIGIN_MAX_CHARS
    ? value
    : undefined;
}

/** `work`, or a refusal once `ms` have passed without it settling. */
async function withinTime<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the script ran past ${String(ms)} ms and was stopped`)), ms);
  });
  try {
    return await Promise.race([work, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** Runs one agent script on a page, in an isolated world, and answers what it returned, as text. */
export async function runPageScript(
  page: ActablePage,
  cdp: ActableCdp,
  script: PageScript,
  mint: MarkMint,
): Promise<PageScriptResult> {
  const timeout = Math.min(Math.max(script.timeoutMs ?? AGENT_TOOL_DEFAULT_SCRIPT_MS, 1), AGENT_TOOL_MAX_SCRIPT_MS);
  const element = script.target === undefined ? undefined : await browserElementOf(page, script.target);
  const mark = element === undefined ? undefined : mint();
  if (element !== undefined && mark !== undefined) await element.evaluate(putMark, `${MARK}=${mark}`);
  try {
    const tree = (await cdp.send('Page.getFrameTree', {})) as { frameTree?: { frame?: { id?: unknown } } };
    const frameId = tree.frameTree?.frame?.id;
    if (typeof frameId !== 'string') throw new Error('the page has no frame to run a script in');
    const world = (await cdp.send('Page.createIsolatedWorld', {
      frameId,
      worldName: PAGE_SCRIPT_WORLD,
      grantUniveralAccess: false,
    })) as { executionContextId?: unknown };
    if (typeof world.executionContextId !== 'number') throw new Error('the browser made no world to run the script in');
    // The world's origin, read before the agent's code runs and again after, each in an evaluation of its own.
    const before = await worldOrigin(cdp, world.executionContextId);
    // DevTools' own timeout stops a script that runs; a script that only waits is stopped here.
    const answer = (await withinTime(
      cdp.send('Runtime.evaluate', {
        expression: pageScriptExpression(script.source, mark),
        contextId: world.executionContextId,
        awaitPromise: true,
        returnByValue: true,
        timeout,
      }),
      timeout,
    )) as { result?: { value?: unknown }; exceptionDetails?: unknown };
    if (answer.exceptionDetails !== undefined) throw new Error(thrown(answer.exceptionDetails));
    const value = answer.result?.value;
    const after = await worldOrigin(cdp, world.executionContextId);
    const origin = before !== undefined && before === after ? before : undefined;
    return {
      text: (typeof value === 'string' ? value : String(value)).slice(0, PAGE_SCRIPT_MAX_RESULT_CHARS),
      ...(origin === undefined ? {} : { origin }),
    };
  } finally {
    if (element !== undefined) await element.evaluate(takeMark, MARK).catch(() => undefined);
  }
}
