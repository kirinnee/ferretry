import {
  type AgendaVersionsRequest,
  type AgendaVersionsResponse,
  serveAgendaVersions,
} from '../../../daemon/adapters/agenda/agenda-versions-program.ts';
import type { HostedWorker } from '../../src/adapters/runtime/bundled-worker-host.ts';

/** The real archive worker program over an in-process message scope; no thread in deterministic tests. */
export function inlineAgendaVersionsWorker(): HostedWorker<AgendaVersionsRequest, AgendaVersionsResponse> {
  const scope = {
    onmessage: null as ((event: MessageEvent<AgendaVersionsRequest>) => void) | null,
    postMessage: (data: AgendaVersionsResponse) => worker.onmessage?.({ data } as MessageEvent<AgendaVersionsResponse>),
  };
  const worker: HostedWorker<AgendaVersionsRequest, AgendaVersionsResponse> = {
    onmessage: null,
    onerror: null,
    postMessage: data => scope.onmessage?.({ data } as MessageEvent<AgendaVersionsRequest>),
    terminate: () => {
      scope.onmessage = null;
    },
  };
  serveAgendaVersions(scope);
  return worker;
}
