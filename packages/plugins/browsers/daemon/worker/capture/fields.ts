import type { CDPSession, Page, Frame } from 'playwright-core';
import type { BrowserInputFacts, BrowserInputValue } from '../../target/lib/contracts.ts';
import type { CaptureValues } from './values.ts';

export interface CaptureRect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}
export interface CaptureScan {
  readonly rects: readonly CaptureRect[];
  readonly filled: boolean;
}
const HINTS = new Set(['current-password', 'new-password', 'one-time-code']);
const MAX_NODES = 200_000;
const MAX_RECTS = 2048;

/** CDP snapshots flatten closed shadow roots and include native input values, without running page JavaScript. */
export class CaptureFields {
  private readonly nodes = new Set<string>();
  private readonly nativeNodes = new Set<string>();
  private readonly sessions = new WeakMap<Frame, Promise<CDPSession | undefined>>();
  private readonly searchable = new WeakSet<CDPSession>();
  private pending = Promise.resolve();
  captureSessions(): Promise<readonly CDPSession[]> {
    return this.frameSessions();
  }

  constructor(
    private readonly page: Page,
    private readonly session: () => Promise<CDPSession>,
    private readonly contextValues: CaptureValues,
    private readonly protection: { mark(): void; held(): boolean },
  ) {}

  rememberText(value: string): void {
    this.contextValues.remember(value);
    if (value) this.protection.mark();
  }

  /** Installed BEFORE the Vault writes: even a page that clears the field in its input listener is covered. */
  remember(facts: BrowserInputFacts, values: readonly BrowserInputValue[]): void {
    for (const value of values) {
      this.rememberText(value.text);
      const field = facts.fields.find(field => field.fieldId === value.field);
      if (field !== undefined) this.nodes.add(`${field.ownerFrame ?? field.frameId}:${field.backendNodeId}`);
    }
    if (values.some(value => value.text !== '')) {
      this.protection.mark();
    }
  }

  protectedInput(): boolean {
    return this.protection.held();
  }
  hasKnownNodes(): boolean {
    return this.nodes.size > 0;
  }

  /** Chromium's selector search includes closed shadow roots without serializing the entire DOM/layout. */
  async sensitiveNode(): Promise<boolean> {
    if (this.hasKnownNodes()) return true;
    for (const session of await this.frameSessions()) {
      if (!this.searchable.has(session)) {
        await session.send('DOM.enable');
        this.searchable.add(session);
      }
      const search = await session.send('DOM.performSearch', {
        query:
          '[type="password" i], [autocomplete~="current-password" i], [autocomplete~="new-password" i], [autocomplete~="one-time-code" i]',
        includeUserAgentShadowDOM: true,
      });
      try {
        if (!Number.isInteger(search.resultCount) || search.resultCount < 0)
          throw new Error('sensitive node search incomplete');
        if (search.resultCount > 0) return true;
      } finally {
        await session.send('DOM.discardSearchResults', { searchId: search.searchId });
      }
    }
    return false;
  }

  scan(): Promise<CaptureScan> {
    const work = this.pending.then(() => this.read());
    this.pending = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  }

  private async frameSessions(): Promise<CDPSession[]> {
    if (this.page.isClosed()) throw new Error('a related page closed during sensitive field inspection');
    const main = await this.session();
    const sessions: CDPSession[] = [main];
    for (const frame of this.page.frames()) {
      if (frame === this.page.mainFrame()) continue;
      let held = this.sessions.get(frame);
      if (held === undefined) {
        held = this.page
          .context()
          .newCDPSession(frame)
          .catch(error => {
            // In-process frames are already in the parent's snapshot. Every other failure refuses the capture.
            if (String(error).includes('does not have a separate CDP session')) return undefined;
            throw new Error('a browser frame could not be checked for sensitive fields');
          });
        this.sessions.set(frame, held);
      }
      const session = await held;
      if (session !== undefined) sessions.push(session);
      else this.sessions.delete(frame);
    }
    return sessions;
  }

