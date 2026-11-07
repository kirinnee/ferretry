import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeFerrets } from '@ferretry/core-ferrets/contract/testing';
import { fakeConversation } from '@ferretry/plugin-conversation/contract/testing';
import { fixedClock, testHost } from '@ferretry/kernel/testing';
import daemon from '../../daemon/index.ts';

/** The real daemon half over the contract fakes of what it needs, on the kernel's test host. */
export async function wardenHost(options: { readonly config?: unknown } = {}) {
  const ferrets = new FakeFerrets();
  const asks = new FakeAsks();
  const conversation = fakeConversation();
  const clock = fixedClock('2026-11-07T12:00:00.000Z');
  const host = await testHost({ plugins: [daemon], fakes: { ferrets, asks, conversation }, clock });
  if (options.config !== undefined) host.setConfig('warden.yaml', options.config);
  return { host, ferrets, asks, conversation, clock };
}
