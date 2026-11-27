import type { BrowserContext, CDPSession, Page } from 'playwright-core';
import { InputTargetFactsSchema } from '@ferretry/core-vault/contract';
import type { BrowserElementTarget } from '../../../contract/wire/target.ts';
import { browserElementOf, type BrowserScreenshotOptions } from '../../pages/page-acts.ts';
import type { BrowserInputFacts } from '../../target/lib/contracts.ts';
import { CaptureFields, type CaptureRect, type CaptureScan } from './fields.ts';
import { CapturePixels } from './pixels.ts';
import { CaptureValues } from './values.ts';

export interface CaptureFrameEvent {
  readonly data?: unknown;
  readonly sessionId?: unknown;
  readonly metadata?: { readonly deviceWidth?: unknown; readonly deviceHeight?: unknown };
}

/** One capture boundary for the worker's tools, live stream and recording stream. */
export class BrowserCapture {
  private readonly fields = new WeakMap<Page, CaptureFields>();
  private readonly pixels: CapturePixels;
  private readonly pixelTurns = new WeakMap<BrowserContext, Promise<void>>();
  private readonly writers = new WeakMap<BrowserContext, number>();
  private readonly failedContexts = new WeakSet<BrowserContext>();
  private readonly masksByContext = new WeakMap<BrowserContext, CaptureValues>();
  private readonly protectedContexts = new WeakSet<BrowserContext>();
  private readonly contextEpochs = new WeakMap<BrowserContext, number>();
  private readonly sensitiveContexts = new WeakSet<BrowserContext>();

  private watchContext(context: BrowserContext): void {
    if (this.contextEpochs.has(context)) return;
    this.contextEpochs.set(context, 0);
    const changed = () => this.contextEpochs.set(context, (this.contextEpochs.get(context) ?? 0) + 1);
    const watch = (page: Page) => {
      page.on('close', changed);
      page.on('crash', changed);
      page.on('framenavigated', changed);
      page.on('frameattached', changed);
      page.on('framedetached', changed);
    };
    for (const page of context.pages()) watch(page);
    context.on('page', page => {
      changed();
      watch(page);
    });
  }

  constructor(
    private readonly session: (page: Page) => Promise<CDPSession>,
    makeCompositor: () => Promise<Page>,
    private readonly deadline: <T>(work: Promise<T>) => Promise<T>,
  ) {
    this.pixels = new CapturePixels(makeCompositor);
  }

  of(page: Page): CaptureFields {
    this.watchContext(page.context());
    let fields = this.fields.get(page);
    if (fields === undefined) {
      const context = page.context();
      fields = new CaptureFields(page, () => this.session(page), this.masks(page), {
        mark: () => this.protectedContexts.add(context),
        held: () => this.protectedContexts.has(context),
      });
      this.fields.set(page, fields);
    }
    return fields;
  }

  masks(page: Page): CaptureValues {
    let masks = this.masksByContext.get(page.context());
    if (masks === undefined) {
      masks = new CaptureValues();
      this.masksByContext.set(page.context(), masks);
    }
    return masks;
  }

  rememberInput(page: Page, params: Readonly<Record<string, unknown>>): void {
    const facts = InputTargetFactsSchema.safeParse(params.expected);
    if (!facts.success || facts.data.kind !== 'page' || !Array.isArray(params.values)) return;
    const values = params.values.flatMap(value =>
      value !== null && typeof value === 'object' && typeof value.field === 'string' && typeof value.text === 'string'
        ? [{ field: value.field, text: value.text }]
        : [],
    );
    this.of(page).remember(facts.data as BrowserInputFacts, values);
  }

  async rememberType(page: Page, target: BrowserElementTarget, text: string): Promise<void> {
    const element = await browserElementOf(page, target);
    const type = await element.getAttribute('type', { timeout: 2000 });
    const autocomplete = await element.getAttribute('autocomplete', { timeout: 2000 });
    if (
      type?.toLowerCase() === 'password' ||
      (autocomplete ?? '')
        .split(/\s+/u)
        .some(hint => ['current-password', 'new-password', 'one-time-code'].includes(hint.toLowerCase()))
    )
      this.of(page).rememberText(text);
  }

  async inspect(pages: readonly Page[]): Promise<void> {
    // A tab can echo a native value held by any other tab in its context. Discover all values first.
    await this.bounded(async () => {
      for (const context of new Set(pages.map(page => page.context()))) await this.inspectContext(context);
    });
  }

  private async inspectContext(context: BrowserContext): Promise<Map<Page, CaptureScan>> {
    this.watchContext(context);
    const epoch = this.contextEpochs.get(context);
    const scans = new Map<Page, CaptureScan>();
    for (const page of context.pages()) {
      const scan = await this.of(page).scan();
      scans.set(page, scan);
      if (this.of(page).hasKnownNodes()) this.sensitiveContexts.add(context);
    }
    if (epoch !== this.contextEpochs.get(context))
      throw new Error('related pages changed during sensitive field inspection');
    return scans;
  }

