import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { RunningHost } from '../../../host/host.ts';
import { listenLocal } from '../../../host/listener.ts';

const originalServe = Bun.serve;
afterEach(() => {
  Bun.serve = originalServe;
});

describe('partial local listener startup', () => {
  for (const failure of ['chmod', 'tcp', 'write'] as const) {
    test(`a ${failure} failure releases every acquired listener and file in reverse`, async () => {
      const releases: string[] = [];
      let starts = 0;
      spyOn(Bun, 'serve').mockImplementation((() => {
        starts++;
        const name = starts === 1 ? 'unix' : 'tcp';
        if (name === failure) throw new Error(failure);
        return {
          port: 1234,
          stop: async () => {
            releases.push(`stop:${name}`);
          },
        };
      }) as unknown as typeof Bun.serve);
      await expect(
        listenLocal({} as RunningHost, {
          home: '/tmp/host-listener-fixture',
          port: 0,
          pid: 1,
          version: '5.0.0',
          remove: async path => {
            releases.push(`remove:${path.split('/').at(-1)}`);
          },
          chmod: async () => {
            if (failure === 'chmod') throw new Error(failure);
          },
          write: async () => {
            if (failure === 'write') throw new Error(failure);
          },
        }),
      ).rejects.toThrow(failure);
      const stops = releases.filter(item => item.startsWith('stop:'));
      expect(stops).toEqual(failure === 'write' ? ['stop:tcp', 'stop:unix'] : ['stop:unix']);
      expect(releases.at(-1)).toBe('remove:fyd.sock');
      if (failure === 'write') expect(releases[1]).toBe('remove:daemon.json');
    });
  }
});
