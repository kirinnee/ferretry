import { describe, expect, it } from 'bun:test';
import type { BrowserStatus } from '@ferretry/protocol';
import {
  browserChip,
  compactAddress,
  type BrowserBarControl,
  type BrowserChipInput,
} from '../../../src/features/browser/browser-bar-model.ts';

const base = {
  sessionId: 's1',
  viewport: { width: 1280, height: 800 },
  viewers: 1,
  persistentProfile: true,
  idleTimeoutSeconds: 900,
  capacity: { running: 1, maximum: 3 },
} as const;

const running = (pageState: 'ready' | 'loading' | 'error' = 'ready'): BrowserStatus =>
  ({
    ...base,
    state: 'running',
    url: 'https://shop.example/',
    title: 'Shop',
    activePageId: 'pg-1',
    pages: [{ id: 'pg-1', url: 'https://shop.example/', title: 'Shop' }],
    pageState,
    ...(pageState === 'error' ? { pageError: 'net::ERR_CONNECTION_REFUSED' } : {}),
    canGoBack: false,
    canGoForward: false,
  }) as BrowserStatus;

const nobody: BrowserBarControl = { driver: null, ask: null, takenOver: false };

const input = (patch: Partial<BrowserChipInput> = {}): BrowserChipInput => ({
  engine: 'remote',
  status: running(),
  connection: 'connected',
  busy: false,
  errors: [],
  challenge: null,
  control: nobody,
  ...patch,
});

describe('browserChip — the one chip the bar shows', () => {
  it('is live for a running browser with a connected display and nobody doing anything', () => {
    expect(browserChip(input())).toMatchObject({ kind: 'live', tone: 'ok', attention: false });
  });

  it('is the preview reader, whatever the real browser is doing', () => {
    expect(browserChip(input({ engine: 'preview', control: { ...nobody, takenOver: true } })).kind).toBe('preview');
  });

  it('says a ferret is typing, naming it only in the detail', () => {
    const chip = browserChip(input({ control: { ...nobody, driver: { name: 'Hadi' } } }));

    expect(chip).toMatchObject({ kind: 'agent', label: 'Ferret', attention: false });
    expect(chip.summary).toBe('Hadi is typing here.');
  });

  it('says the owner has taken the page over, as a notice', () => {
    expect(browserChip(input({ control: { ...nobody, takenOver: true } }))).toMatchObject({
      kind: 'owner',
      label: 'You',
      attention: true,
    });
  });

  it('carries a hand-over ask with its own words', () => {
    const chip = browserChip(
      input({ control: { ...nobody, ask: { agent: 'Hadi', message: 'Sign in, then hand it back.' } } }),
    );

    expect(chip).toMatchObject({ kind: 'ask', attention: true, summary: 'Sign in, then hand it back.' });
    expect(browserChip(input({ control: { ...nobody, ask: { agent: 'Hadi' } } })).summary).toBe('Hadi needs you here.');
  });

  it('flags a human check as a notice', () => {
    expect(browserChip(input({ challenge: { provider: 'cloudflare' } }))).toMatchObject({
      kind: 'challenge',
      tone: 'warn',
      attention: true,
    });
  });

  it('reports a failed page and a held error message, with the message first', () => {
    expect(browserChip(input({ status: running('error') }))).toMatchObject({
      kind: 'error',
      summary: 'net::ERR_CONNECTION_REFUSED',
    });
    expect(browserChip(input({ errors: ['“x” is not an http or https address.'] })).summary).toBe(
      '“x” is not an http or https address.',
    );
  });

  it('reports a lost display and a stopped browser', () => {
    expect(browserChip(input({ connection: 'disconnected' })).kind).toBe('disconnected');
    expect(browserChip(input({ status: { ...base, state: 'stopped', pages: [] } as BrowserStatus })).kind).toBe(
      'stopped',
    );
    expect(
      browserChip(input({ status: { ...base, state: 'starting', pages: [] } as BrowserStatus, connection: 'detached' }))
        .label,
    ).toBe('Starting');
  });

  it('shows work in progress, and connecting before the first answer', () => {
    expect(browserChip(input({ busy: true })).kind).toBe('working');
    expect(browserChip(input({ status: running('loading') })).kind).toBe('working');
    expect(browserChip(input({ status: null, connection: 'detached' })).kind).toBe('connecting');
    expect(browserChip(input({ connection: 'connecting' })).kind).toBe('connecting');
  });

  it('ranks what a person must not miss above everything quieter', () => {
    const everything = input({
      status: running('error'),
      connection: 'disconnected',
      busy: true,
      errors: ['x'],
      challenge: { provider: 'other' },
      control: { driver: { name: 'Hadi' }, ask: { agent: 'Hadi' }, takenOver: true },
    });

    expect(browserChip(everything).kind).toBe('owner');
    expect(browserChip({ ...everything, control: { ...everything.control, takenOver: false } }).kind).toBe('ask');
    expect(browserChip({ ...everything, control: { ...nobody, driver: { name: 'Hadi' } } }).kind).toBe('challenge');
    expect(browserChip({ ...everything, control: nobody, challenge: null }).kind).toBe('error');
    expect(browserChip({ ...everything, control: nobody, challenge: null, errors: [], status: running() }).kind).toBe(
      'disconnected',
    );
  });
});

describe('compactAddress — the address at rest', () => {
  it('drops the scheme and a bare trailing slash, and leaves anything else alone', () => {
    expect(compactAddress('https://example.invalid/claims/new')).toBe('example.invalid/claims/new');
    expect(compactAddress('HTTP://shop.example/')).toBe('shop.example');
    expect(compactAddress('https://a.example/?q=1')).toBe('a.example/?q=1');
    expect(compactAddress('ferret docs')).toBe('ferret docs');
    expect(compactAddress('')).toBe('');
  });
});
