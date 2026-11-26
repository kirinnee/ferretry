import { describe, expect, it } from 'bun:test';
import type { CliContext, Manifest, PluginClient, VerbInvocation } from '@ferretry/kernel/manifest';
import cli from '../../../cli/index.ts';
import manifest from '../../../manifest.ts';

/** The REAL conversation cli half, built the way the fy shell builds it, over a recording client. */
function send(options: {
  readonly stdin?: string;
  readonly isTty?: boolean;
  readonly args: readonly string[];
  readonly flags?: VerbInvocation['options'];
}) {
  const bodies: { message?: string }[] = [];
  const err: string[] = [];
  let reads = 0;
  const client = {
    call: async (route: string, init?: { body?: { message?: string } }) => {
      if (route === 'POST /v1/ferrets/:ferretId/send') {
        bodies.push(init?.body ?? {});
        return { ferret: 'f1', disposition: 'delivered', sendId: 's1' };
      }
      return {};
    },
    subscribe: () => () => undefined,
  } as unknown as PluginClient;
  const readText: NonNullable<CliContext<Manifest>['readText']> = async path => {
    reads += 1;
    if (path !== '-') throw new Error(`unexpected read of ${path}`);
    return options.stdin ?? '';
  };
  const half = cli.build?.({
    manifest,
    client,
    io: { out: () => undefined, err: (text: string) => err.push(text), isTty: options.isTty ?? false },
    readText,
  } as never);
  if (half === undefined) throw new Error('the conversation cli half is real');
  const verb = (half.verbs as Record<string, (i: VerbInvocation) => Promise<number>>)['send'];
  if (verb === undefined) throw new Error('no send verb');
  return { run: () => verb({ args: options.args, options: options.flags ?? {} }), bodies, err, reads: () => reads };
}

describe('fy send reads a piped message (D-04)', () => {
  it('sends what is piped in when no words and no --message-file are given', async () => {
    const s = send({ args: ['f1'], stdin: 'the report\nsecond line\n' });
    expect(await s.run()).toBe(0);
    expect(s.bodies[0]?.message).toBe('the report\nsecond line');
  });

  it('typed words win and stdin is never read', async () => {
    const s = send({ args: ['f1', 'typed', 'words'], stdin: 'ignored' });
    expect(await s.run()).toBe(0);
    expect(s.bodies[0]?.message).toBe('typed words');
    expect(s.reads()).toBe(0);
  });

  it('a terminal is never read: it says what to do, without mentioning attachments', async () => {
    const s = send({ args: ['f1'], stdin: 'would block', isTty: true });
    expect(await s.run()).toBe(2);
    expect(s.reads()).toBe(0);
    expect(s.err.join('')).toContain('no message: pass the text, --message-file <file>, or pipe it in');
    expect(s.err.join('')).not.toContain('attachments');
    expect(s.bodies).toEqual([]);
  });

  it('an empty pipe is the same refusal', async () => {
    const s = send({ args: ['f1'], stdin: '  \n' });
    expect(await s.run()).toBe(2);
    expect(s.err.join('')).toContain('no message');
    expect(s.bodies).toEqual([]);
  });
});
