import { InputTargetFactsSchema } from '@ferretry/core-vault/contract';
import { type PushNumberPage, readPushNumber } from '../../challenges/push-number-read.ts';
import {
  BROWSER_INPUT_WORKER_METHODS,
  type BrowserInputClearJob,
  type BrowserInputFacts,
  type BrowserInputValue,
} from './contracts.ts';
import { type ElementTarget, elementParam } from './element.ts';
import {
  armInputFields,
  clearInputFields,
  describeInputDocument,
  type InputCdpSession,
  type InputSubject,
  observeInputFields,
  probeInputFields,
  readInputText,
  refindInputFields,
  shootInputFields,
  typeInputFields,
} from './fields.ts';

/**
 * THE WORKER'S SIDE OF THE PAGE INPUT SEAM: one JSON-line method per call of {@link BROWSER_INPUT_WORKER_METHODS},
 * copied from today's `daemon/bin/browser-worker.ts` (`inputType`, `inputArm`, `inputClear`, `inputProbe` and the
 * `input*` / `pushNumberRead` cases of its dispatch). The worker program (the browser's own process) hands each
 * request whose method is one of these to {@link serveInputMethod}, with how to reach the page it names.
 *
 * Every parameter is parsed here, because the worker trusts no line it reads. The write, the arm, the clear and the
 * probe catch EVERYTHING and answer a word: an error's first line would ride on the wire, and a value must never.
 */

/** How the worker reaches a page by the id the daemon names it by. `subject` throws for a page that is gone. */
export interface InputWorkerPages {
  subject(pageId: unknown): InputSubject;
  /** The page's own DevTools session, for the field shot. */
  session(pageId: unknown): Promise<InputCdpSession>;
  /** The page as `page.evaluate` reaches its main frame, for the push number. */
  pushPage(pageId: unknown): PushNumberPage;
}

const INPUT_METHODS: ReadonlySet<string> = new Set(Object.values(BROWSER_INPUT_WORKER_METHODS));

/** Whether a worker request is one of the page input seam's. */
export const isInputMethod = (method: string): boolean => INPUT_METHODS.has(method);

/** The input bridge's page facts as the worker receives them: parsed, because it trusts no line. */
function pageFactsParam(value: unknown): BrowserInputFacts {
  const parsed = InputTargetFactsSchema.safeParse(value);
  if (!parsed.success || parsed.data.kind !== 'page') throw new Error('facts are not page facts');
  return parsed.data;
}

function inputPointers(value: unknown): { readonly id: string; readonly target: ElementTarget }[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('fields are required');
  return value.map(item => {
    const raw = (item ?? {}) as Record<string, unknown>;
    const target = elementParam(raw.target);
    if (typeof raw.id !== 'string' || raw.id === '' || target === undefined)
      throw new Error('a field needs an id and a target');
    return { id: raw.id, target };
  });
}

/**
 * The one write of an owner's values. EVERYTHING is caught here and answers a word, because `answer` would
 * put an error's first line on the wire and a value must never ride in one.
 */
async function inputType(
  pages: InputWorkerPages,
  params: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  let subject: InputSubject;
  try {
    subject = pages.subject(params.pageId);
  } catch {
    return { outcome: 'target_gone' };
  }
  let expected: BrowserInputFacts;
  let values: BrowserInputValue[];
  try {
    expected = pageFactsParam(params.expected);
    if (!Array.isArray(params.values)) throw new Error('values are required');
    values = params.values.map(item => {
      const raw = (item ?? {}) as Record<string, unknown>;
      if (typeof raw.field !== 'string' || typeof raw.text !== 'string')
        throw new Error('a value needs a field and text');
      return { field: raw.field, text: raw.text };
    });
  } catch {
    return { outcome: 'target_changed' };
  }
  try {
    return { outcome: await typeInputFields(subject, expected, values, params.submit === true) };
  } catch {
    return { outcome: 'uncertain' };
  }
}

/** A grant fill arms its `pagehide` clear before the write: anything malformed or failing is `refused`, so nothing is typed. */
async function inputArm(
  pages: InputWorkerPages,
  params: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  try {
    const subject = pages.subject(params.pageId);
    const expected = pageFactsParam(params.expected);
    if (!Array.isArray(params.fieldIds) || !params.fieldIds.every(id => typeof id === 'string'))
      return { outcome: 'refused' };
    return { outcome: await armInputFields(subject, expected, params.fieldIds as string[]) };
  } catch {
    return { outcome: 'refused' };
  }
}

