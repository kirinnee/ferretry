import type { InputDeliverBody, InputDeliverResult, InputRequest, InputRequestList } from '@ferretry/protocol';
import type { IHiddenValuePrompt, IInputGateway, IInputOutput, InputPorts } from '../../../src/lib/input/ports';

export const SESSION = 'ms8kkfyd-95b7037e';
export const REQUEST_ID = 'b'.repeat(32);
export const DIGEST = 'c'.repeat(64);
const AT = '2026-10-30T09:00:00.000Z';
const NOW = Date.parse('2026-10-30T09:02:00.000Z');
export const VALUE = 'hunter2-UNIQUE';
export const DELIVERY = '7b0a5f1c-3a49-4a7e-9d69-2f2a7f6c2e11';

export function request(overrides: Partial<InputRequest> = {}): InputRequest {
  return {
    id: REQUEST_ID,
    sessionId: SESSION,
    agendaItemId: 'A7',
    target: { kind: 'terminal', key: 'dev' },
    prompt: 'sudo password to install the package',
    sensitivity: 'secret',
    fields: [{ id: 'value', label: 'Password', sensitivity: 'secret' }],
    submit: 'offer-owner',
    raisedAt: AT,
    expiresAt: '2026-10-30T09:10:00.000Z',
    observed: {
      kind: 'terminal',
      paneProof: { paneId: '%3', pid: 1234 },
      foreground: { pid: 4321, pgid: 4321, comm: 'sudo', argv: 'sudo apt install jq' },
      echo: 'off',
      cursorRow: 4,
      promptLine: '[sudo] password for deploy:',
      promptLineDigest: DIGEST,
      recognisedConsumer: true,
    },
    observedDigest: DIGEST,
    state: 'pending',
    ...overrides,
  };
}

class RecordingOutput implements IInputOutput {
  readonly messages: string[] = [];
  readonly diagnostics: string[] = [];

  success(message: string): void {
    this.messages.push(message);
  }

  diagnostic(message: string): void {
    this.diagnostics.push(message);
  }

  /** Everything this output was ever given, for the leak sweep. */
  all(): string {
    return [...this.messages, ...this.diagnostics].join('\n');
  }
}

export class FakeInputGateway implements IInputGateway {
  readonly listed: string[] = [];
  readonly delivered: Array<{ sessionId: string; requestId: string; body: InputDeliverBody }> = [];
  readonly cancelled: Array<{ sessionId: string; requestId: string }> = [];

  constructor(
    private readonly requests: readonly InputRequest[] = [request()],
    private readonly result: Partial<InputDeliverResult> = {},
  ) {}

  list(sessionId: string): Promise<InputRequestList> {
    this.listed.push(sessionId);
    return Promise.resolve({ requests: [...this.requests] });
  }

  deliver(sessionId: string, requestId: string, body: InputDeliverBody): Promise<InputDeliverResult> {
    this.delivered.push({ sessionId, requestId, body });
    return Promise.resolve({
      id: REQUEST_ID,
      deliveryId: body.deliveryId,
      state: 'delivered',
      submitted: body.submit,
      ...this.result,
    });
  }

  cancel(sessionId: string, requestId: string): Promise<InputRequest> {
    this.cancelled.push({ sessionId, requestId });
    return Promise.resolve(request({ state: 'cancelled' }));
  }
}

export class FakeHiddenPrompt implements IHiddenValuePrompt {
  readonly asked: string[] = [];

  constructor(private readonly value: string = VALUE) {}

  askHidden(message: string): Promise<string> {
    this.asked.push(message);
    return Promise.resolve(this.value);
  }
}

export interface Rig {
  readonly gateway: FakeInputGateway;
  readonly out: RecordingOutput;
  readonly prompt: FakeHiddenPrompt;
  readonly ports: InputPorts;
}

export function rig(
  overrides: Partial<Omit<InputPorts, 'gateway' | 'out' | 'prompt'>> = {},
  gateway = new FakeInputGateway(),
  prompt = new FakeHiddenPrompt(),
): Rig {
  const out = new RecordingOutput();
  return {
    gateway,
    out,
    prompt,
    ports: {
      gateway,
      out,
      prompt,
      interactive: true,
      ownSessionId: undefined,
      agentCredential: undefined,
      now: () => NOW,
      newDeliveryId: () => DELIVERY,
      ...overrides,
    },
  };
}
