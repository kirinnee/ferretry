import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import type { FerretState, FerretSummary } from '@ferretry/core-ferrets/contract';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import { type FakeBrowsers, fakeBrowsers } from '@ferretry/plugin-browsers/contract/testing';
import { fakeConversation } from '@ferretry/plugin-conversation/contract/testing';
import type { LivenessSample, TerminalsApi } from '@ferretry/plugin-terminals/contract';
import { fakeTerminals } from '@ferretry/plugin-terminals/contract/testing';
import { createWardenSubsystem, WARDEN_LIVENESS_TICK_SECONDS } from '../../../daemon/subsystem.ts';
import { fakeKernel, wardenConfig } from '../../support/kernel.ts';
import { waitFor } from '../../support/wait-for.ts';

export const START = '2026-11-07T12:00:00.000Z';
export const FERRET = ferretId('f1');
const TICK_MS = WARDEN_LIVENESS_TICK_SECONDS * 1000;

export interface LivenessHostOptions {
  /** The ferret's state: `working` is mid-turn, `idle` has ended its turn (`your-turn`). */
  readonly state?: FerretState;
  /** What Terminals' look at the pane shows on the n-th look (1-based). */
  readonly sample?: (look: number) => LivenessSample;
  /** The transcript cannot be read (Conversation refuses), so the only evidence is the pane's. */
  readonly transcript?: 'unreadable';
  /** Terminals off: no look at any pane. */
  readonly terminalsOff?: boolean;
  /** Browsers off, or the fake that closes leftovers (default: one that closes one). */
  readonly browsers?: FakeBrowsers | 'off';
  /** `warden.yaml`, as the owner wrote it. */
  readonly config?: unknown;
  /** What else Ferrets' summary of the ferret says: a declared wait, its own nudge and frozen times. */
  readonly ferret?: Partial<FerretSummary>;
}

const settle = async (): Promise<void> => await new Promise(resolve => setTimeout(resolve, 15));

/**
 * The Warden's real subsystem over one auto ferret, a Terminals whose pane looks the test scripts, a Browsers that
 * records what it was asked to close, and a manual clock: `ticks(n)` moves it one liveness tick at a time and lets
 * each tick (look, fold, reflex) finish before the next.
 */
export function livenessHost(options: LivenessHostOptions = {}) {
  const fake = fakeKernel({ start: START, config: wardenConfig(options.config) });
  const ferrets = new FakeFerrets();
  ferrets.add({
    id: FERRET,
    state: options.state ?? 'working',
    mode: 'auto',
    createdAt: START,
    stateAt: START,
    ...options.ferret,
  } as never);
  const base = fakeConversation();
  const conversation =
    options.transcript === 'unreadable'
      ? {
          ...base,
          transcriptEvents: async () => {
            throw new Error('the transcript cannot be read');
          },
          transcriptLog: async () => {
            throw new Error('the transcript cannot be read');
          },
        }
      : base;
  let looks = 0;
  const terminals: TerminalsApi = {
    ...fakeTerminals(),
    liveness: async () => {
      looks += 1;
      return options.sample?.(looks) ?? {};
    },
  };
  const browsers =
    options.browsers === 'off'
      ? undefined
      : (options.browsers ?? fakeBrowsers({}, undefined, { f1: { closed: 1, leftAlone: [] } }));
  const subsystem = createWardenSubsystem({
    kernel: fake.kernel,
    ferrets,
    conversation,
    asks: new FakeAsks(),
    usage: () => undefined,
    board: () => undefined,
    terminals: () => (options.terminalsOff === true ? undefined : terminals),
    browsers: () => browsers,
  });
  return {
    subsystem,
    conversation: base,
    browsers,
    published: fake.published,
    /** The daemon log lines the Warden's journal wrote (`kernel.log.info`). */
    logged: fake.logged,
    looks: () => looks,
    /** Arms the subsystem: the sweep timer and the liveness tick. */
    arm: () => subsystem.arm(),
    /** `n` liveness ticks, each let finish. */
    ticks: async (n: number): Promise<void> => {
      for (let tick = 0; tick < n; tick += 1) {
        const before = looks;
        await fake.clock.advance(TICK_MS);
        if (options.terminalsOff !== true) await waitFor(() => looks > before, 'a liveness look');
        await settle();
      }
    },
    /** One sweep, as `POST /v1/warden/run` asks for it, and the kinds it flagged for the ferret. */
    sweep: async (): Promise<readonly string[]> => {
      const view = await subsystem.run(false);
      return view.anomalies.filter(anomaly => anomaly.sessionId === FERRET).map(anomaly => anomaly.kind);
    },
  };
}
