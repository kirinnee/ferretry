/** A worker module as a plugin writes one: it reaches only what its half granted, and says what happened. */
import { workerData } from 'node:worker_threads';
import { fetchPort, rootPort, WorkerGrantRefusal } from '../../../../worker.ts';
import { WORKER_GRANTS_KEY } from '../../../../host/worker-grants/wire.ts';

declare const self: Worker;

type Command =
  | { probe: true }
  | { op: 'root'; id: string; method: string; args: unknown[] }
  | { op: 'shape'; id: string }
  | { op: 'fetch'; url: string; init?: { method?: string } }
  | { op: 'fetch-port' }
  | { op: 'forge'; message: unknown }
  | { op: 'data' };

const failed = (error: unknown) => ({
  ok: false,
  type: error instanceof WorkerGrantRefusal ? 'refusal' : (error as Error).constructor.name,
  refusal: error instanceof WorkerGrantRefusal ? error.refusal : undefined,
  message: (error as Error).message,
});

self.onmessage = async (event: MessageEvent<Command>) => {
  const command = event.data;
  if ('probe' in command) return self.postMessage({ ok: true, probe: true });
  try {
    switch (command.op) {
      case 'root': {
        const handle = rootPort(command.id as never);
        const method = (handle as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>)[command.method];
        return self.postMessage({ ok: true, value: await method?.(...command.args) });
      }
      case 'shape':
        return self.postMessage({ ok: true, value: Object.keys(rootPort(command.id as never)).sort() });
      case 'fetch-port':
        return self.postMessage({ ok: true, value: Object.keys(fetchPort()) });
      case 'fetch': {
        const response = await fetchPort().request(command.url, command.init);
        return self.postMessage({
          ok: true,
          value: { status: response.status, location: response.headers.get('location'), text: await response.text() },
        });
      }
      case 'forge': {
        // Straight onto the grant channel, as a forged message would be: the main thread alone decides.
        const port = (workerData as Record<string, { port: MessagePort }>)[WORKER_GRANTS_KEY]?.port as MessagePort;
        const answer = new Promise<unknown>(resolve => {
          port.onmessage = (answered: MessageEvent) => resolve(answered.data);
        });
        port.postMessage(command.message);
        return self.postMessage({ ok: true, value: await answer });
      }
      case 'data': {
        const grants = (workerData as Record<string, unknown> | null)?.[WORKER_GRANTS_KEY] as
          | { roots?: unknown; network?: unknown; port?: unknown }
          | undefined;
        return self.postMessage({
          ok: true,
          value: {
            keys: Object.keys((workerData as object | null) ?? {}),
            grantKeys: Object.keys(grants ?? {}),
            roots: grants?.roots,
            network: grants?.network,
            plain: JSON.stringify({ ...grants, port: undefined }),
          },
        });
      }
    }
  } catch (error) {
    self.postMessage(failed(error));
  }
};
