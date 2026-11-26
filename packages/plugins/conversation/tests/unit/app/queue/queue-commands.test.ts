import { describe, expect, it } from 'bun:test';
import type { PluginCommandContext } from '@ferretry/app';
import type { PluginClient } from '@ferretry/kernel/manifest';
import { queueCommands } from '../../../../app/queue/queue-commands.ts';

/** G6 · A-35: Find lists a "Queue" place that opens the All queues screen. */
const contextOf = (went: string[], mounted = true): PluginCommandContext => ({
  client: {} as unknown as PluginClient,
  daemon: 'dm1',
  navigate: href => went.push(href),
  screenHref: (daemon, plugin, screen) =>
    mounted && plugin === 'conversation' && screen === 'queues' ? `/d/${daemon}/conversation/queues` : undefined,
  changed: () => undefined,
});

describe('Queue in the command bar', () => {
  it('S-0531 lists one "Queue" place at rest, found by queue, outbox, waiting or pending', () => {
    const [place, ...rest] = queueCommands(contextOf([]))();
    expect(rest).toEqual([]);
    expect(place?.label).toBe('Queue');
    expect(place?.group).toBe('Go to');
    expect(place?.resting).toBe(true);
    expect(place?.keywords).toEqual(expect.arrayContaining(['queues', 'outbox', 'waiting']));
  });

  it('opens the All queues screen of that daemon', () => {
    const went: string[] = [];
    queueCommands(contextOf(went))()[0]?.run();
    expect(went).toEqual(['/d/dm1/conversation/queues']);
  });

  it('is absent when the daemon has no such screen', () => {
    expect(queueCommands(contextOf([], false))()).toEqual([]);
  });
});

describe('Conversation’s half offers Queue to the shell', () => {
  it('lists "Queue" among its command sources, over the real manifest’s `queues` screen', async () => {
    const { default: half } = await import('../../../../app/index.ts');
    const { default: manifest } = await import('../../../../manifest.ts');
    expect((manifest.ui?.screens ?? []).map(screen => screen.id)).toContain('queues');
    const sources = half.shell.commands?.(contextOf([])) ?? [];
    const listed = Array.isArray(sources) ? sources : [sources];
    const labels = listed.flatMap(source => (typeof source === 'function' ? source('') : [])).map(entry => entry.label);
    expect(labels).toContain('Queue');
  });
});
