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
  expect(html).toContain('Hosted · relay.example');
  expect(html).toContain('offline');
});
test('the lead line never repeats itself, and says only what the app knows about whose relay it is', () => {
  const lead = (operator: 'hosted' | 'configured' | undefined): string => {
    const method: ConnectionMethod = {
      kind: 'relay',
      relayUrl: 'https://relay.example',
      ...(operator === undefined ? {} : { operator }),
    };
    const choice = chooseConnection([{ method, reachable: true }]);
    const html = renderToStaticMarkup(createElement(ActiveCarrierCard, { choice, relayAdvertised: true }));
    return (/data-connection-status="relay">(.*?)<\/p>/u.exec(html)?.[1] ?? '').replace(/<[^>]+>/gu, '');
  };
  expect(lead(undefined)).toBe('Via relay — relay.example');
  expect(lead('configured')).toBe('Via relay — Configured · relay.example');
  expect(lead('hosted')).toBe('Via relay — Hosted · relay.example');
});
test('the disclosure heading covers what the list says they cannot do', () => {
  const choice = chooseConnection([{ method: relay, reachable: true }]);
  const html = renderToStaticMarkup(createElement(ActiveCarrierCard, { choice, relayAdvertised: true }));
  expect(html).toContain('What the parties on this path can and cannot see');
  expect(html).not.toContain('can see<');
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
test('R15 the card links the self-hosting runbook and offers no relay setting of its own', () => {
  const html = renderToStaticMarkup(createElement(ActiveCarrierCard, { choice: undefined, relayAdvertised: true }));
  expect(html).toContain('Running your own relay is an expert option set on the daemon, not in this app.');
  expect(html).toContain('href="https://github.com/kirinnee/ferretry/blob/main/docs/cloudflare-relay-self-hosting.md"');
  expect(html).toContain('rel="noreferrer noopener"');
  // Nothing on the card can be typed into or pressed: the runbook link is the only way to the topic.
  expect(html).not.toContain('<input');
  expect(html).not.toContain('<button');
  expect(html.match(/<a /gu)).toHaveLength(1);
});