  private async read(): Promise<CaptureScan> {
    const sessions = await this.frameSessions();
    const main = sessions[0];
    const rects: CaptureRect[] = [];
    const textBoxes: { text: string; rect: CaptureRect }[] = [];
    const childTexts: string[] = [];
    let filled = false;
    let childSensitive = false;
    for (const session of sessions) {
      const snapshot = await session.send('DOMSnapshot.captureSnapshot', { computedStyles: [] });
      const strings = snapshot.strings;
      const word = (index: number | undefined): string => {
        if (index === -1) return ''; // CDP's empty-string sentinel.
        const value = index === undefined ? undefined : strings[index];
        if (value === undefined) throw new Error('a browser field snapshot is incomplete');
        return value;
      };
      let count = 0;
      for (const document of snapshot.documents) {
        const nodes = document.nodes;
        const layout = new Map(document.layout.nodeIndex.map((node, index) => [node, document.layout.bounds[index]]));
        count += nodes.backendNodeId?.length ?? 0;
        if (count > MAX_NODES) throw new Error('this page is too large to check for sensitive fields');
        const frameId = word(document.frameId);
        const inputs = new Map<number, string>();
        if (nodes.inputValue !== undefined)
          for (const [at, node] of nodes.inputValue.index.entries()) inputs.set(node, word(nodes.inputValue.value[at]));
        if (nodes.textValue !== undefined)
          for (const [at, node] of nodes.textValue.index.entries()) inputs.set(node, word(nodes.textValue.value[at]));
        for (const [at, nodeId] of (nodes.backendNodeId ?? []).entries()) {
          const attributes = nodes.attributes?.[at] ?? [];
          const attrs = new Map<string, string>();
          for (let i = 0; i < attributes.length; i += 2)
            attrs.set(word(attributes[i]).toLowerCase(), word(attributes[i + 1]));
          const key = `${frameId}:${nodeId}`;
          const value = inputs.get(at) ?? '';
          const text = word(nodes.nodeValue?.[at]);
          if (text !== '') {
            const box = layout.get(at);
            if (box !== undefined) {
              if (session !== main || document !== snapshot.documents[0]) childTexts.push(text);
              else {
                const [x, y, w, h] = box;
                if (
                  x === undefined ||
                  y === undefined ||
                  w === undefined ||
                  h === undefined ||
                  !box.every(Number.isFinite)
                )
                  throw new Error('a private text box could not be measured');
                textBoxes.push({
                  text,
                  rect: { x: x - (document.scrollOffsetX ?? 0), y: y - (document.scrollOffsetY ?? 0), w, h },
                });
              }
            }
          }
          const native =
            this.nativeNodes.has(key) ||
            attrs.get('type')?.toLowerCase() === 'password' ||
            (attrs.get('autocomplete') ?? '')
              .toLowerCase()
              .split(/\s+/u)
              .some(hint => HINTS.has(hint));
          if (!native && !this.nodes.has(key) && !(value !== '' && this.contextValues.text(value) !== value)) continue;
          this.nodes.add(key);
          if (native) {
            this.nativeNodes.add(key);
            this.contextValues.observe(key, value);
            if (value) this.protection.mark();
          }
          if (value !== '') filled = true;
          if (!document.layout.nodeIndex.includes(at)) continue;
          // Mask a whole child frame. Its transform, borders and nested frames cannot leave a sliver of a field exposed.
          if (session !== main || document !== snapshot.documents[0]) {
            childSensitive = true;
            continue;
          }
          const model = await session.send('DOM.getBoxModel', { backendNodeId: nodeId });
          rects.push(rectOf(model.model.border));
        }
      }
    }
    const childRects: CaptureRect[] = [];
    if (childSensitive || childTexts.length > 0) {
      for (const frame of this.page.frames()) {
        if (frame === this.page.mainFrame()) continue;
        const element = await frame.frameElement();
        try {
          const box = await element.boundingBox();
          if (box !== null) childRects.push({ x: box.x, y: box.y, w: box.width, h: box.height });
        } finally {
          await element.dispose();
        }
      }
    }
    const values = this.contextValues;
    return {
      filled,
      // Resolve echoes only AFTER every related page has contributed its native values.
      get rects() {
        const masked = [
          ...rects,
          ...textBoxes.filter(box => values.text(box.text) !== box.text).map(box => box.rect),
          ...(childSensitive || childTexts.some(text => values.text(text) !== text) ? childRects : []),
        ];
        if (masked.length > MAX_RECTS) throw new Error('this page has too many sensitive fields to capture');
        return masked;
      },
    };
  }
}

function rectOf(points: readonly number[]): CaptureRect {
  if (points.length !== 8 || !points.every(Number.isFinite)) throw new Error('a sensitive field has no measurable box');
  const xs = points.filter((_, index) => index % 2 === 0);
  const ys = points.filter((_, index) => index % 2 !== 0);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}
