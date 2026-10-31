import type {
  BrowserDialogInfo,
  BrowserElementTarget,
  BrowserInputEvent,
  BrowserProxyStatus,
  BrowserPageActionSnapshot,
  BrowserPageLifecycleReply,
  BrowserPageLifecycleRequest,
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
  BrowserUploadMode,
} from './page-acts.ts';
import type { WorkerStagedFile } from './worker-protocol.ts';

/** What an act answers: the page list, and the dialog the acted page is waiting on, if it has one. */
export type BrowserPageActed = BrowserPageActionSnapshot & { readonly dialog?: BrowserDialogInfo };

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
  navigate(pageId: string, url: string): Promise<BrowserPageActed>;
  /** Clicks an element (a ref or a selector) or a point in the viewport. */
  click(pageId: string, target: BrowserTarget, options?: BrowserClickOptions): Promise<BrowserPageActed>;
  type(
    pageId: string,
    target: BrowserElementTarget,
    text: string,
    options?: BrowserTypeOptions,
  ): Promise<BrowserPageActed>;
  /**
   * The visible text (the default), the accessibility tree (`a11y`, YAML), or a `snapshot`: that tree
   * with a ref beside every element — of the page, or of one element of it.
   */
  read(pageId: string, options?: BrowserReadOptions): Promise<BrowserPageActed & { readonly text: string }>;
  screenshot(
    pageId: string,
    options?: BrowserScreenshotOptions,
  ): Promise<
    BrowserPageActed & {
      readonly screenshotBase64: string;
      readonly screenshotFormat?: BrowserScreenshotFormat;
    }
  >;
  /** Hands already-confined, absolute file paths to the page: into a file field (a dialog counts) or dropped on an element. */
  upload(
    pageId: string,
    target: BrowserElementTarget,
    paths: readonly string[],
    mode: BrowserUploadMode,
  ): Promise<BrowserPageActed>;
  /** The chosen (default: latest) download this page started, as a file the browser staged for the daemon to save. */
  download(pageId: string, downloadId?: string): Promise<BrowserPageActed & { readonly staged: WorkerStagedFile }>;
  /** The page printed to PDF and staged for the daemon to save; a visible-window browser refuses. */
  pdf(pageId: string): Promise<BrowserPageActed & { readonly staged: WorkerStagedFile }>;
  back(pageId: string): Promise<BrowserPageActed>;
  forward(pageId: string): Promise<BrowserPageActed>;
  reload(pageId: string): Promise<BrowserPageActed>;
  /** Every page, described from this one (or any page, when none is named). Acts on nothing. */
  location(pageId?: string): Promise<BrowserPageSnapshot>;
  /** A new page in its own window — in the shared agent profile, or in a throwaway incognito context. */
  newPage(options: { readonly url?: string; readonly incognito?: boolean }): Promise<BrowserPageActed>;
  closePage(pageId: string): Promise<BrowserPageActed>;
  resize(pageId: string, viewport: BrowserViewport): Promise<BrowserPageActed>;
  /**
   * Answers a dialog, waits a moment for a condition, reads the console or network log, or emulates a
   * device — one request, one page. A dialog answer, a log read and an emulation never wait behind a
   * slow act on the page: a dialog is what such an act may be stuck on.
   */
  lifecycle(
    pageId: string,
    request: BrowserPageLifecycleRequest,
  ): Promise<BrowserPageActed & { readonly lifecycle: BrowserPageLifecycleReply }>;
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
