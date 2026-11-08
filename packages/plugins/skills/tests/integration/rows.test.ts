import { describe, expect, test } from 'bun:test';
import { FakeFerrets, ferretId } from '@ferretry/core-ferrets/contract/testing';
import { testHost } from '@ferretry/kernel/testing';
import skills from '../../daemon/index.ts';

async function host() {
  const ferrets = new FakeFerrets();
  ferrets.add({ id: ferretId('f1'), folder: '/work/app' });
  return await testHost({ plugins: [skills], fakes: { ferrets } });
}

describe('the skills half as the host runs it', () => {
  test('a ferret that does not exist is 404 on its skills, and the machine inventory answers', async () => {
    const h = await host();
    expect((await h.request('GET', '/v1/ferrets/nobody/skills')).status).toBe(404);
    expect((await h.request('GET', '/v1/ferrets/nobody/skills/inventory')).status).toBe(404);
    expect((await h.request('GET', '/v1/skills')).status).toBe(200);
  });

  test('the file route needs a path and serves only a listed one', async () => {
    const h = await host();
    expect((await h.request('GET', '/v1/skills/file')).status).toBe(400);
    expect((await h.request('GET', '/v1/skills/file', { query: { path: '/etc/passwd' } })).status).toBe(404);
  });
});
