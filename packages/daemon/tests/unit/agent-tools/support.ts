import type { BrowserActionResult, BrowserPageSnapshot, BrowserPageSummary, BrowserStatus } from '@ferretry/protocol';
import type { AgentControlKind, AgentControlPolicy } from '../../../src/lib/fleet/agent-control.ts';
import {
  type AgentIdentity,
  type AgentIdentityResolver,
  type AgentToolPorts,
  AgentToolService,
  type AuditEntry,
  type AuditSink,
  type BrowserActGuard,
  type BrowserOpenOptions,
  type BrowserPageAction,
  BrowserSessionError,
  type BrowserSubsystem,
  type RecordedSurfaceEvent,
  type Scrub,
  SurfaceControl,
  type SurfaceEventSink,
  type TextRedactor,
} from '../../../src/lib/index.ts';
import { FakeTerminals } from '../runtime/mounts/support.ts';

/** Every audit record written, in order. */
class RecordingAudit implements AuditSink {
  readonly entries: AuditEntry[] = [];
  /** Runs while a record is being written: a case suspends the audit here. */
  during: (() => void | Promise<void>) | undefined;
  async record(entry: AuditEntry): Promise<void> {
    await this.during?.();
    this.entries.push(entry);
  }
}

/** Every journal event published, in order — and what a restarted daemon would read back. */
export class RecordingEvents implements SurfaceEventSink {
  readonly published: { readonly sessionId: string; readonly type: string; readonly data: unknown }[] = [];
  /** Events a previous daemon run left in each session's journal. */
  readonly earlier = new Map<string, RecordedSurfaceEvent[]>();
  failing = false;
  unreadable = 0;
  reads = 0;
  async publish(sessionId: string, type: string, data: unknown): Promise<void> {
    if (this.failing) throw new Error('the journal is full');
    this.published.push({ sessionId, type, data });
  }
  async history(sessionId: string): Promise<readonly RecordedSurfaceEvent[]> {
    this.reads += 1;
    if (this.unreadable > 0) {
      this.unreadable -= 1;
      throw new Error('the journal could not be read');
    }
    return this.earlier.get(sessionId) ?? [];
  }
}

/**
 * The vault, as redaction sees it: the values a case put in it, each masked as `[redacted:NAME]`. A
 * locked vault refuses every scrub, as a real one that cannot be opened does.
 */
class FakeRedactor implements Pick<TextRedactor, 'batch'> {
  readonly values = new Map<string, string>();
  locked = false;
  batches = 0;
  async batch<T>(work: (scrub: Scrub) => T): Promise<T> {
    if (this.locked) throw new Error('the vault is locked');
    this.batches += 1;
    const mask = (text: string): string =>
      [...this.values].reduce((masked, [value, name]) => masked.split(value).join(`[redacted:${name}]`), text);
    return work({ text: mask, data: value => value, cover: () => [] });
  }
}

/** A snapshot as Playwright's `ai` mode writes one: a ref beside every element. */
export const SNAPSHOT = [
  '- banner [ref=e1]:',
  '  - link "Home" [ref=e2]',
  '- main [ref=e3]:',
  '  - button "Sign in" [ref=e4]',
  '  - textbox "Email" [ref=e5]',
].join('\n');

/** The machine's switches, settable per case. */
class Switches implements AgentControlPolicy {
  readonly off = new Set<AgentControlKind>();
  async allows(kind: AgentControlKind): Promise<boolean> {
    return !this.off.has(kind);
  }
}

/** A clock a case moves by hand. */
export class ManualClock {
  constructor(public ms: number = Date.parse('2026-10-16T10:00:00.000Z')) {}
  now(): number {
    return this.ms;
  }
}

/** Two sessions' credentials, so a case can present one and try to reach the other. */
const CAPABILITIES: Readonly<Record<string, AgentIdentity>> = {
  'cap-s1': { sessionId: 's1', name: 'Hadi' },
  'cap-s2': { sessionId: 's2' },
};

const identities: AgentIdentityResolver = { resolve: async capability => CAPABILITIES[capability] };

type FakePage = BrowserPageSummary & { readonly sessionId: string };

/**
 * A per-session browser holding named pages and ONE active tab, with the same refusals the real
 * service raises. It records every act (by the page that was active when it ran), runs a guard where
 * the real one does, and can be told to fail the next call with any error.
 */
class FakeBrowserPages implements Pick<BrowserSubsystem, 'status' | 'openPage' | 'actOnPage' | 'closePage'> {
  readonly pages = new Map<string, FakePage[]>();
  readonly active = new Map<string, string>();
  readonly acts: string[] = [];
  /** Every action, exactly as the agent-tools service built it. */
  readonly actions: BrowserPageAction[] = [];
  /** What the next read answers, when a case wants something other than the defaults. */
  readText: string | undefined;
  /** Where every act reports the page to be, when a case wants an address other than the page's own. */
  actedUrl: string | undefined;
  failure: unknown;
  private minted = 0;

  constructor(private readonly known: readonly string[] = ['s1', 's2']) {}

  async status(sessionId: string): Promise<BrowserStatus> {
    this.fail();
    this.session(sessionId);
    const pages = this.pages.get(sessionId) ?? [];
    const base = {
      sessionId,
      viewport: { width: 1280, height: 800 },
      viewers: 0,
      persistentProfile: true as const,
      idleTimeoutSeconds: 0,
      capacity: { running: this.pages.size, maximum: 3 },
    };
    if (pages.length === 0) return { ...base, state: 'stopped', pages: [] };
    return { ...base, ...this.snapshot(sessionId), state: 'running' };
  }