  async binary(page: Page): Promise<void> {
    await this.inspect([page]);
    if (this.protectedContexts.has(page.context()))
      throw new Error(
        "PDF and downloads are withheld because this browser context received a sensitive value; restart this identity's browser to export again",
      );
  }
  private bounded<T>(work: () => Promise<T>): Promise<T> {
    return this.deadline(work());
  }

  /** A pixel capture owns one short turn with actual input writes; ack, stop and dialog dismissal never take this lock. */
  async write<T>(page: Page, work: () => Promise<T>): Promise<T> {
    return await this.writeContext(page.context(), work);
  }

  async writeContext<T>(context: BrowserContext, work: () => Promise<T>): Promise<T> {
    while (this.pixelTurns.has(context)) await this.pixelTurns.get(context);
    this.writers.set(context, (this.writers.get(context) ?? 0) + 1);
    try {
      return await work();
    } finally {
      this.writers.set(context, (this.writers.get(context) ?? 1) - 1);
    }
  }

  private async pixelTurn<T>(context: BrowserContext, work: () => Promise<T>): Promise<T> {
    while (this.pixelTurns.has(context)) await this.pixelTurns.get(context);
    let release: () => void = () => undefined;
    const turn = new Promise<void>(resolve => {
      release = resolve;
    });
    this.pixelTurns.set(context, turn);
    try {
      if ((this.writers.get(context) ?? 0) > 0)
        throw new Error('a renderer write is in flight; pixels are withheld until it finishes');
      return await work();
    } finally {
      this.pixelTurns.delete(context);
      release();
    }
  }

