import { afterEach, expect, it } from 'bun:test';
import type { LiveFerretsClient } from '../../../../app/lib/client.ts';
import { useFerret } from '../../../../app/lib/ferret-read.ts';
import { interact, type Mounted, mount } from '../support/dom.ts';
import { ferretSummary } from './support.ts';

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

const Probe = ({ client, subject }: { readonly client: LiveFerretsClient; readonly subject: string | undefined }) => {
  const { read } = useFerret(client, subject);
  return (
    <p data-read>
      {read.kind === 'failed' ? `failed ${read.failure.status ?? 'no-status'}: ${read.failure.sentence}` : read.kind}
    </p>
  );
};

const answering = (answer: () => unknown): LiveFerretsClient =>
  ({
    call: async <Answer = unknown>(): Promise<Answer> => {
      const value = answer();
      if (value instanceof Error) throw value;
      if (typeof value === 'string' && value === 'throw-string') throw 'plain string refusal';
      return value as Answer;
    },
  }) as LiveFerretsClient;

const shown = async (client: LiveFerretsClient, ...subject: [string | undefined] | []): Promise<string> => {
  mounted = await mount(<Probe client={client} subject={subject.length === 0 ? 'a1' : subject[0]} />);
  await interact(async () => {
    for (let turn = 0; turn < 8; turn += 1) await new Promise(resolve => setTimeout(resolve, 0));
  });
  return mounted.container.querySelector('[data-read]')?.textContent ?? '';
};

it('a ferret the daemon answers is ready', async () => {
  expect(await shown(answering(() => ferretSummary('a1')))).toBe('ready');
});

it('a refusal with a status is a failure that keeps the status and the daemon sentence', async () => {
  const refused = Object.assign(new Error('no such ferret'), { status: 404 });
  expect(await shown(answering(() => refused))).toBe('failed 404: no such ferret');
});

it('an answer the contract cannot read is a failure in a sentence a person can use, with no status', async () => {
  expect(await shown(answering(() => ({ not: 'a ferret' })))).toBe(
    'failed no-status: the daemon answered with something this page cannot read',
  );
});

it('a refusal that is not an Error is a failure carrying its text', async () => {
  expect(await shown(answering(() => 'throw-string'))).toBe('failed no-status: plain string refusal');
});

it('a read with no subject never calls the daemon and stays loading', async () => {
  let calls = 0;
  const client = answering(() => {
    calls += 1;
    return ferretSummary('a1');
  });
  expect(await shown(client, undefined)).toBe('loading');
  expect(calls).toBe(0);
});
