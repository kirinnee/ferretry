/**
 * THE LIVE READ BEHIND BOTH CARDS (a React hook). Reads when it mounts, again when Ferrets says this ferret changed, on a
 * 2 s beat while the ferret is stopped for input (a card must follow the pane quickly) and a slow beat otherwise (a
 * prompt can appear without the ferret's state moving). `refresh` re-reads at once: an answered card asks for it. A read
 * that fails is "stopped on nothing", so a flaky connection never leaves a stale card up for long.
 */

import { FerretsChanged } from '@ferretry/core-ferrets/contract';
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import type { ClaudeCodeClient } from '../lib/client.ts';
import { NOT_STOPPED, POLL_IDLE_MS, POLL_STOPPED_MS, readStoppedOn, type StoppedOn } from '../lib/prompt-read.ts';

/** The name the cards call the ferret, until the ferret's own is known. */
const FALLBACK_AGENT_NAME = 'The ferret';

const NameRead = z.looseObject({ name: z.string().min(1) });

export function useStoppedOn(
  client: ClaudeCodeClient,
  ferret: string | undefined,
): { readonly stoppedOn: StoppedOn; readonly agentName: string; readonly refresh: () => void } {
  const [stoppedOn, setStoppedOn] = useState<StoppedOn>(NOT_STOPPED);
  const [agentName, setAgentName] = useState(FALLBACK_AGENT_NAME);
  const live = useRef(true);
  const reading = useRef(0);

  const read = useCallback(async (): Promise<void> => {
    if (ferret === undefined) return;
    const turn = ++reading.current;
    const found = await readStoppedOn(client, ferret);
    // An older read that lands after a newer one never wins; one that lands after the panel left does nothing.
    if (live.current && turn === reading.current) setStoppedOn(found);
  }, [client, ferret]);

  useEffect(() => {
    live.current = true;
    if (ferret === undefined) return;
    void read();
    client.call('GET /v1/ferrets/:ferretId', { params: { ferretId: ferret } }).then(
      answer => {
        const named = NameRead.safeParse(answer);
        if (live.current && named.success) setAgentName(named.data.name);
      },
      () => undefined,
    );
    const cancel = client.subscribe(FerretsChanged, payload => {
      if (payload.ferret === ferret) void read();
    });
    return () => {
      live.current = false;
      cancel();
    };
  }, [client, ferret, read]);

  const waitingForInput = stoppedOn.needsInput;
  useEffect(() => {
    if (ferret === undefined) return;
    const timer = setInterval(() => void read(), waitingForInput ? POLL_STOPPED_MS : POLL_IDLE_MS);
    return () => clearInterval(timer);
  }, [ferret, read, waitingForInput]);

  return { stoppedOn, agentName, refresh: () => void read() };
}
