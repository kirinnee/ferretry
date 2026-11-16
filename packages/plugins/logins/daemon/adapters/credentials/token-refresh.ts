/** Today's process-token-refresh.ts Codex app-server path, over the kernel's process and clock ports. */
import type { Clock, SpawnPort } from '@ferretry/kernel/contract';
import { milliseconds } from '@ferretry/std';
import { CODEX_CREDENTIAL_STORE_FILE, CODEX_CREDENTIAL_STORE_KEY } from '../../lib/credentials/credentials.ts';
import {
  mergeCodexRefreshEvidence,
  NO_CODEX_REFRESH_EVIDENCE,
  scanCodexRefreshEvidence,
  type CodexRefreshEvidence,
  type FleetTokenRefreshPort,
} from '../../lib/credentials/token-refresh.ts';

const TIMEOUT_MS = 30_000;
const POLL_MS = 250;
const EVIDENCE_TAIL = 64;
const REFRESH_REQUESTS = [
  {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { clientInfo: { name: 'ferretry', title: 'Ferretry', version: '0.0.0' }, capabilities: {} },
  },
  { jsonrpc: '2.0', id: 2, method: 'getAuthStatus', params: { includeToken: false, refreshToken: true } },
];

/** The scanner retains at most one short tail, reports only closed-set evidence, and drops every stream chunk. */
async function scanRefreshStream(
  stream: ReadableStream<Uint8Array>,
  found: (evidence: CodexRefreshEvidence) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let tail = '';
  try {
    for await (const chunk of stream) {
      const text = tail + decoder.decode(chunk, { stream: true });
      found(scanCodexRefreshEvidence(text));
      tail = text.slice(-EVIDENCE_TAIL);
    }
  } catch {
    /* the stream died with the child — what was found stands */
  }
}

export function codexTokenRefresh(spawn: SpawnPort, clock: Clock): FleetTokenRefreshPort {
  return {
    refresh: async (target, settled) => {
      if (target.kind !== 'codex')
        return { outcome: 'unavailable', reason: 'Claude renews its own login on its next use' };
      try {
        // File storage is forced, as the sign-in forces it (credentials-service): a refresh must never move the credential into a
        // keyring, where no link in a ferret's home could reach it.
        const child = spawn.start(
          'codex',
          ['-c', `${CODEX_CREDENTIAL_STORE_KEY}="${CODEX_CREDENTIAL_STORE_FILE}"`, 'app-server'],
          {
            env: { CODEX_HOME: target.home },
          },
        );
        let evidence = NO_CODEX_REFRESH_EVIDENCE;
        let exited = false;
        void child.exited.then(() => {
          exited = true;
        });
        const record = (found: CodexRefreshEvidence): void => {
          evidence = mergeCodexRefreshEvidence(evidence, found);
        };
        void scanRefreshStream(child.stdout, record);
        void scanRefreshStream(child.stderr, record);
        const cancel = clock.after(milliseconds(TIMEOUT_MS), () => child.kill('SIGKILL'));
        try {
          child.write(`${REFRESH_REQUESTS.map(request => JSON.stringify(request)).join('\n')}\n`);
          for (let poll = 0; poll < TIMEOUT_MS / POLL_MS; poll += 1) {
            if (await settled()) break;
            if (exited || evidence.codes.length > 0) break;
            await clock.sleep(milliseconds(POLL_MS));
          }
          child.kill('SIGKILL');
          await child.exited;
        } finally {
          cancel();
          child.kill('SIGKILL');
        }
        return { outcome: 'ran', evidence };
      } catch {
        return { outcome: 'error', reason: 'the renewal could not be run' };
      }
    },
  };
}
