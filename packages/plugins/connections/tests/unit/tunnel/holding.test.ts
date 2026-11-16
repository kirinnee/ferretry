import { expect, it } from 'bun:test';
import { MemoryStateFolder } from '@ferretry/kernel/testing';
import manifest from '../../../manifest.ts';
import { FileTunnelHolding } from '../../../daemon/adapters/tunnel/file-tunnel-holding.ts';

it('R664 persists a format:1 tunnel holding without its connector token and forgets idempotently', async () => {
  const folder = new MemoryStateFolder();
  const holding = new FileTunnelHolding(folder.port(manifest.data.state));
  const value = { origin: 'https://service.example', tunnelUrl: 'https://quiet-otter.tunnels.example' };
  expect(await holding.read()).toBeUndefined();
  await holding.record(value);
  expect(await holding.read()).toEqual(value);
  expect(JSON.parse(folder.raw(manifest.data.state[0])!)).toEqual({ format: 1, ...value });
  await holding.forget();
  await holding.forget();
  expect(await holding.read()).toBeUndefined();
});
it('F-0350 a damaged tunnel holding fails closed', async () => {
  const folder = new MemoryStateFolder();
  const holding = new FileTunnelHolding(folder.port(manifest.data.state));
  folder.plant(manifest.data.state[0], '{broken');
  await expect(holding.read()).rejects.toThrow();
});
