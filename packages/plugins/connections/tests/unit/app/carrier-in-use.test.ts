import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CarrierInUse } from '../../../app/features/carrier/carrier-in-use.tsx';
import { chooseConnection, type ConnectionMethod } from '../../../app/lib/connection.ts';

const direct: ConnectionMethod = { kind: 'direct', daemonUrl: 'https://box.example' };
const relay: ConnectionMethod = { kind: 'relay', relayUrl: 'https://relay.example', operator: 'hosted' };

const text = (html: string): string => html.replace(/<[^>]+>/gu, '');

test('E2-56 the Connection setting names the carrier in use now, beside the preference', () => {
  const choice = chooseConnection([{ method: direct, reachable: true }]);
  const html = renderToStaticMarkup(createElement(CarrierInUse, { choice }));
  expect(html).toContain('data-carrier-in-use="direct"');
  expect(text(html)).toBe('In use now: Direct');
});

test('E2-56 a relay names whose relay it is', () => {
  const choice = chooseConnection([{ method: relay, reachable: true }]);
  expect(text(renderToStaticMarkup(createElement(CarrierInUse, { choice })))).toBe(
    'In use now: Via relay — Hosted · relay.example',
  );
});

test('E2-56 before anything was carried it says so rather than guessing direct', () => {
  const html = renderToStaticMarkup(createElement(CarrierInUse, { choice: undefined }));
  expect(html).toContain('data-carrier-in-use="none"');
  expect(text(html)).toBe('In use now: Not measured yet');
});

test('E2-56 direct standing in for an unreachable relay says why, quietly (no alert, no error colour)', () => {
  const choice = chooseConnection([{ method: direct, reachable: true }]);
  const line = 'Couldn’t reach it through the relay, using the direct connection.';
  const html = renderToStaticMarkup(createElement(CarrierInUse, { choice, relayFallback: line }));
  expect(text(html)).toBe(`In use now: Direct${line}`);
  expect(html).toContain('data-carrier-in-use-why');
  expect(html).not.toContain('role="alert"');
  expect(html).not.toContain('text-err');
});

test('E2-56 an outage outranks the last measured carrier', () => {
  const choice = chooseConnection([{ method: direct, reachable: true }]);
  const health = {
    kind: 'reconnecting',
    since: 1_000,
    attempt: 1,
    nextAttemptAt: null,
    failures: [],
    cause: 'daemon-unreachable',
    stalled: false,
  } as const;
  const html = renderToStaticMarkup(createElement(CarrierInUse, { choice, health }));
  expect(html).toContain('data-carrier-in-use="reconnecting"');
});
