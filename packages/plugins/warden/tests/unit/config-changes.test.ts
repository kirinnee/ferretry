/**
 * warden.yaml moving reaches a settings screen live: the kernel's config `watch` fires and the Warden publishes
 * `warden.config-changed` (carrying nothing; the truth is GET /v1/warden/config). Building the subsystem publishes
 * nothing by itself, and no sweep is armed here.
 */
import { describe, expect, test } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import { fakeConversation } from '@ferretry/plugin-conversation/contract/testing';
import { WardenConfigChanged } from '../../contract/index.ts';
import { createWardenSubsystem } from '../../daemon/subsystem.ts';
import { fakeKernel, wardenConfig } from '../support/kernel.ts';

describe('warden.yaml changes are published', () => {
  test('a change the kernel hears is published as warden.config-changed, once per change, with no payload fields', () => {
    const config = wardenConfig({ enabled: true });
    const fake = fakeKernel({ config });
    createWardenSubsystem({
      kernel: fake.kernel,
      ferrets: new FakeFerrets(),
      conversation: fakeConversation(),
      asks: new FakeAsks(),
      usage: () => undefined,
      board: () => undefined,
    });
    const changes = () => fake.published.filter(entry => entry.event === WardenConfigChanged.name);
    expect(changes()).toHaveLength(0);

    config.set({ enabled: false });
    config.set({ enabled: false, intervalMinutes: 5 });

    expect(changes()).toEqual([
      { event: 'warden.config-changed', payload: {} },
      { event: 'warden.config-changed', payload: {} },
    ]);
  });
});
