import { describe, expect, test } from 'bun:test';
import type { PluginClient, VerbInvocation } from '@ferretry/kernel/manifest';
import qrcode from 'qrcode-generator';
import { BlockQrEncoder } from '../../../cli/adapters/qr.ts';
import cli from '../../../cli/index.ts';
import manifest from '../../../manifest.ts';
import { CATALOG_ID, catalog, catalogList } from './catalog/fixtures.ts';
import { mintResponse } from './catalog-share/fixtures.ts';

interface Sent {
  readonly route: string;
  readonly init?: unknown;
}

function harness(
  answers: Record<string, unknown> = {},
  extras: { prompt?: (question: string) => Promise<string | undefined>; isTty?: boolean } = {},
) {
  const sent: Sent[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const client: PluginClient = {
    call: async (route, init) => {
      sent.push({ route, ...(init === undefined ? {} : { init }) });
      const answer = answers[route];
      if (answer instanceof Error) throw answer;
      return answer as never;
    },
    subscribe: () => () => {},
  };
  const build = cli.build;
  if (build === undefined) throw new Error('the catalogs cli half has no build');
  const verbs = build({
    manifest,
    client,
    io: { out: (t: string) => out.push(t), err: (t: string) => err.push(t), isTty: extras.isTty ?? false },
    ...(extras.prompt === undefined ? {} : { prompt: extras.prompt }),
  } as never).verbs as Record<string, (i: VerbInvocation) => Promise<number>>;
  const run = (verb: string, args: string[] = [], options: VerbInvocation['options'] = {}) =>
    (verbs[verb] as (i: VerbInvocation) => Promise<number>)({ args, options });
  return { sent, out, err, run, verbs };
}

describe('fy catalog / fy member', () => {
  test('every verb the manifest declares has a handler', () => {
    expect(Object.keys(harness().verbs).toSorted()).toEqual(manifest.actions.cli.map(verb => verb.verb).toSorted());
  });

  test('a verb missing its positionals answers 2 with its usage, and sends nothing', async () => {
    const { run, err, sent } = harness();
    expect(await run('catalog rename', ['only-one'])).toBe(2);
    expect(err[0]).toContain('usage: fy catalog rename <catalog> <name>');
    expect(sent).toEqual([]);
  });

  test('ls asks for the source check and prints the list', async () => {
    const { run, sent, out } = harness({ 'GET /v1/catalogs': catalogList() });
    expect(await run('catalog ls')).toBe(0);
    expect(sent[0]).toEqual({ route: 'GET /v1/catalogs', init: { query: { sourceState: '1' } } });
    expect(out.join('\n')).toContain(catalog().name);
  });

  test('-y is --yes: a delete goes ahead off a terminal', async () => {
    const { run, sent } = harness({
      'GET /v1/catalogs': catalogList(),
      'DELETE /v1/catalogs/:id': { catalogId: CATALOG_ID },
    });
    expect(await run('catalog rm', [CATALOG_ID], { y: true })).toBe(0);
    expect(sent.map(call => call.route)).toEqual(['GET /v1/catalogs', 'DELETE /v1/catalogs/:id']);
  });

  test('with no one to ask, a change needs --yes and is not sent', async () => {
    const { run, sent, err } = harness({ 'GET /v1/catalogs': catalogList() });
    expect(await run('catalog rm', [CATALOG_ID])).toBe(1);
    expect(err[0]).toContain('pass --yes');
    expect(sent.map(call => call.route)).toEqual(['GET /v1/catalogs']);
  });

  test('a person at a terminal answers the question through the shell prompt', async () => {
    const asked: string[] = [];
    const { run, sent } = harness(
      { 'GET /v1/catalogs': catalogList(), 'DELETE /v1/catalogs/:id': { catalogId: CATALOG_ID } },
      {
        isTty: true,
        prompt: async question => {
          asked.push(question);
          return 'y';
        },
      },
    );
    expect(await run('catalog rm', [CATALOG_ID])).toBe(0);
    expect(asked[0]).toContain('[y/N]');
    expect(sent.at(-1)?.route).toBe('DELETE /v1/catalogs/:id');
  });

  test('export refuses before anything is signed while the shell hands this half no file writer', async () => {
    const { run, sent, err } = harness({ 'GET /v1/catalogs': catalogList() });
    expect(await run('catalog export', [CATALOG_ID], { yes: true })).toBe(1);
    expect(err[0]).toContain('cannot write a file');
    expect(sent.some(call => call.route === 'POST /v1/catalogs/:id/export')).toBe(false);
  });

  test('install refuses before any preview while the shell hands this half no file reader', async () => {
    const { run, sent, err } = harness();
    expect(
      await run('catalog install', ['team.catalog.json'], { runtime: 'main', profile: 'default', yes: true }),
    ).toBe(1);
    expect(err.join('\n')).toContain('cannot read a file');
    expect(sent).toEqual([]);
  });

  test("a daemon refusal is the shell's to say: it goes back with its own exit code", async () => {
    const refusal = Object.assign(new Error('the daemon said no'), { status: 403, code: 'forbidden', exitCode: 1 });
    const { run } = harness({ 'GET /v1/catalog-shares': refusal });
    await expect(run('catalog shares')).rejects.toBe(refusal);
  });

  test('share prints the one-time link with a QR drawn here', async () => {
    const minted = mintResponse();
    const { run, sent, out } = harness({
      'GET /v1/catalogs': catalogList(),
      'POST /v1/catalog-shares': minted,
    });
    expect(await run('catalog share', [CATALOG_ID], { member: 'Sam', expires: '1h' })).toBe(0);
    expect(sent.at(-1)).toMatchObject({ route: 'POST /v1/catalog-shares', init: { body: { expiresIn: '1h' } } });
    const screen = out.join('\n');
    expect(screen).toContain(minted.link);
    expect(screen).toMatch(/[█▀▄]/u);
  });
});

describe('BlockQrEncoder', () => {
  test('draws the QR the library computes, a square with a quiet zone, in both sizes', async () => {
    const link = 'https://app.ferretry.test/join#v1;url=x;fp=y;share=z';
    const code = qrcode(0, 'L');
    code.addData(link);
    code.make();
    const modules = code.getModuleCount() + 2;
    const large = (await new BlockQrEncoder().encode(link, 'large')).split('\n');
    const compact = (await new BlockQrEncoder().encode(link, 'compact')).split('\n');
    expect(large).toHaveLength(modules);
    for (const line of large) expect(Array.from(line)).toHaveLength(modules * 2);
    expect(compact).toHaveLength(Math.ceil(modules / 2));
    for (const line of compact) expect(Array.from(line)).toHaveLength(modules);
    expect(large[0]).toBe('█'.repeat(modules * 2));
  });
});