/** A clear job as the daemon sent it, checked field by field: a frame and a node each, and nothing else. */
function clearJobParam(raw: unknown): BrowserInputClearJob {
  const job = (raw ?? {}) as Record<string, unknown>;
  if (typeof job.navigationId !== 'string' || job.navigationId === '' || !Array.isArray(job.fields))
    throw new Error('a clear job needs a document and fields');
  const fields = job.fields.map(item => {
    const field = (item ?? {}) as Record<string, unknown>;
    if (
      typeof field.frameId !== 'string' ||
      typeof field.backendNodeId !== 'number' ||
      !Number.isInteger(field.backendNodeId) ||
      field.backendNodeId <= 0
    )
      throw new Error('a clear field needs a frame and a node');
    return { frameId: field.frameId, backendNodeId: field.backendNodeId };
  });
  if (fields.length === 0 || fields.length > 8) throw new Error('a clear job names 1 to 8 fields');
  return { navigationId: job.navigationId, fields };
}

/**
 * A grant fill's check before its page hold ends. A page that is gone holds nothing (`moved`); anything malformed or
 * failing is `unknown`, which stops the line. The job names nodes, never a value.
 */
async function inputClear(
  pages: InputWorkerPages,
  params: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  let subject: InputSubject;
  try {
    subject = pages.subject(params.pageId);
  } catch {
    return { outcome: 'moved' };
  }
  try {
    return { outcome: await clearInputFields(subject, clearJobParam(params.job)) };
  } catch {
    return { outcome: 'unknown' };
  }
}

/** The dummy probe: anything malformed or failing is `aborted`, which only ever makes the lock longer. */
async function inputProbe(
  pages: InputWorkerPages,
  params: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  try {
    const subject = pages.subject(params.pageId);
    const expected = pageFactsParam(params.expected);
    if (!Array.isArray(params.fieldIds) || !params.fieldIds.every(id => typeof id === 'string'))
      return { outcome: 'aborted' };
    if (typeof params.dummy !== 'string' || params.dummy === '') return { outcome: 'aborted' };
    return { outcome: await probeInputFields(subject, expected, params.fieldIds as string[], params.dummy) };
  } catch {
    return { outcome: 'aborted' };
  }
}

/**
 * Answers one page input request. A read that fails throws (the worker answers its fixed error); the four acts that
 * can carry or touch a value answer a word instead. A method that is not one of the seam's is refused.
 */
export async function serveInputMethod(
  pages: InputWorkerPages,
  method: string,
  params: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  switch (method) {
    case BROWSER_INPUT_WORKER_METHODS.pushNumber: {
      const subject = pages.subject(params.pageId);
      return {
        read: await readPushNumber(pages.pushPage(params.pageId), async () => await describeInputDocument(subject)),
      };
    }
    case BROWSER_INPUT_WORKER_METHODS.document:
      return { document: await describeInputDocument(pages.subject(params.pageId)) };
    case BROWSER_INPUT_WORKER_METHODS.text:
      return { text: await readInputText(pages.subject(params.pageId)) };
    case BROWSER_INPUT_WORKER_METHODS.observe:
      return { observation: await observeInputFields(pages.subject(params.pageId), inputPointers(params.fields)) };
    case BROWSER_INPUT_WORKER_METHODS.refind:
      return {
        observation: await refindInputFields(
          pages.subject(params.pageId),
          pageFactsParam(params.expected),
          inputPointers(params.fields),
        ),
      };
    case BROWSER_INPUT_WORKER_METHODS.shot:
      return { shot: await shootInputFields(await pages.session(params.pageId), pageFactsParam(params.facts)) };
    case BROWSER_INPUT_WORKER_METHODS.type:
      return await inputType(pages, params);
    case BROWSER_INPUT_WORKER_METHODS.probe:
      return await inputProbe(pages, params);
    case BROWSER_INPUT_WORKER_METHODS.arm:
      return await inputArm(pages, params);
    case BROWSER_INPUT_WORKER_METHODS.clear:
      return await inputClear(pages, params);
    default:
      throw new Error('not a page input method');
  }
}