  private async frozen<T>(page: Page, work: (session: CDPSession, scan: CaptureScan) => Promise<T>): Promise<T> {
    return await this.pixelTurn(page.context(), async () => {
      if (this.failedContexts.has(page.context()))
        throw new Error("browser capture state could not be restored; restart this identity's browser");
      const session = await this.session(page);
      this.watchContext(page.context());
      const epoch = this.contextEpochs.get(page.context());
      const roots = await Promise.all(
        page
          .context()
          .pages()
          .filter(each => !each.isClosed())
          .map(async page => ({ page, session: await this.session(page) })),
      );
      const rates: { session: CDPSession; rate: number }[] = [];
      let result: T;
      let live = true;
      try {
        await this.bounded(async () => {
          for (const each of roots) {
            if (!live) return;
            await each.session.send('Page.setWebLifecycleState', { state: 'frozen' });
            if (!live && !each.page.isClosed())
              await each.session.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {
                if (!each.page.isClosed()) this.failedContexts.add(page.context());
              });
          }
        });
        result = await this.bounded(async () => {
          if (epoch !== this.contextEpochs.get(page.context()))
            throw new Error('related pages changed during capture; pixels withheld');
          for (const each of await this.of(page).captureSessions()) {
            await each.send('Animation.enable');
            if (!live) throw new Error('capture ended');
            const { playbackRate } = await each.send('Animation.getPlaybackRate');
            if (!live) throw new Error('capture ended');
            rates.push({ session: each, rate: playbackRate });
            await each.send('Animation.setPlaybackRate', { playbackRate: 0 });
          }
          const tree = await session.send('Page.getFrameTree');
          const world = await session.send('Page.createIsolatedWorld', {
            frameId: tree.frameTree.frame.id,
            worldName: 'ferretry-capture-render',
            grantUniveralAccess: false,
          });
          await session.send('Runtime.evaluate', {
            contextId: world.executionContextId,
            expression: 'window.scrollTo({left:window.scrollX,top:window.scrollY,behavior:"instant"})',
            returnByValue: true,
          });
          const scans = await this.inspectContext(page.context());
          const scan = scans.get(page);
          if (scan === undefined) throw new Error('capture page disappeared during inspection');
          const answer = await work(session, scan);
          if (epoch !== this.contextEpochs.get(page.context()))
            throw new Error('related pages changed during capture; pixels withheld');
          return answer;
        });
      } finally {
        live = false;
        await Promise.allSettled(
          rates.flatMap(each => [
            this.bounded(() => each.session.send('Animation.setPlaybackRate', { playbackRate: each.rate })).catch(
              () => {
                if (!page.isClosed()) this.failedContexts.add(page.context());
              },
            ),
            this.bounded(() => each.session.send('Animation.disable')).catch(() => {
              if (!page.isClosed()) this.failedContexts.add(page.context());
            }),
          ]),
        );
        await Promise.allSettled(
          roots.map(each =>
            each.page.isClosed()
              ? Promise.resolve()
              : this.bounded(() => each.session.send('Page.setWebLifecycleState', { state: 'active' })).catch(() => {
                  if (!each.page.isClosed()) this.failedContexts.add(page.context());
                }),
          ),
        );
      }
      if (this.failedContexts.has(page.context()))
        throw new Error("browser capture state could not be restored; restart this identity's browser");
      return result;
    });
  }

  async screenshot(page: Page, options: BrowserScreenshotOptions): Promise<{ base64: string; format: 'png' | 'jpeg' }> {
    const element = options.target === undefined ? undefined : await browserElementOf(page, options.target);
    if (element !== undefined)
      await this.write(page, async () => await element.scrollIntoViewIfNeeded({ timeout: 2000 }));
    return await this.frozen(page, async session => {
      const fields = this.of(page);
      const before = await fields.scan();
      const generation = JSON.stringify(await session.send('Page.getFrameTree'));
      const metrics = await session.send('Page.getLayoutMetrics');
      const viewport = metrics.cssVisualViewport;
      let clip: CaptureRect = { x: 0, y: 0, w: viewport.clientWidth, h: viewport.clientHeight };
      if (options.fullPage === true)
        clip = {
          x: -viewport.pageX,
          y: -viewport.pageY,
          w: metrics.cssContentSize.width,
          h: metrics.cssContentSize.height,
        };
      if (element !== undefined) {
        const box = await element.boundingBox({ timeout: 2000 });
        if (box === null) throw new Error('the screenshot target has no measurable box');
        clip = { x: box.x, y: box.y, w: box.width, h: box.height };
      }
      const format = options.format ?? 'png';
      const shot = await session.send('Page.captureScreenshot', {
        format,
        fromSurface: true,
        captureBeyondViewport:
          clip.x < 0 || clip.y < 0 || clip.x + clip.w > viewport.clientWidth || clip.y + clip.h > viewport.clientHeight,
        clip: { x: clip.x + viewport.pageX, y: clip.y + viewport.pageY, width: clip.w, height: clip.h, scale: 1 },
      });
      const after = await fields.scan();
      const stable =
        generation === JSON.stringify(await session.send('Page.getFrameTree')) &&
        JSON.stringify(before.rects) === JSON.stringify(after.rects) &&
        JSON.stringify(metrics) === JSON.stringify(await session.send('Page.getLayoutMetrics'));
      if (!stable) throw new Error('the page changed during capture, so its pixels are withheld; try again');
      const base64 = await this.pixels.paint(shot.data, format, before.rects, clip);
      if (base64.length > 24 * 1024 * 1024) throw new Error('the masked screenshot exceeds the capture limit');
      return { base64, format };
    });
  }

  async fieldShot(page: Page, work: () => Promise<{ shot?: unknown }>): Promise<Record<string, unknown>> {
    return await this.frozen(page, async session => {
      const fields = this.of(page);
      const before = await fields.scan();
      const generation = JSON.stringify(await session.send('Page.getFrameTree'));
      const result = await work();
      const shot = result.shot as { pngBase64: string; clip: CaptureRect };
      const after = await fields.scan();
      if (
        generation !== JSON.stringify(await session.send('Page.getFrameTree')) ||
        JSON.stringify(before.rects) !== JSON.stringify(after.rects)
      )
        throw new Error('the page changed during its field capture');
      return { shot: { ...shot, pngBase64: await this.pixels.paint(shot.pngBase64, 'png', before.rects, shot.clip) } };
    });
  }

  async frame(page: Page, nativePixels: string): Promise<string> {
    const context = page.context();
    if (!this.sensitiveContexts.has(context) && !this.protectedContexts.has(context)) {
      return await this.pixelTurn(context, async () => {
        if (this.failedContexts.has(context)) throw new Error('browser capture state unavailable');
        this.watchContext(context);
        const epoch = this.contextEpochs.get(context);
        const sensitive = await this.bounded(async () => {
          for (const related of context.pages()) {
            if (await this.of(related).sensitiveNode()) return true;
          }
          return false;
        });
        if (sensitive) {
          this.sensitiveContexts.add(context);
          // Drop this trigger. The next frame takes one frozen context scan, with no second scan here.
          throw new Error('sensitive node discovered; native pixels withheld');
        }
        if (epoch !== this.contextEpochs.get(context) || this.protectedContexts.has(context))
          throw new Error('browser context changed during capture');
        return nativePixels;
      });
    }
    // Native pixels have old geometry. A protected frame owns one frozen context scan and a fresh image.
    return await this.frozen(page, async (session, scan) => {
      const { cssVisualViewport: viewport } = await session.send('Page.getLayoutMetrics');
      const shot = await session.send('Page.captureScreenshot', { format: 'jpeg', quality: 50, fromSurface: true });
      return await this.pixels.paint(shot.data, 'jpeg', scan.rects, {
        x: 0,
        y: 0,
        w: viewport.clientWidth,
        h: viewport.clientHeight,
      });
    });
  }
}
