import type { RestartCancelResult, RestartRequest, RestartResult, RestartStatus } from '@ferretry/protocol';
import type { IRestartGateway } from '../../../src/lib/restart/ports.ts';
import { capturedPresenter } from '../session/controller-doubles.ts';

const RESULT: RestartResult = {
  restarted: [{ id: 'ses-1', name: 'Wren' }],
  queued: [
    { id: 'ses-2', name: 'Fern', reason: 'mid-turn' },
    { id: 'ses-3', reason: 'in-flight', detail: 'a test run is open' },
    { id: 'ses-4', reason: 'own-session' },
  ],
  skipped: [{ id: 'ses-5', reason: 'not-outdated' }],
  failed: [],
};

const STATUS: RestartStatus = {
  outdated: [{ id: 'ses-2', name: 'Fern', sections: ['notify', 'pack'] }],
  queued: [{ id: 'ses-3', since: '2026-10-30T01:00:00.000Z', reason: 'in-flight', onlyIfOutdated: true }],
};

export class RecordingRestartGateway implements IRestartGateway {
  readonly requests: { request: RestartRequest; requestId?: string }[] = [];
  cancels = 0;

  constructor(
    private result: RestartResult = RESULT,
    private readonly status: RestartStatus = STATUS,
    private readonly cancelled: RestartCancelResult = { cancelled: 2 },
  ) {}

  restart(request: RestartRequest, requestId?: string): Promise<RestartResult> {
    this.requests.push({ request, ...(requestId === undefined ? {} : { requestId }) });
    return Promise.resolve(this.result);
  }

  restartStatus(): Promise<RestartStatus> {
    return Promise.resolve(this.status);
  }

  cancelRestarts(): Promise<RestartCancelResult> {
    this.cancels += 1;
    return Promise.resolve(this.cancelled);
  }
}

export function restartHarness(gateway = new RecordingRestartGateway()) {
  const { io, presenter } = capturedPresenter();
  return { gateway, io, presenter };
}
