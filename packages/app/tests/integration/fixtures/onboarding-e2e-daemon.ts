/**
 * The fake machines for `onboarding-e2e-scene.tsx` (r10-1 gate): two STATEFUL fake daemons that answer the first-run routes
 * from memory and remember what the page told them, so a test can read the daemon's side of every answer. Every name, path
 * and number is made up; the pairing code is a fixed fake one. No network, no real home.
 *
 * Layered on `mobile-fake-daemon.ts` (the machine's ordinary reads: grants, health, logins, runtimes, warden, lessons …),
 * the routes below override the first-run ones.
 */
import type { TransportAnswer, TransportRequest } from '../../../src/client/transport.ts';
import { json } from '../../unit/client/fixtures.ts';
// The REAL catalog (`ProviderPresetService.catalog()` over the shipped built-in presets): the ONE copy, held to the service by
// Logins' own test, reached through Logins' contract/testing.
import { REAL_PROVIDER_PRESET_CATALOG as PROVIDER_PRESETS } from '@ferretry/plugin-logins/contract/testing';
import { answerFor } from './mobile-fake-daemon.ts';

/** The fixed fake pairing code. It is not a real one and opens nothing. */
export const FAKE_CODE = 'ABCD-EFGH';

export type StepState = 'pending' | 'found' | 'later' | 'done' | 'skipped';
export interface FakeStep {
  readonly plugin: string;
  readonly id: string;
  readonly title: string;
  readonly order: number;
  readonly side?: 'client';
  readonly group?: string;
}

/** One answer the daemon recorded, in arrival order. */
export interface RecordedAnswer {
  readonly plugin: string;
  readonly id: string;
  readonly state: StepState;
}

const CLAUDE = [
  ['installed', 'Install Claude Code', 20],
  ['sign-in', 'Sign in to Claude', 21],
  ['import-choice', 'What to bring over', 22],
  ['import-settings', 'Settings', 23],
  ['import-model-set', 'Models', 24],
  ['import-instructions', 'CLAUDE.md', 25],
  ['import-skills', 'Skills', 26],
  ['import-mcp', 'MCP servers', 27],
  ['conversations', 'Conversations', 28],
  ['import-run', 'Bring it over', 29],
  ['permission', 'Permissions', 30],
] as const;
const CODEX = [
  ['installed', 'Install Codex', 40],
  ['sign-in', 'Sign in to Codex', 41],
  ['import-choice', 'What to bring over', 42],
  ['import-settings', 'Settings', 43],
  ['import-model-set', 'Models', 44],
  ['import-instructions', 'AGENTS.md', 45],
  ['import-skills', 'Skills', 46],
  ['import-mcp', 'MCP servers', 47],
  ['conversations', 'Conversations', 48],
  ['import-run', 'Bring it over', 49],
  ['permission', 'Permissions', 50],
] as const;

const stepsOf = (plugin: string, rows: readonly (readonly [string, string, number])[], group: string): FakeStep[] =>
  rows.map(([id, title, order]) => ({ plugin, id, title, order, group }));

/** What every machine carries. */
const COMMON: readonly FakeStep[] = [
  { plugin: 'onboarding', id: 'agents', title: 'Which AI do you want to use?', order: 2, group: 'This machine' },
  { plugin: 'onboarding', id: 'name', title: 'Name this machine', order: 5, group: 'This machine' },
  { plugin: 'onboarding', id: 'appearance', title: 'Appearance', order: 1, side: 'client', group: 'This device' },
  { plugin: 'layouts', id: 'layout', title: 'Layout', order: 2, side: 'client' },
  ...stepsOf('claude-code', CLAUDE, 'Claude Code'),
  { plugin: 'warden', id: 'warden', title: 'Let the Warden watch your ferrets?', order: 60, group: 'Warden' },
  { plugin: 'lessons', id: 'lessons', title: 'Lessons', order: 70 },
  { plugin: 'shells', id: 'nix', title: 'Shells', order: 80, group: 'Shells' },
];

export interface FakeMachine {
  readonly id: string;
  readonly name: string;
  readonly address: string;
  /** The steps this machine's plugins declare. */
  readonly steps: readonly FakeStep[];
}

const idOf = (letter: string): string => `fy_daemon_${letter.repeat(43)}`;

