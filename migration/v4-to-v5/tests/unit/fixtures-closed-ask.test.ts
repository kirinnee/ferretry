import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * The fixture's CLOSED ask must stay closed in v5 on every boot, so it must leave no message in flight.
 *
 * When the OWNER closes an ask, v4 types a reply into the ferret's pane (a held-answer batch under `sending`) and that
 * batch is only settled once the transcript proves it arrived. CI's v4 never proves it before the fixture stops the
 * daemon (the send ledger keeps three `accepted` lines), and v5 — like v4, whose reply queue has the same rule — hands
 * an item back to its owner as "undelivered" when nothing proves its reply reached the ferret. So an owner-closed ask
 * comes back OPEN on a stopped ferret, and whether `boot-v5.ts` saw it open depended on a race (the red run on
 * rebuild/5.0 eb1ec46303; the same home reproduces it on the earlier base b16092b7e7). The ferret closing its own ask
 * (`agenda done --reason`: "why you close a question the owner has not answered") types nothing to anyone.
 */
const BUILDER = resolve(import.meta.dir, '../../fixtures/build-v4-home.ts');

test('the fixture closes its closed ask as the ferret that raised it, not as the owner', async () => {
  const source = await readFile(BUILDER, 'utf8');
  const call = /fyOk\(\s*\[\s*'agenda',\s*'done',\s*`!\$\{closed\}`[\s\S]*?\)\s*;/u.exec(source)?.[0];
  expect(call).toBeDefined();
  expect(call).toMatch(/\bas:\s*target\b/u);
});
