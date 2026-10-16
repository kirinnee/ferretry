import type { BrowserActionResult, BrowserPageSnapshot, BrowserPageSummary, BrowserStatus } from '@ferretry/protocol';
import {
  type AgentControlKind,
  type AgentControlPolicy,
  type AgentIdentity,
  type AgentIdentityResolver,
  AgentToolService,
  type AuditEntry,
  type AuditSink,
  type BrowserPageAction,
  BrowserSessionError,
  type BrowserSubsystem,
  SurfaceControl,
  type SurfaceEventSink,
} from '../../../src/lib/index.ts';
import { FakeTerminals } from '../runtime/mounts/support.ts';

/** Every audit record written, in order. */
class RecordingAudit implements AuditSink {
  readonly entries: AuditEntry[] = [];
  async record(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
  }
}

/** Every journal event published, in order. */
export class RecordingEvents implements SurfaceEventSink {
  readonly published: { readonly sessionId: string; readonly type: string; readonly data: unknown }[] = [];
  failing = false;
  async publish(sessionId: string, type: string, data: unknown): Promise<void> {
    if (this.failing) throw new Error('the journal is full');
    this.published.push({ sessionId, type, data });
  }
}

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

/**
 * A per-session browser holding named pages, with the same refusals the real service raises. It
 * records every act, and can be told to fail the next call with any error.
 */
class FakeBrowserPages implements Pick<BrowserSubsystem, 'status' | 'openPage' | 'actOnPage' | 'closePage'> {
  readonly pages = new Map<string, (BrowserPageSummary & { readonly sessionId: string })[]>();
  readonly acts: string[] = [];
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

  async openPage(sessionId: string, name: string, url?: string): Promise<BrowserPageSummary> {
    this.fail();
    this.session(sessionId);
    const pages = this.pages.get(sessionId) ?? [];
    if (pages.some(page => page.name === name))
      throw new BrowserSessionError('conflict', `this session already has a browser page named ${name}`);
    this.minted += 1;
    const page = { id: `page-${String(this.minted)}`, url: url ?? 'about:blank', title: '', name, sessionId };
    this.pages.set(sessionId, [...pages, page]);
    const { sessionId: _owner, ...summary } = page;
    return summary;
  }

  async actOnPage(sessionId: string, key: string, action: BrowserPageAction): Promise<BrowserActionResult> {
    this.fail();
    const page = this.page(sessionId, key);
    this.acts.push(`${sessionId}:${page.id}:${action.action}`);
    const status = (await this.status(sessionId)) as Extract<BrowserStatus, { readonly state: 'running' }>;
    const snapshot = { ...this.snapshot(sessionId), actedPageId: page.id };
    if (action.action === 'read')
      return { status, result: { ...snapshot, text: action.mode === 'a11y' ? '- button "Sign in"' : 'Welcome back' } };
    if (action.action === 'screenshot') return { status, result: { ...snapshot, screenshotBase64: 'iVBORw0KGgo=' } };
    return { status, result: snapshot };
  }

  async closePage(sessionId: string, key: string): Promise<void> {
    this.fail();
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
    const active = pages[pages.length - 1] as BrowserPageSummary;
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
export function agentToolWorld() {
  const terminals = new FakeTerminals(['s1', 's2']);
  const browser = new FakeBrowserPages();
  const audit = new RecordingAudit();
  const events = new RecordingEvents();
  const clock = new ManualClock();
  const policy = new Switches();
  const slept: number[] = [];
  const control = new SurfaceControl(events, clock);
  const service = new AgentToolService({
    terminals,
    browser,
    control,
    policy,
    audit,
    clock,
    sleep: async milliseconds => {
      slept.push(milliseconds);
      clock.ms += milliseconds;
    },
  });
  return { terminals, browser, audit, events, clock, policy, slept, control, service, identities };
}

export const agent = { kind: 'agent', sessionId: 's1', name: 'Hadi' } as const;
export const otherAgent = { kind: 'agent', sessionId: 's2' } as const;
export const person = {
  kind: 'person',
  sessionId: 's1',
  actor: { kind: 'device', deviceId: 'phone-1' },
  openedBy: { by: 'human', deviceId: 'phone-1' },
} as const;
