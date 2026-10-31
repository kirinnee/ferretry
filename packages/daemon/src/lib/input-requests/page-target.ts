import type { BrowserElementTarget, InputShot, InputTarget, InputTargetFacts } from '@ferretry/protocol';
import type { BrowserInputFieldsPort } from '../browser/transport/input-contracts.ts';
import type { InputFieldValue, InputTargetField, InputTargetPort, ObserveResult, TypeResult } from './ports.ts';

/**
 * The browser as the input bridge needs it: run one look, picture or write on a session's named page, inside
 * that page's own queue (`BrowserSubsystem.inputOnPage`). It refuses a page that is not the session's.
 */
export interface PageInputHost {
  inputOnPage<T>(
    sessionId: string,
    key: string,
    work: (fields: BrowserInputFieldsPort, pageId: string) => Promise<T>,
  ): Promise<T>;
}

/**
 * A PAGE AS AN INPUT TARGET (docs/input-requests.md, "Pages"): the browser observes the fields the agent pointed
 * at, and the one write goes to exactly the nodes the card showed.
 *
 * Every call runs in the page's own queue, so no act of the agent lands between the browser's re-check and its
 * write. A page that is gone or not the session's is `target_gone`; a page that is now another page (its id
 * changed under the same name) is `target_changed`. Only the write can be `uncertain`, and only once it began.
 */
export class PageInputTarget implements InputTargetPort {
  constructor(private readonly host: PageInputHost) {}

  async observe(sessionId: string, target: InputTarget, fields: readonly InputTargetField[]): Promise<ObserveResult> {
    if (target.kind !== 'browser') return { ok: false, reason: 'unsupported' };
    const pointers: { id: string; target: BrowserElementTarget }[] = [];
    for (const field of fields) {
      if (field.element === undefined) return { ok: false, reason: 'unsupported' };
      pointers.push({ id: field.id, target: field.element });
    }
    try {
      return await this.host.inputOnPage(sessionId, target.key, async (port, pageId) => {
        const seen = await port.inputObserve(pageId, pointers);
        if (!seen.ok || seen.facts.pageId !== pageId) return { ok: false, reason: 'target_gone' };
        return { ok: true, facts: seen.facts, names: [pageId] };
      });
    } catch {
      return { ok: false, reason: 'target_gone' };
    }
  }

  async type(
    sessionId: string,
    target: InputTarget,
    values: readonly InputFieldValue[],
    submit: boolean,
    expected: InputTargetFacts,
  ): Promise<TypeResult> {
    if (target.kind !== 'browser' || expected.kind !== 'browser') return 'target_gone';
    let began = false;
    try {
      return await this.host.inputOnPage(sessionId, target.key, async (port, pageId) => {
        if (pageId !== expected.pageId) return 'target_changed';
        began = true;
        return await port.inputType(pageId, expected, values, submit);
      });
    } catch {
      // A failure before the write began typed nothing; one after it may have typed part of the values.
      return began ? 'uncertain' : 'target_gone';
    }
  }

  /** A picture of the fields for the owner's card, taken before anything is typed; nothing when it cannot be had. */
  async shoot(sessionId: string, target: InputTarget, facts: InputTargetFacts): Promise<InputShot | undefined> {
    if (target.kind !== 'browser' || facts.kind !== 'browser') return undefined;
    try {
      return await this.host.inputOnPage(sessionId, target.key, async (port, pageId) =>
        pageId === facts.pageId ? await port.inputShot(pageId, facts) : undefined,
      );
    } catch {
      return undefined;
    }
  }

  /** The document the page shows now, or nothing when the page is gone: a quarantine ends early once it changed. */
  async document(sessionId: string, key: string): Promise<string | undefined> {
    try {
      return await this.host.inputOnPage(
        sessionId,
        key,
        async (port, pageId) => (await port.inputDocument(pageId)).navigationId,
      );
    } catch {
      return undefined;
    }
  }
}
