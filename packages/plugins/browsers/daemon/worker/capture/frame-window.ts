import type { CDPSession } from 'playwright-core';

/** A later clean DOM cannot authorize pixels rendered before the preceding clean scan. */
export class CaptureFrameWindow {
  constructor(private readonly now: () => number) {}

  private epoch = 0;
  private cleanAt: number | undefined;
  private readonly watched = new WeakSet<CDPSession>();
  private readonly ready = new WeakMap<CDPSession, Promise<void>>();

  invalidate(): void {
    this.epoch++;
    this.cleanAt = undefined;
  }

  async watch(session: CDPSession): Promise<void> {
    if (!this.watched.has(session)) {
      this.watched.add(session);
      const treeChanged = () => {
        this.ready.delete(session);
        this.invalidate();
      };
      session.on('DOM.documentUpdated', treeChanged);
      session.on('DOM.childNodeInserted', ({ node }) => {
        // Text/title animation cannot introduce a sensitive field. New element subtrees can, and
        // must be subscribed before the next clean scan. A removal cannot introduce a field;
        // its insertion/type/autocomplete change has already invalidated the earlier scan.
        if (node.nodeType !== 3 && node.nodeType !== 8) treeChanged();
      });
      session.on('DOM.shadowRootPushed', treeChanged);
      session.on('DOM.shadowRootPopped', treeChanged);
      const attributeChanged = ({ name }: { name: string }) => {
        if (['type', 'autocomplete'].includes(name.toLowerCase())) this.invalidate();
      };
      session.on('DOM.attributeModified', attributeChanged);
      session.on('DOM.attributeRemoved', attributeChanged);
    }
    let ready = this.ready.get(session);
    if (!ready) {
      ready = (async () => {
        await session.send('DOM.enable');
        // Subscribe to field/tree mutations, including closed roots. Searches alone do not subscribe
        // to attribute events, and would miss a scripted password/type flip between two clean scans.
        await session.send('DOM.getDocument', { depth: -1, pierce: true });
      })();
      this.ready.set(session, ready);
    }
    await ready;
  }

  async prime(scan: () => Promise<void>): Promise<{ before: number | undefined; completedAt: number }> {
    const epoch = this.epoch;
    const before = this.cleanAt;
    this.cleanAt = undefined;
    await scan();
    if (this.epoch !== epoch) throw new Error('browser context changed during frame inspection');
    // CDP timestamps are wall-clock seconds. Round completion UP so millisecond truncation cannot
    // authorize a frame rendered just before this scan completed.
    const completedAt = (this.now() + 1) / 1000;
    // Retain the start of the uninterrupted clean interval. Chrome can deliver a frame rendered
    // before the immediately preceding receipt scan; an earlier clean scan still brackets it.
    this.cleanAt = before ?? completedAt;
    return { before, completedAt };
  }

  async check(renderedAt: unknown, scan: () => Promise<void>): Promise<void> {
    const { before, completedAt } = await this.prime(scan);
    if (
      before === undefined ||
      typeof renderedAt !== 'number' ||
      !Number.isFinite(renderedAt) ||
      renderedAt <= before ||
      renderedAt > completedAt
    )
      throw new Error('native frame has no clean inspection before its render timestamp');
  }
}
