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
  private pending = Promise.resolve();
  private documents: { session: CDPSession; frameId: string }[] = [];
  captureSessions(): readonly CDPSession[] {
    return [...new Set(this.documents.map(document => document.session))];
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
  async binary(): Promise<void> {
    const scan = await this.scan();
    if (this.protection.held() || scan.filled)
      throw new Error(
        "PDF and downloads are withheld because this browser context received a sensitive value; restart this identity's browser to export again",
      );
  }

  scan(): Promise<CaptureScan> {
    const work = this.pending.then(() => this.read());
    this.pending = work.then(
      () => undefined,
      () => undefined,
    );
    return work;
  }

  private async read(): Promise<CaptureScan> {
    if (this.page.isClosed()) return { rects: [], filled: false };
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
    const rects: CaptureRect[] = [];
    let filled = false;
    let childSensitive = false;
    this.documents = [];
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
        count += nodes.backendNodeId?.length ?? 0;
        if (count > MAX_NODES) throw new Error('this page is too large to check for sensitive fields');
        const frameId = word(document.frameId);
        this.documents.push({ session, frameId });
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
          if (text !== '' && this.contextValues.text(text) !== text) {
            const layout = document.layout.nodeIndex.indexOf(at);
            const box = document.layout.bounds[layout];
            if (box !== undefined) {
              if (session !== main || document !== snapshot.documents[0]) childSensitive = true;
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
                rects.push({ x: x - (document.scrollOffsetX ?? 0), y: y - (document.scrollOffsetY ?? 0), w, h });
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
    if (childSensitive) {
      for (const frame of this.page.frames()) {
        if (frame === this.page.mainFrame()) continue;
        const element = await frame.frameElement();
        try {
          const box = await element.boundingBox();
          if (box !== null) rects.push({ x: box.x, y: box.y, w: box.width, h: box.height });
        } finally {
          await element.dispose();
        }
      }
    }
    if (rects.length > MAX_RECTS) throw new Error('this page has too many sensitive fields to capture');
    return { rects, filled };
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
