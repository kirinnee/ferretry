import { describe, expect, test } from 'bun:test';
import type { CommandLocation } from '@ferretry/kernel/contract';
import { KernelCloudflaredLocator } from '../../../daemon/adapters/tunnel/cloudflared-locator.ts';

/** The kernel's `locate`, answering what it is told to and remembering what it was asked. */
function locator(answer: CommandLocation) {
  const asked: unknown[] = [];
  const subject = new KernelCloudflaredLocator({
    locate: async (name, options) => {
      asked.push([name, options]);
      return answer;
    },
  });
  return { asked, subject };
}

describe('where cloudflared is, as the kernel finds it (the real adapter)', () => {
  test('asks for cloudflared with the one override variable, and passes a found binary on with how it was found', async () => {
    const { asked, subject } = locator({ kind: 'found', path: '/usr/bin/cloudflared', via: 'path' });

    expect(await subject.locate()).toEqual({ kind: 'found', path: '/usr/bin/cloudflared', via: 'path' });
    expect(asked).toEqual([['cloudflared', { override: 'FY_CLOUDFLARED' }]]);
  });

  test('says a named path that runs nothing is refused in its own sentence, never swapped for another binary', async () => {
    const { subject } = locator({ kind: 'override_unusable', variable: 'FY_CLOUDFLARED', path: '/opt/nope' });

    expect(await subject.locate()).toEqual({
      kind: 'absent',
      reason: 'FY_CLOUDFLARED names /opt/nope, which is not an executable file',
    });
  });

  test('says cloudflared is not on the daemon PATH when the search finds nothing', async () => {
    const { subject } = locator({ kind: 'absent' });

    expect(await subject.locate()).toEqual({ kind: 'absent', reason: 'cloudflared is not on this daemon’s PATH' });
  });
});
