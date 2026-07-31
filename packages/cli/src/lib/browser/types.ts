import type { IFyApiClient } from '@ferretry/protocol';

/** Every browser verb the CLI can issue. `login` is deliberately session-free — see `request.ts`. */
export type BrowserCommand =
  | { readonly command: 'status'; readonly session?: string }
  | { readonly command: 'start'; readonly session?: string }
  | { readonly command: 'open'; readonly url?: string; readonly session?: string }
  | { readonly command: 'new-page'; readonly url?: string; readonly session?: string }
  | { readonly command: 'activate-page'; readonly pageId: string; readonly session?: string }
  | { readonly command: 'close-page'; readonly pageId: string; readonly session?: string }
  | { readonly command: 'stop'; readonly session?: string }
  | { readonly command: 'navigate'; readonly url: string; readonly session?: string }
  | { readonly command: 'click'; readonly selector: string; readonly session?: string }
  | { readonly command: 'type'; readonly selector: string; readonly text: string; readonly session?: string }
  | { readonly command: 'read'; readonly selector?: string; readonly session?: string }
  | { readonly command: 'screenshot'; readonly output: string; readonly session?: string }
  | { readonly command: 'back'; readonly session?: string }
  | { readonly command: 'forward'; readonly session?: string }
  | { readonly command: 'reload'; readonly session?: string }
  | { readonly command: 'resize'; readonly width: number; readonly height: number; readonly session?: string }
  | { readonly command: 'login'; readonly action: 'status' }
  | { readonly command: 'login'; readonly action: 'start'; readonly minutes?: number }
  | { readonly command: 'login'; readonly action: 'stop'; readonly primed?: boolean }
  | { readonly command: 'login'; readonly action: 'confirm' };

export interface BrowserRequest {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly body?: unknown;
}

/**
 * The one daemon call the browser controller makes. `IFyApiClient` satisfies it structurally, so
 * the CLI stays a thin HTTP caller that never imports daemon internals or Playwright.
 */
export type IBrowserGateway = Pick<IFyApiClient, 'request'>;

/** Presentation port: satisfied structurally by the shipped `ConsoleIo` terminal adapter. */
export interface IBrowserIo {
  success(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  setExitCode(code: number): void;
}

/** Writes an explicit screenshot to a path the operator chose. Nothing else persists image bytes. */
export interface IScreenshotWriter {
  write(path: string, base64: string): Promise<void>;
}

/** Raised when the operator's own input cannot describe a request at all. */
export class BrowserCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserCommandError';
  }
}
