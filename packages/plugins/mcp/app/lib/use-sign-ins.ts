/**
 * Where every remote MCP server's sign-in stands, read ONCE for the whole Settings tab (`GET /v1/mcp/auth` answers the
 * whole list), and handed to each server's sign-in section — a tab with N servers that sign in asks the daemon once, not N
 * times. A section that changed something (a sign-in finished, a sign-out) asks for the list again through `reload`.
 */
import { type ReadPress, readPress } from '@ferretry/app/ui';
import { useCallback, useEffect, useState } from 'react';
import type { McpOAuthConnectionList } from '../../contract/index.ts';
import { type McpClient, readMcpSignIns } from './client.ts';
import { changeRefusalSentence } from './refusal.ts';

type McpSignInsRead =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly list: McpOAuthConnectionList }
  | { readonly kind: 'failed'; readonly reason: string };

export interface McpSignIns {
  readonly read: McpSignInsRead;
  readonly reload: () => Promise<void>;
  /** The Try again button: reads again as the person's own press, so the passkey prompt can open. */
  readonly press: () => Promise<void>;
}

export function useMcpSignIns(client: McpClient): McpSignIns {
  const [read, setRead] = useState<McpSignInsRead>({ kind: 'loading' });
  const load = useCallback(
    async (press: ReadPress): Promise<void> => {
      try {
        setRead({ kind: 'ready', list: await readMcpSignIns(client, press) });
      } catch (error) {
        setRead({ kind: 'failed', reason: changeRefusalSentence(error) });
      }
    },
    [client],
  );
  const reload = useCallback((): Promise<void> => load({}), [load]);
  const press = useCallback((): Promise<void> => load(readPress(true)), [load]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { read, reload, press };
}
