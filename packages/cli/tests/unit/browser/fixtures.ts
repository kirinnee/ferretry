import {
  type BrowserActionResult,
  BrowserActionResultSchema,
  type BrowserStatus,
  BrowserStatusSchema,
} from '@ferretry/protocol';

/** Fixtures are parsed by the protocol schemas, so a test can never assert against an impossible shape. */
const BASE = {
  sessionId: 'sess-1',
  viewport: { width: 1_280, height: 800 },
  viewers: 1,
  persistentProfile: true,
  idleTimeoutSeconds: 300,
  capacity: { running: 1, maximum: 3 },
};

const RUNNING = {
  ...BASE,
  state: 'running',
  url: 'https://example.com/a',
  title: 'Example A',
  pages: [
    { id: 'page-1', url: 'https://example.com/a', title: 'Example A' },
    { id: 'page-2', url: 'https://example.com/b', title: '' },
  ],
  activePageId: 'page-1',
  pageState: 'ready',
  canGoBack: true,
  canGoForward: false,
};

export const status = (overrides: Record<string, unknown> = {}): BrowserStatus =>
  BrowserStatusSchema.parse({ ...RUNNING, ...overrides });

export const stoppedStatus = (): BrowserStatus => BrowserStatusSchema.parse({ ...BASE, state: 'stopped', pages: [] });

export const actionResult = (overrides: Record<string, unknown> = {}): BrowserActionResult =>
  BrowserActionResultSchema.parse({
    status: { ...RUNNING },
    result: {
      url: 'https://example.com/a',
      title: 'Example A',
      pages: [{ id: 'page-1', url: 'https://example.com/a', title: 'Example A' }],
      activePageId: 'page-1',
      pageState: 'ready',
      canGoBack: false,
      canGoForward: false,
      ...overrides,
    },
  });

export const statusOnlyResult = (): BrowserActionResult =>
  BrowserActionResultSchema.parse({ status: { ...BASE, state: 'stopped', pages: [] } });
