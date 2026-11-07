import type { BrowserAutomation } from '../../daemon/pages/automation.ts';
import type {
  BrowserInputEvent,
  BrowserPageActionSnapshot,
  BrowserPageSnapshot,
  BrowserPageSummary,
  BrowserScreencastFrame,
} from '../../daemon/pages/wire/browser.ts';

export type Page = BrowserPageSummary & { pageState?: 'ready' | 'error' };

/**
 * The machine's agent browser, faked with REAL tabs and no active one: every act names its page,
 * every screencast streams one page, every input lands on the page it names. What a test reads back
 * is what each page received — so cross-talk between a person's tab and an agent's would show.
 */
export class Tabs {
  readonly calls: string[] = [];
  /** What each `type` put where, in order. */
  readonly typed: { readonly pageId: string; readonly text: string }[] = [];
  /** What the browser says a `type` did (a password field, an identifier box on a host). */
  typeAnswer: Pick<BrowserPageActionSnapshot, 'passwordField' | 'identifierHost'> = {};
  readonly inputs: { readonly pageId: string; readonly input: BrowserInputEvent }[] = [];
  readonly casts = new Map<string, Set<(frame: BrowserScreencastFrame) => void>>();
  pages: Page[] = [{ id: 'p0', url: 'about:blank', title: '' }];
  castFailure: Error | undefined;
  /** A dialog the worker reports on the page of every result, as a worker with a dialog open does. */
  dialog: { type: 'alert' | 'confirm' | 'prompt' | 'beforeunload'; message: string } | undefined;
  /** The browser cannot say which document a page shows. */
  documentFails = false;
  /** The host the live page reports, when a case sets one. */
  documentHost: string | undefined;
  /** While set, a click does not return: the page's queue is stuck behind it, as it is behind a dialog. */
  clickGate: Promise<void> | undefined;
  private minted = 0;
  private exited!: (code: number) => void;
  readonly exit = new Promise<number>(resolve => {
    this.exited = resolve;
  });

  die(): void {
    this.exited(1);
  }

  /** Streams one frame from a page to whoever watches that page. */
  emit(pageId: string): void {
    for (const listener of this.casts.get(pageId) ?? []) listener({ dataBase64: 'AAAA', width: 1, height: 1, pageId });
  }

  private state(pageId?: string): BrowserPageSnapshot {
    const page = this.pages.find(candidate => candidate.id === pageId) ?? (this.pages[0] as Page);
    return {
      url: page.url,
      title: page.title,
      pages: this.pages.map(({ pageState: _state, ...summary }) => summary),
      activePageId: page.id,
      pageState: page.pageState ?? 'ready',
      ...(page.pageState === 'error' ? { pageError: 'it broke' } : {}),
      canGoBack: page.pageState !== 'error',
      canGoForward: false,
    };
  }

  private acted(method: string, pageId: string): BrowserPageActionSnapshot {
    this.calls.push(`${method}:${pageId}`);
    return { ...this.state(pageId), actedPageId: pageId };
  }

  readonly automation: BrowserAutomation = {
    unexpectedExit: this.exit,
    navigate: async (pageId, url) => {
      this.pages = this.pages.map(page => (page.id === pageId ? { ...page, url } : page));
      return this.acted('navigate', pageId);
    },
    click: async pageId => {
      await this.clickGate;
      return { ...this.acted('click', pageId), ...(this.dialog === undefined ? {} : { dialog: this.dialog }) };
    },
    type: async (pageId, _target, text) => {
      this.typed.push({ pageId, text });
      return { ...this.acted('type', pageId), ...this.typeAnswer };
    },
    pointer: async (pageId, act) => this.acted(`pointer-${act.action}`, pageId),
    read: async (pageId, options) => ({ ...this.acted(`read-${options?.mode ?? 'text'}`, pageId), text: 'hello' }),
    screenshot: async pageId => ({ ...this.acted('screenshot', pageId), screenshotBase64: 'iVBOR' }),
    upload: async pageId => this.acted('upload', pageId),
    download: async pageId => ({
      ...this.acted('download', pageId),
      staged: { path: '/stage/dl-1', name: 'report.csv', size: 3 },
    }),
    pdf: async pageId => ({
      ...this.acted('pdf', pageId),
      staged: { path: '/stage/pdf-1', name: 'page.pdf', size: 5 },
    }),
    evaluate: async (pageId, script) => ({ ...this.acted('evaluate', pageId), text: `ran:${script.source}` }),
    back: async pageId => this.acted('back', pageId),
    forward: async pageId => this.acted('forward', pageId),
    reload: async pageId => this.acted('reload', pageId),
    location: async pageId => this.state(pageId),
    copyRead: async pageId => {
      this.calls.push(`copyRead:${pageId}`);
      return { ok: false, reason: 'empty' };
    },
    inputDocument: async pageId => {
      this.calls.push(`inputDocument:${pageId}`);
      if (this.documentFails) throw new Error('the page is gone');
      return { navigationId: 'loader-1', ...(this.documentHost === undefined ? {} : { host: this.documentHost }) };
    },
    inputObserve: async pageId => {
      this.calls.push(`inputObserve:${pageId}`);
      return { ok: false, missing: 'value' };
    },
    inputRefind: async pageId => {
      this.calls.push(`inputRefind:${pageId}`);
      return { ok: false, missing: 'value' };
    },
    inputShot: async pageId => {
      this.calls.push(`inputShot:${pageId}`);
      return { pngBase64: 'AAAA', clip: { x: 0, y: 0, w: 1, h: 1 } };
    },
    inputType: async pageId => {
      this.calls.push(`inputType:${pageId}`);
      return 'typed';
    },
    newPage: async options => {
      this.minted += 1;
      const id = `p${String(this.minted)}`;
      this.pages.push({
        id,
        url: options.url ?? 'about:blank',
        title: '',
        ...(options.incognito === true ? { incognito: true } : {}),
      });
      return this.acted(`new${options.incognito === true ? '-incognito' : ''}`, id);
    },
    closePage: async pageId => {
      this.pages = this.pages.filter(page => page.id !== pageId);
      this.casts.delete(pageId);
      return { ...this.state(), actedPageId: pageId };
    },
    resize: async (pageId, viewport) => this.acted(`resize-${String(viewport.width)}`, pageId),
    lifecycle: async (pageId, request) => ({
      ...this.acted(`lifecycle-${request.op}`, pageId),
      ...(this.dialog === undefined ? {} : { dialog: this.dialog }),
      lifecycle: { text: `did ${request.op}`, ...(request.op === 'wait' ? { matched: true } : {}) },
    }),
    startScreencast: async (pageId, _viewport, listener) => {
      if (this.castFailure !== undefined) throw this.castFailure;
      const set = this.casts.get(pageId) ?? new Set();
      set.add(listener);
      this.casts.set(pageId, set);
    },
    stopScreencast: async (pageId, listener) => {
      this.casts.get(pageId)?.delete(listener);
    },
    dispatchInput: async (pageId, input) => {
      this.inputs.push({ pageId, input });
    },
    close: async () => {
      this.calls.push('close');
    },
  };
}
