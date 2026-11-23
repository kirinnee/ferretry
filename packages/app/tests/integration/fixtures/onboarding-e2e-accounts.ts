/**
 * The fake machine's accounts for the first-run gate (O9-6): it starts with NO login and NO runtime, and a sign-in makes both,
 * the way the real machine does. A login is added by the sign-in page's own press (stage, then apply, at Logins' change
 * routes), a sign-in flow is started and finished (Claude: the pasted code is submitted; Codex: the device grant is polled
 * until it completes), and the moment a login is signed in the machine DERIVES its runtime (`GET /v1/runtimes`), launchable.
 * Everything is made up: no real address, code, name or key.
 */
import type { TransportAnswer, TransportRequest } from '../../../src/client/transport.ts';
import { json } from '../../unit/client/fixtures.ts';

type Harness = 'claude-code' | 'codex';

interface FakeLogin {
  readonly id: string;
  readonly harness: Harness;
  readonly label: string;
  ready: boolean;
}

const NOW = '2026-11-23T09:00:00.000Z';
const LATER = '2026-11-23T09:10:00.000Z';
const TOOL: Record<Harness, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };

export class FakeAccounts {
  private readonly logins: FakeLogin[] = [];
  private readonly staged = new Map<string, { id: string; harness: Harness; label?: string }>();
  /** How many times each flow was read: a Codex device grant completes on its second read (the person approved it elsewhere). */
  private readonly reads = new Map<string, number>();
  /** Every runtime the machine derived, in the order it made them (a test reads this to say what was made, and when). */
  readonly made: string[] = [];
  /** Told when a login is added or signed in (the real daemon publishes `logins.changed`); the scene turns it into that event. */
  onChange: (loginId: string, change: 'added' | 'status') => void = () => undefined;

  /** What `GET /v1/runtimes` answers now: one launchable runtime per signed-in login. */
  runtimes(): readonly { readonly name: string; readonly harness: Harness; readonly credential: string }[] {
    return this.logins.filter(login => login.ready).map(login => ({ ...this.runtimeOf(login) }));
  }

  private runtimeOf(login: FakeLogin) {
    return { name: `${TOOL[login.harness]} (${login.label})`, harness: login.harness, credential: login.id };
  }

  private loginView(login: FakeLogin): unknown {
    return {
      id: login.id,
      harness: login.harness,
      harnesses: [login.harness],
      store: 'ferretry',
      label: login.label,
      needsLabel: false,
      sharedWithTerminal: false,
      status: login.ready
        ? {
            word: 'ready',
            label: 'Ready',
            reason: 'access_current',
            explanation: 'The access token is current.',
            lastCheckInconclusive: false,
          }
        : {
            word: 'needs_sign_in',
            label: 'Needs sign-in',
            reason: 'not_signed_in',
            explanation: 'Nobody has signed in on this machine yet.',
            lastCheckInconclusive: false,
          },
      usage: { fiveHour: {}, weekly: {} },
      usedBy: login.ready ? [this.runtimeOf(login).name] : [],
      signIn: login.ready ? { available: false, reason: 'already signed in' } : { available: true },
      checkNow: { available: true },
      signOut: {
        available: login.ready,
        sentence: 'Sign out of this login?',
        runtimesAffected: 1,
        signsOutTerminal: false,
      },
    };
  }

  private flowOf(login: FakeLogin, state: 'awaiting' | 'complete'): unknown {
    const base = {
      flowId: `flow-${login.id}`,
      loginId: login.id,
      identity: `${login.harness}:${login.id}`,
      startedAt: NOW,
      expiresAt: LATER,
    };
    if (login.harness === 'claude-code')
      return state === 'complete'
        ? { harness: 'claude-code', ...base, state: 'complete' }
        : {
            harness: 'claude-code',
            ...base,
            state: 'awaiting-code',
            verificationUrl: 'https://claude.example.test/oauth/authorize?code=true',
          };
    return state === 'complete'
      ? { harness: 'codex', ...base, state: 'complete' }
      : {
          harness: 'codex',
          ...base,
          state: 'awaiting-approval',
          verificationUrl: 'https://auth.example.test/codex/device',
          userCode: 'ABCD-EFGH',
        };
  }

  private signIn(login: FakeLogin): void {
    if (login.ready) return;
    login.ready = true;
    this.made.push(this.runtimeOf(login).name);
    this.onChange(login.id, 'status');
  }

  answer(request: TransportRequest): TransportAnswer | undefined {
    const { method, path } = request;
    if (method === 'GET' && path === '/v1/logins')
      return json({ format: 1, machine: 'studio-mac', logins: this.logins.map(login => this.loginView(login)) });
    if (method === 'GET' && path === '/v1/runtimes')
      return json({
        format: 'present',
        runtimes: this.logins
          .filter(login => login.ready)
          .map(login => ({
            id: `${login.id}-runtime`,
            name: this.runtimeOf(login).name,
            wrapper: login.id,
            harness: login.harness,
            credential: { id: login.id, store: 'ferretry' },
            profile: 'default',
            stack: { layers: [], resolved: [] },
            modelSet: { models: [] },
            launch: { available: true },
            sameAs: [],
          })),
      });
    if (method === 'POST' && path === '/v1/logins/changes') {
      const change = request.body as { kind?: string; id: string; harness: Harness; label?: string };
      if (change.kind !== 'login.add') return undefined;
      const changeId = `change-${change.id}`;
      this.staged.set(changeId, change);
      return json({
        id: changeId,
        change,
        summary: `Add the ${TOOL[change.harness]} login ${change.id}`,
        consequences: [],
        expiresAt: LATER,
        state: 'pending',
      });
    }
    const apply = /^\/v1\/logins\/changes\/([^/]+)\/apply$/u.exec(path);
    if (method === 'POST' && apply !== null) {
      const change = this.staged.get(apply[1] ?? '');
      if (change === undefined) return undefined;
      this.logins.push({
        id: change.id,
        harness: change.harness,
        label: change.label ?? change.id,
        ready: false,
      });
      this.onChange(change.id, 'added');
      return json({ outcome: 'applied' });
    }
    if (method === 'POST' && path === '/v1/logins/sign-in') {
      const login = this.logins.find(candidate => candidate.id === (request.body as { loginId?: string }).loginId);
      return login === undefined ? undefined : json(this.flowOf(login, 'awaiting'));
    }
    const flow = /^\/v1\/logins\/sign-in\/flow-([^/]+)$/u.exec(path);
    if (flow !== null) {
      const login = this.logins.find(candidate => candidate.id === flow[1]);
      if (login === undefined) return undefined;
      if (method === 'GET') {
        const count = (this.reads.get(login.id) ?? 0) + 1;
        this.reads.set(login.id, count);
        // Codex: the person approves the device grant elsewhere, and the second poll finds it done.
        if (login.harness === 'codex' && count >= 2) this.signIn(login);
        return json(this.flowOf(login, login.ready ? 'complete' : 'awaiting'));
      }
      if (method === 'POST') {
        this.signIn(login);
        return json({ outcome: 'accepted', flow: this.flowOf(login, 'complete') });
      }
    }
    return undefined;
  }
}
