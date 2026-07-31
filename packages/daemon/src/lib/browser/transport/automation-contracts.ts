import type {
  BrowserInputEvent,
  BrowserPageActionSnapshot,
  BrowserPageSnapshot,
  BrowserScreencastFrame,
  BrowserViewport,
} from '@ferretry/protocol';

/**
 * The browser driver, seen from the daemon. One implementation drives a real browser worker; the
 * runtime that owns sessions depends only on this.
 *
 * Every action reports which page it acted on, because a click can open a popup that becomes the
 * active tab — provenance and current state are different questions.
 */
export interface BrowserAutomation {
  /** Resolves with an exit code when the driver dies on its own. Never rejects. */
  readonly unexpectedExit: Promise<number>;
  navigate(url: string): Promise<BrowserPageActionSnapshot>;
  click(selector: string): Promise<BrowserPageActionSnapshot>;
  type(selector: string, text: string): Promise<BrowserPageActionSnapshot>;
  read(selector?: string): Promise<BrowserPageActionSnapshot & { readonly text: string }>;
  screenshot(): Promise<BrowserPageActionSnapshot & { readonly screenshotBase64: string }>;
  back(): Promise<BrowserPageActionSnapshot>;
  forward(): Promise<BrowserPageActionSnapshot>;
  reload(): Promise<BrowserPageActionSnapshot>;
  /** The only plain sample: a status poll acts on nothing. */
  location(): Promise<BrowserPageSnapshot>;
  newPage(url?: string): Promise<BrowserPageActionSnapshot>;
  activatePage(pageId: string): Promise<BrowserPageActionSnapshot>;
  closePage(pageId: string): Promise<BrowserPageActionSnapshot>;
  resize(viewport: BrowserViewport): Promise<BrowserPageActionSnapshot>;
  startScreencast(viewport: BrowserViewport, listener: (frame: BrowserScreencastFrame) => void): Promise<void>;
  stopScreencast(): Promise<void>;
  dispatchInput(input: BrowserInputEvent): Promise<void>;
  close(): Promise<void>;
}
