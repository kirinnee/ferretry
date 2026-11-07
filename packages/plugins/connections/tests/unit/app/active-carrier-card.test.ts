import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActiveCarrierCard, CARRIER_UNMEASURED } from '../../../app/features/carrier/active-carrier-card.tsx';
import { chooseConnection, describeConnectionMethod, type ConnectionMethod } from '../../../app/lib/connection.ts';
const direct: ConnectionMethod = { kind: 'direct', daemonUrl: 'https://box.example' };
const relay: ConnectionMethod = { kind: 'relay', relayUrl: 'https://relay.example', operator: 'hosted' };
test('R224 an unmeasured carrier never defaults to direct', () => {
  const html = renderToStaticMarkup(createElement(ActiveCarrierCard, { choice: undefined, relayAdvertised: true }));
  expect(html).toContain(CARRIER_UNMEASURED);
  expect(html).not.toContain('Connected over direct');
});
test('R8 the measured carrier names why the others were passed over', () => {
  const choice = chooseConnection([
    { method: direct, reachable: false, detail: 'offline' },
    { method: relay, reachable: true },
  ]);
  const html = renderToStaticMarkup(createElement(ActiveCarrierCard, { choice, relayAdvertised: true }));
  expect(html).toContain(choice.reason);
  expect(html).toContain('Hosted relay');
  expect(html).toContain('offline');
});
test('R121 the direct carrier discloses only the parties actually on its path', () => {
  const html = renderToStaticMarkup(
    createElement(ActiveCarrierCard, {
      choice: chooseConnection([{ method: direct, reachable: true }]),
      relayAdvertised: true,
    }),
  );
  for (const observer of describeConnectionMethod(direct).observers) expect(html).toContain(observer);
  expect(html).not.toContain('fy_daemon_');
});
