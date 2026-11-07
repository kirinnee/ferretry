import type { AppComponent, PanelProps } from '@ferretry/kernel/manifest';
import { useCallback, useEffect, useState } from 'react';
import { type PackRow, type PackTable, PackTableSchema } from '../../contract/index.ts';
import { HelpersPack } from '../components/helpers.tsx';
import { PackNote, PackSwitchRow, usePackFerretSwitch } from '../features/pack/pack-ferret-switch.tsx';
import { type PacksClient, refusalSentence } from '../lib/client.ts';
import { helpersOf } from '../lib/helper-state.ts';
import { ferretHref } from '../lib/shell-ports.ts';
import { useShellClock } from '../ui.ts';

/** How often the lead's table is read again while the panel is open, in milliseconds. */
const REFRESH_MS = 5_000;

type Read =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly rows: readonly PackRow[] }
  | { readonly kind: 'failed'; readonly message: string };

/**
 * The panel beside a ferret (`ferret.side`): its own Pack mode switch, and the helpers it started — the active ones as a
 * list, the finished ones behind "Show finished (n)". The rows are the daemon's pack table for this ferret
 * (`GET /v1/ferrets/:ferretId/pack`), read again every few seconds, so a card or a list never keeps a copy.
 */
export const createPanel = (client: PacksClient): AppComponent<PanelProps> =>
  function HelpersPanel({ subject }: PanelProps) {
    const control = usePackFerretSwitch({ client });
    const clock = useShellClock();
    const [read, setRead] = useState<Read>({ kind: 'loading' });
    const load = useCallback(async (): Promise<Read> => {
      if (subject === undefined) return { kind: 'ready', rows: [] };
      try {
        const table: PackTable = PackTableSchema.parse(
          await client.call('GET /v1/ferrets/:ferretId/pack', { params: { ferretId: subject } }),
        );
        return { kind: 'ready', rows: helpersOf(subject, table.rows) };
      } catch (cause) {
        return { kind: 'failed', message: refusalSentence(cause) };
      }
    }, [subject]);
    useEffect(() => {
      let live = true;
      const tick = (): void => {
        void load().then(next => {
          if (live) setRead(next);
        });
      };
      tick();
      const stop = clock.every(REFRESH_MS, tick);
      return () => {
        live = false;
        stop();
      };
    }, [load, clock]);
    if (subject === undefined) return null;
    return (
      <section aria-label="Helpers" data-panel="helpers">
        <PackSwitchRow ferretId={subject} control={control} />
        <PackNote note={control.note} dismiss={control.dismiss} />
        {read.kind === 'loading' ? <p role="status">Reading helpers…</p> : null}
        {read.kind === 'failed' ? <p role="alert">{read.message}</p> : null}
        {read.kind === 'ready' ? (
          <HelpersPack
            rows={read.rows}
            onOpenFerret={ferretId => {
              window.location.assign(ferretHref(ferretId));
            }}
          />
        ) : null}
      </section>
    );
  };