/** The first machine: every plugin, Voice on it, Codex on it, no Passkey step. */
export const MACHINE_A: FakeMachine = {
  id: idOf('a'),
  name: 'studio-mac',
  address: 'http://127.0.0.1:40245',
  steps: [
    ...COMMON,
    ...stepsOf('codex', CODEX, 'Codex'),
    { plugin: 'voice', id: 'voice', title: 'Voice', order: 3, side: 'client' },
  ],
};
/** The second machine: no Codex, no Voice, but a Passkey step only it carries. */
export const MACHINE_B: FakeMachine = {
  id: idOf('b'),
  name: 'travel-laptop',
  address: 'http://127.0.0.1:40246',
  steps: [...COMMON, { plugin: 'access', id: 'passkey', title: 'Passkey', order: 2, side: 'client' }],
};
export const MACHINES: readonly FakeMachine[] = [MACHINE_A, MACHINE_B];

/** The pairing link a person pastes for a machine: a fixed fake code, never a real one. */
export const pairLinkOf = (machine: FakeMachine, origin: string): string =>
  `${origin}/pair#v1;url=${encodeURIComponent(machine.address)};code=${FAKE_CODE};fp=${encodeURIComponent(machine.id)}`;

/** One fake daemon: the steps it declares, how each stands, and everything the page told it. */
export class FakeDaemon {
  readonly states = new Map<string, StepState>();
  readonly answers: RecordedAnswer[] = [];
  readonly requests: string[] = [];
  /** Every write (a request that is not a GET) the page sent, with its body. */
  readonly mutations: { route: string; body: unknown }[] = [];
  /** Routes the page asked for that nothing answered. */
  readonly unanswered: string[] = [];
  /** The machine name the page saved, if any. */
  named: string | undefined;
  readonly writes: { route: string; body: unknown }[] = [];
  /** The secrets this machine's vault holds (name -> value; never answered, only compared). */
  readonly vault = new Map<string, string>();
  /** Whether `warden.yaml` names the Jev key. */
  jevNamed = false;
  /** The Warden's layers in effect: a new machine has both off. */
  layers = { jev: false, llm: false };

  constructor(readonly machine: FakeMachine) {}

  view(): unknown {
    const steps = this.machine.steps.map(step => ({
      ...step,
      stepHost: true,
      state: this.states.get(`${step.plugin}.${step.id}`) ?? 'pending',
    }));
    return { steps, complete: steps.every(step => step.state !== 'pending'), setUp: true };
  }

  answer(
    request: TransportRequest,
    extra: (request: TransportRequest) => TransportAnswer | undefined,
  ): TransportAnswer {
    this.requests.push(`${request.method} ${request.path}`);
    if (request.method !== 'GET')
      this.mutations.push({ route: `${request.method} ${request.path}`, body: request.body });
    const own = this.own(request);
    if (own !== undefined) return own;
    const added = extra(request);
    if (added !== undefined) return added;
    const base = answerFor(request);
    if (base !== undefined) return base;
    this.unanswered.push(`${request.method} ${request.path}`);
    return json({ code: 'not_found', error: 'the fake machine has no answer' }, 404);
  }

  private own(request: TransportRequest): TransportAnswer | undefined {
    if (request.method === 'GET' && request.path === '/v1/onboarding') return json(this.view());
    // "Which AI do you want to use?" lists the provider catalog: the REAL one (the shipped built-in presets, as
    // `GET /v1/logins/presets` answers them), so the picker is walked over the harness ids the wire really carries.
    if (request.method === 'GET' && request.path === '/v1/logins/presets') return json(PROVIDER_PRESETS);
    const answered = /^\/v1\/onboarding\/steps\/([^/]+)\/([^/]+)$/u.exec(request.path);
    if (request.method === 'POST' && answered !== null) {
      const [, plugin = '', id = ''] = answered;
      const body = request.body as { state?: StepState } | undefined;
      const state = body?.state ?? 'done';
      this.states.set(`${plugin}.${id}`, state);
      this.answers.push({ plugin, id, state });
      const step = this.machine.steps.find(candidate => candidate.plugin === plugin && candidate.id === id);
      if (step === undefined) return json({ code: 'onboarding_unknown_step', error: 'no such step' }, 404);
      return json({ ...step, stepHost: true, state });
    }
    return undefined;
  }
}
