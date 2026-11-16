import type { PluginClient } from '@ferretry/kernel/manifest';
import { CarriersChanged, CarriersViewSchema, type PublishedCarriers } from '../../contract/index.ts';
import type { CarrierWriteBack } from './carrier-write-back.ts';

/**
 * WATCHING ONE DAEMON'S PUBLISHED CARRIERS (P51, R170, R186, R198, R210).
 *
 * `GET /v1/carriers` is read as soon as the watch starts, whenever the daemon says its carriers changed
 * (`CarriersChanged`), and whenever the daemon's event feed comes back live — the reconnect, where v4 wrote the
 * answer back from `carrier.onConnected`. Each readable answer goes to `onAnswer`, and, when a write-back is given,
 * REPLACES the set this device stores for that daemon.
 *
 * Stopping removes every listener it added and drops an answer still in flight, so a watch that is started and
 * stopped many times (a half rebuilt on every reconnect, a screen opened and closed) leaves nothing behind.
 */
export interface CarrierWatch {
  readonly client: PluginClient;
  /** The paired daemon whose stored set the answer replaces; without it (or without `writeBack`) nothing is written. */
  readonly daemon?: string | undefined;
  readonly writeBack?: CarrierWriteBack | undefined;
  readonly onAnswer?: ((carriers: PublishedCarriers) => void) | undefined;
}

export function watchCarriers({ client, daemon, writeBack, onAnswer }: CarrierWatch): () => void {
  let stopped = false;
  const refresh = (): void => {
    const adopt = daemon === undefined ? undefined : writeBack?.begin(daemon);
    void Promise.resolve()
      .then(() => client.call('GET /v1/carriers'))
      .then(value => {
        if (stopped) return;
        const parsed = CarriersViewSchema.safeParse(value);
        if (!parsed.success) return;
        adopt?.(parsed.data.carriers);
        onAnswer?.(parsed.data.carriers);
      })
      .catch(() => undefined);
  };
  const cancels = [
    client.subscribe(CarriersChanged, refresh),
    client.feed?.subscribeLive(live => {
      if (live) refresh();
    }),
  ];
  refresh();
  return () => {
    stopped = true;
    for (const cancel of cancels) cancel?.();
  };
}
