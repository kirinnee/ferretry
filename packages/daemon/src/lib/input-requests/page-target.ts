import type { BrowserElementTarget, InputShot, InputTarget, InputTargetFacts } from '@ferretry/protocol';
import type { BrowserInputFieldsPort, BrowserPushNumberRead } from '../browser/transport/input-contracts.ts';
import type { ClearJob, ClearOutcome } from '../sign-in-grants/clear.ts';
import type {
  InputFieldValue,
  InputTargetField,
  InputTargetPort,
  ObserveResult,
  TypeOptions,
  TypeResult,
} from './ports.ts';

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

/** A throwaway value for the dummy probe: a tilde and two random letters or digits, shorter than any code or PIN field. */
export function throwawayValue(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  return `~${[...crypto.getRandomValues(new Uint8Array(2))].map(byte => alphabet[byte % alphabet.length]).join('')}`;
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
  constructor(
    private readonly host: PageInputHost,
    private readonly dummy: () => string = throwawayValue,
  ) {}

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

  /**
   * The fields the card showed, found again in the page as it is now (`inputRefind`), in the page's own queue. A
   * page that is now another page, or a field that is not there or not one, is `target_gone`.
   */
  async refind(
    sessionId: string,
    target: InputTarget,
    fields: readonly InputTargetField[],
    expected: InputTargetFacts,
  ): Promise<ObserveResult> {
    if (target.kind !== 'browser' || expected.kind !== 'browser') return { ok: false, reason: 'unsupported' };
    const pointers: { id: string; target: BrowserElementTarget }[] = [];
    for (const field of fields) {
      if (field.element === undefined) return { ok: false, reason: 'unsupported' };
      pointers.push({ id: field.id, target: field.element });
    }
    try {
      return await this.host.inputOnPage(sessionId, target.key, async (port, pageId) => {
        if (pageId !== expected.pageId) return { ok: false, reason: 'target_gone' };
        const seen = await port.inputRefind(pageId, expected, pointers);
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
    options?: TypeOptions,
  ): Promise<TypeResult> {
    if (target.kind !== 'browser' || expected.kind !== 'browser') return 'target_gone';
    let began = false;
    try {
      return await this.host.inputOnPage(sessionId, target.key, async (port, pageId) => {
        if (pageId !== expected.pageId) return 'target_changed';
        // A grant fill that waited in this queue goes ahead only if its line is still held now.
        if (options?.proceed?.() === false) return 'target_changed';
        if (options?.armClear === 'try') {
          // An owner's value Ferretry does not submit: armed when the browser can, so a page that moves on and comes
          // back (the back/forward cache) shows the field empty. One that can't keeps its full hold instead.
          const passwords = values
            .map(value => value.field)
            .filter(
              field => expected.fields.find(each => each.fieldId === field)?.field.type?.toLowerCase() === 'password',
            );
          const armed =
            passwords.length > 0 &&
            port.inputArm !== undefined &&
            (await port.inputArm(pageId, expected, passwords).catch(() => 'refused' as const)) === 'armed';
          options.armed?.(armed);
        }
        if (options?.armClear === true) {
          // A grant fill arms its pagehide clear first, in this same turn of the page's queue. A browser that can't (or a
          // worker from before the call, which refuses it) types nothing: the clear is part of the fill.
          const passwords = values
            .map(value => value.field)
            .filter(
              field => expected.fields.find(each => each.fieldId === field)?.field.type?.toLowerCase() === 'password',
            );
          if (port.inputArm === undefined || port.inputClear === undefined) return 'target_changed';
          if ((await port.inputArm(pageId, expected, passwords)) !== 'armed') return 'target_changed';
          if (options.proceed?.() === false) return 'target_changed';
        }
        began = true;
        return await port.inputType(pageId, expected, values, submit);
      });
    } catch {
      // A failure before the write began typed nothing; one after it may have typed part of the values.
      return began ? 'uncertain' : 'target_gone';
    }
  }

  /**
   * A grant fill's check when the page hold ends (`sign-in-grants/clear.ts`), in the page's own queue: a field that still
   * holds what was typed is emptied. A page that is gone, or now another page, holds nothing: `moved`. Anything that
   * goes wrong is `unknown`, which stops the line.
   */
  async clear(sessionId: string, target: InputTarget, job: ClearJob): Promise<ClearOutcome> {
    if (target.kind !== 'browser') return 'unknown';
    try {
      return await this.host.inputOnPage(sessionId, target.key, async (port, pageId) =>
        port.inputClear === undefined ? ('unknown' as const) : await port.inputClear(pageId, job),
      );
    } catch {
      return 'unknown';
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

  /**
   * The page's document and host now, for a saved login's facts. Nothing when the page is gone, will not say, or is
   * not the page that was typed into (`surfaces`): a page opened again under the same name is another page.
   */
  async where(
    sessionId: string,
    key: string,
    surfaces: readonly string[],
  ): Promise<{ navigationId: string; host: string } | undefined> {
    try {
      const document = await this.host.inputOnPage(sessionId, key, async (port, pageId) =>
        surfaces.includes(pageId) ? await port.inputDocument(pageId) : undefined,
      );
      return document?.host === undefined ? undefined : { navigationId: document.navigationId, host: document.host };
    } catch {
      return undefined;
    }
  }

  /** What a read of the page could show, for the daemon's own look for a just-typed value. Never published. Pinned like `where`. */
  async text(sessionId: string, key: string, surfaces: readonly string[]): Promise<string | undefined> {
    try {
      return await this.host.inputOnPage(sessionId, key, async (port, pageId) =>
        surfaces.includes(pageId) ? await port.inputText?.(pageId) : undefined,
      );
    } catch {
      return undefined;
    }
  }

  /**
   * The dummy probe, inside the page's own queue so no act of the agent lands in it. The throwaway value is made here:
   * three characters (shorter than any code or PIN, and than any password a site accepts), random, never kept.
   */
  async probe(
    sessionId: string,
    target: InputTarget,
    facts: InputTargetFacts,
    fieldIds: readonly string[],
  ): Promise<'hidden' | 'shown' | 'aborted'> {
    if (target.kind !== 'browser' || facts.kind !== 'browser') return 'aborted';
    try {
      return await this.host.inputOnPage(sessionId, target.key, async (port, pageId) =>
        pageId === facts.pageId && port.inputProbe !== undefined
          ? await port.inputProbe(pageId, facts, fieldIds, this.dummy())
          : ('aborted' as const),
      );
    } catch {
      return 'aborted';
    }
  }

  /**
   * The push number the page shows (docs/input-requests.md, "Approve on your phone"), read by the browser in the page's
   * own queue, with the page's id so a page opened again under the name is told apart. Only a provider's own challenge
   * view is read: nothing the ferret points at. Nothing when the page is gone or this browser cannot read one.
   */
  async pushNumber(
    sessionId: string,
    key: string,
  ): Promise<{ readonly pageId: string; readonly read: BrowserPushNumberRead } | undefined> {
    try {
      return await this.host.inputOnPage(sessionId, key, async (port, pageId) =>
        port.pushNumberRead === undefined ? undefined : { pageId, read: await port.pushNumberRead(pageId) },
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
