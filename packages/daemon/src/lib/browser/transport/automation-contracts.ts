import type {
  BrowserElementTarget,
  BrowserInputEvent,
  BrowserProxyStatus,
  BrowserPageActionSnapshot,
  BrowserPageSnapshot,
  BrowserScreencastFrame,
  BrowserScreenshotFormat,
  BrowserTarget,
  BrowserViewport,
} from '@ferretry/protocol';
import type {
  BrowserClickOptions,
  BrowserReadOptions,
  BrowserScreenshotOptions,
  BrowserTypeOptions,
} from './page-acts.ts';

/**
 * The machine's agent browser, seen from the daemon. One implementation drives a real browser worker;
 * the runtime that shares it between sessions depends only on this.
 *
 * EVERYTHING NAMES ITS PAGE. There is no active tab: an act, an input and a screencast each go to the
 * page they name, so a person on one tab and an agent on another never cross. Every action reports the
 * page it acted on as `actedPageId` (and as `activePageId`, the page the answer describes), with the
 * whole page list beside it.
 */
export interface BrowserAutomation {
  /** Resolves with an exit code when the driver dies on its own. Never rejects. */
  readonly unexpectedExit: Promise<number>;
  /** Where this browser sends its traffic, when the owner chose a proxy: the address, never a credential. */
  readonly proxy?: BrowserProxyStatus;
  navigate(pageId: string, url: string): Promise<BrowserPageActionSnapshot>;
  /** Clicks an element (a ref or a selector) or a point in the viewport. */
  click(pageId: string, target: BrowserTarget, options?: BrowserClickOptions): Promise<BrowserPageActionSnapshot>;
  type(
    pageId: string,
    target: BrowserElementTarget,
    text: string,
    options?: BrowserTypeOptions,
  ): Promise<BrowserPageActionSnapshot>;
  /**
   * The visible text (the default), the accessibility tree (`a11y`, YAML), or a `snapshot`: that tree
   * with a ref beside every element — of the page, or of one element of it.
   */
  read(pageId: string, options?: BrowserReadOptions): Promise<BrowserPageActionSnapshot & { readonly text: string }>;
  screenshot(
    pageId: string,
    options?: BrowserScreenshotOptions,
  ): Promise<
    BrowserPageActionSnapshot & {
      readonly screenshotBase64: string;
      readonly screenshotFormat?: BrowserScreenshotFormat;
    }
  >;
  back(pageId: string): Promise<BrowserPageActionSnapshot>;
  forward(pageId: string): Promise<BrowserPageActionSnapshot>;
  reload(pageId: string): Promise<BrowserPageActionSnapshot>;
  /** Every page, described from this one (or any page, when none is named). Acts on nothing. */
  location(pageId?: string): Promise<BrowserPageSnapshot>;
  /** A new page in its own window — in the shared agent profile, or in a throwaway incognito context. */
  newPage(options: { readonly url?: string; readonly incognito?: boolean }): Promise<BrowserPageActionSnapshot>;
  closePage(pageId: string): Promise<BrowserPageActionSnapshot>;
  resize(pageId: string, viewport: BrowserViewport): Promise<BrowserPageActionSnapshot>;
  /** Streams ONE page. Each page has its own stream; listeners of one never see another's frames. */
  startScreencast(
    pageId: string,
    viewport: BrowserViewport,
    listener: (frame: BrowserScreencastFrame) => void,
  ): Promise<void>;
  stopScreencast(pageId: string, listener: (frame: BrowserScreencastFrame) => void): Promise<void>;
  dispatchInput(pageId: string, input: BrowserInputEvent): Promise<void>;
  close(): Promise<void>;
}
