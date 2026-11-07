import { describe, expect, it } from 'bun:test';
import { useSpendToday } from '../../../app/hooks/use-spend-today.ts';
import { fakeClient, refusingClient } from './support/client.ts';
import type { UsageClient } from '../../../app/shell.ts';
import { daemonConnection } from './support/shell.ts';
import { rawResponse, rawRow } from './support/analytics-rows.ts';
import { mount } from './support/dom.ts';

const connection = daemonConnection({ daemonId: 'daemon-a', baseUrl: 'https://a.example.test', deviceId: 'token-a' });
const NOW = (): Date => new Date('2026-10-16T12:00:00.000Z');

function Probe({ client }: { readonly client: UsageClient }) {
  const usd = useSpendToday(connection, client, NOW);
  return <p data-spend="">{usd === null ? 'unknown' : usd.toFixed(2)}</p>;
}

const answering = (rows: Parameters<typeof rawResponse>[0]): UsageClient =>
  fakeClient({ 'GET /v1/usage/insights': () => rawResponse(rows) });

const shown = (container: HTMLElement): string | null => container.querySelector('[data-spend]')?.textContent ?? null;

describe('useSpendToday', () => {
  it("sums today's priced sessions in dollars", async () => {
    const view = await mount(
      <Probe
        client={answering([
          rawRow({ id: 'a', day: '2026-10-16', equivalentApiCostUsdMicros: 1_500_000 }),
          rawRow({ id: 'b', day: '2026-10-16', equivalentApiCostUsdMicros: 2_250_000 }),
        ])}
      />,
    );
    try {
      expect(shown(view.container)).toBe('3.75');
    } finally {
      await view.unmount();
    }
  });

  it('reads a quiet day as a true zero', async () => {
    const view = await mount(<Probe client={answering([])} />);
    try {
      expect(shown(view.container)).toBe('0.00');
    } finally {
      await view.unmount();
    }
  });

  it('keeps the figure unknown when the machine does not answer, never a false zero', async () => {
    const view = await mount(<Probe client={refusingClient(503, 'daemon_unreachable', 'offline')} />);
    try {
      expect(shown(view.container)).toBe('unknown');
    } finally {
      await view.unmount();
    }
  });
});