  async openPage(sessionId: string, name: string, options: BrowserOpenOptions = {}): Promise<BrowserPageSummary> {
    const { url, openedBy } = options;
    this.fail();
    this.session(sessionId);
    const pages = this.pages.get(sessionId) ?? [];
    if (pages.some(page => page.name === name))
      throw new BrowserSessionError('conflict', `this session already has a browser page named ${name}`);
    this.minted += 1;
    const page: FakePage = {
      id: `page-${String(this.minted)}`,
      url: url ?? 'about:blank',
      title: url === undefined ? '' : `Page at ${new URL(url).host}`,
      name,
      ...(openedBy === undefined ? {} : { openedBy }),
      ...(options.incognito === true ? { incognito: true as const } : {}),
      sessionId,
    };
    this.pages.set(sessionId, [...pages, page]);
    this.active.set(sessionId, page.id);
    const { sessionId: _owner, ...summary } = page;
    return summary;
  }

  async actOnPage(
    sessionId: string,
    key: string,
    action: BrowserPageAction,
    guard?: BrowserActGuard,
  ): Promise<BrowserActionResult> {
    this.fail();
    await guard?.();
    const page = this.page(sessionId, key);
    this.active.set(sessionId, page.id);
    this.acts.push(`${sessionId}:${page.id}:${action.action}`);
    this.actions.push(action);
    const status = (await this.status(sessionId)) as Extract<BrowserStatus, { readonly state: 'running' }>;
    const snapshot = {
      ...this.snapshot(sessionId),
      ...(this.actedUrl === undefined ? {} : { url: this.actedUrl }),
      actedPageId: page.id,
    };
    if (action.action === 'read') {
      const text =
        this.readText ??
        (action.mode === 'snapshot'
          ? action.find === undefined
            ? SNAPSHOT
            : SNAPSHOT.split('\n')
                .filter(line => line.toLowerCase().includes(action.find?.toLowerCase() ?? ''))
                .map(line => line.trim())
                .join('\n')
          : action.mode === 'a11y'
            ? '- button "Sign in"'
            : 'Welcome back');
      return { status, result: { ...snapshot, text } };
    }
    if (action.action === 'screenshot')
      return {
        status,
        result: {
          ...snapshot,
          screenshotBase64: action.format === 'jpeg' ? '/9j/4AAQ' : 'iVBORw0KGgo=',
          ...(action.format === 'jpeg' ? { screenshotFormat: 'jpeg' as const } : {}),
        },
      };
    return { status, result: snapshot };
  }

  async closePage(sessionId: string, key: string, guard?: BrowserActGuard): Promise<void> {
    this.fail();
    await guard?.();
    const page = this.page(sessionId, key);
    this.pages.set(
      sessionId,
      (this.pages.get(sessionId) ?? []).filter(candidate => candidate.id !== page.id),
    );
  }

  private snapshot(sessionId: string): BrowserPageSnapshot {
    const pages = (this.pages.get(sessionId) ?? []).map(({ sessionId: _owner, ...page }) => ({
      ...page,
      url: page.url === 'about:blank' ? 'https://blank.test/' : page.url,
    }));
    const active = pages.find(page => page.id === this.active.get(sessionId)) ?? (pages[0] as BrowserPageSummary);
    return {
      url: active.url,
      title: active.title,
      pages,
      activePageId: active.id,
      pageState: 'ready',
      canGoBack: false,
      canGoForward: false,
    };
  }

  private page(sessionId: string, key: string): BrowserPageSummary {
    const page = (this.pages.get(sessionId) ?? []).find(candidate => candidate.id === key || candidate.name === key);
    if (page === undefined) throw new BrowserSessionError('not_found', `there is no browser page named ${key}`);
    return page;
  }

  private session(sessionId: string): void {
    if (!this.known.includes(sessionId)) throw new BrowserSessionError('not_found', 'the session does not exist');
  }

  private fail(): void {
    const failure = this.failure;
    this.failure = undefined;
    if (failure !== undefined) throw failure;
  }
}

/** A whole agent-tools domain over fakes, with every collaborator exposed for assertions. */
export function agentToolWorld(extra: Pick<AgentToolPorts, 'input' | 'scrub' | 'quarantinedUntil'> = {}) {
  const terminals = new FakeTerminals(['s1', 's2']);
  const browser = new FakeBrowserPages();
  const audit = new RecordingAudit();
  const events = new RecordingEvents();
  const clock = new ManualClock();
  const policy = new Switches();
  const slept: number[] = [];
  const control = new SurfaceControl(events, clock);
  const onSleep: (() => void | Promise<void>)[] = [];
  const redactor = new FakeRedactor();
  const service = new AgentToolService({
    terminals,
    browser,
    control,
    policy,
    audit,
    redactor,
    clock,
    ...extra,
    sleep: async milliseconds => {
      slept.push(milliseconds);
      clock.ms += milliseconds;
      await onSleep.shift()?.();
    },
  });
  return { terminals, browser, audit, events, clock, policy, slept, onSleep, control, redactor, service, identities };
}

export const agent = { kind: 'agent', sessionId: 's1', name: 'Hadi' } as const;
export const otherAgent = { kind: 'agent', sessionId: 's2' } as const;
export const person = {
  kind: 'person',
  sessionId: 's1',
  actor: { kind: 'device', deviceId: 'phone-1' },
  openedBy: { by: 'human', deviceId: 'phone-1' },
} as const;
