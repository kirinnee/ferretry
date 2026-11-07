import type { FerretSummary } from '@ferretry/core-ferrets/contract';
import {
  deviceStanding,
  ferretStanding,
  ownerStanding,
  StandInAdmission,
  wardenStanding,
} from '@ferretry/core-gate/contract/testing';
import type { InputRaise, SecretName } from '@ferretry/core-vault/contract';
import { FakeInputHolds, FakeRedaction } from '@ferretry/core-vault/contract/testing';
import { ApiError, type CallStanding, type FerretId } from '@ferretry/kernel/contract';
import { implementDaemon } from '@ferretry/kernel/manifest';
import { type OpenSocket, type TestCaller, type TestHost, type TestResponse, testHost } from '@ferretry/kernel/testing';
import { buildTerminals } from '../../../../../daemon/index.ts';
import type { TerminalRecord } from '../../../../../daemon/lib/terminal/contracts.ts';
import manifest from '../../../../../manifest.ts';
import {
  FakeTerminalRuntime,
  FERRET,
  fakeFerrets,
  fakeVault,
  ferretSummary,
  ScriptedTmux,
} from '../../../../support/daemon/half.ts';

/**
 * The terminal routes and stream on the kernel's test host, driving Terminals' real half (`buildTerminals`) over a
 * faked runtime, with a stand-in Gate admission whose caller each case chooses.
 */

export { FERRET };

/** Who a case calls as. `odd-device` is a paired device whose id the wire cannot carry. */
export type Caller = 'owner' | 'device' | 'odd-device' | 'ferret' | 'warden' | 'anonymous';

const STANDINGS: Readonly<Record<Caller, () => CallStanding | undefined>> = {
  owner: () => ownerStanding(),
  device: () => deviceStanding('device-1', undefined, true),
  'odd-device': () => deviceStanding('device with spaces', undefined, true),
  ferret: () => ferretStanding(FERRET),
  warden: () => wardenStanding('w-1' as FerretId),
  anonymous: () => undefined,
};

const TEST_CALLERS: Readonly<Record<Caller, TestCaller>> = {
  owner: { kind: 'owner' },
  device: { kind: 'device', holder: 'device-1' },
  'odd-device': { kind: 'device', holder: 'device with spaces' },
  ferret: { kind: 'ferret', id: FERRET },
  warden: { kind: 'warden' },
  anonymous: { kind: 'anonymous' },
};

/** A runtime whose listing can be made to fail, the way a tmux that will not answer does. */
export class FailableRuntime extends FakeTerminalRuntime {
  listFails: Error | undefined;

  override async list(): Promise<readonly TerminalRecord[]> {
    if (this.listFails !== undefined) throw this.listFails;
    return await super.list();
  }
}

export interface MountHalf {
  readonly host: TestHost;
  readonly runtime: FailableRuntime;
  call(method: string, path: string, body?: unknown, as?: Caller): Promise<TestResponse>;
  /** Opens the stream, or answers the refusal made before the protocol switched. */
  stream(
    path: string,
    as?: Caller,
  ): Promise<{ readonly socket?: OpenSocket; readonly status?: number; readonly code?: string }>;
}

export async function mountHalf(
  options: { readonly ferrets?: readonly FerretSummary[]; readonly config?: Readonly<Record<string, unknown>> } = {},
): Promise<MountHalf> {
  const runtime = new FailableRuntime();
  let caller: Caller = 'owner';
  const raised: { ferret: string; raise: InputRaise }[] = [];
  const plugin = implementDaemon(manifest, {
    build: ctx => buildTerminals(ctx, { tmux: new ScriptedTmux(), socketPath: '/state/terminals/tmux.sock', runtime }),
  });
  const host = await testHost({
    plugins: [plugin],
    fakes: { ferrets: fakeFerrets(options.ferrets ?? [ferretSummary()]), vault: fakeVault(raised) },
    gate: new StandInAdmission(() => STANDINGS[caller]()),
    holds: new FakeInputHolds().holds,
    redaction: new FakeRedaction(new Map([['GITHUB_TOKEN' as SecretName, 'hunter2']])),
    ...(options.config === undefined ? {} : { config: options.config }),
  });
  return {
    host,
    runtime,
    call: async (method, path, body, as = 'owner') => {
      caller = as;
      return await host.request(method, path, {
        ...(body === undefined ? {} : { body }),
        as: TEST_CALLERS[as],
      });
    },
    stream: async (path, as = 'owner') => {
      caller = as;
      try {
        const socket = await host.socket(path, { as: TEST_CALLERS[as] });
        if (socket.response === undefined) return { socket };
        const body = JSON.parse(socket.response.body) as { readonly code?: string };
        return { status: socket.response.status, ...(body.code === undefined ? {} : { code: body.code }) };
      } catch (error) {
        // The accept step refuses by throwing the route's answer, before any socket exists.
        if (error instanceof ApiError)
          return { status: error.status, ...(error.code === undefined ? {} : { code: error.code }) };
        throw error;
      }
    },
  };
}

export const jsonBody = (response: TestResponse): unknown => JSON.parse(response.body);
