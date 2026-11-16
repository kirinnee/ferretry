import { describe, expect, test } from 'bun:test';
import type { FerretId } from '@ferretry/kernel/contract';
import { browsersConformance, fakeBrowsers } from '../../contract/testing/index.ts';
import { BrowserProxySettingSchema, BrowsersConfigSchema } from '../../contract/index.ts';

const ferret = 'ferret-1' as FerretId;
browsersConformance('fakeBrowsers', () => fakeBrowsers({ [ferret]: [{ id: 'p1', name: 'docs' }] }), ferret);

describe('browsers wire', () => {
  test('a proxy never carries a credential in its address, only ${secret:NAME} references', () => {
    expect(BrowserProxySettingSchema.safeParse({ url: 'http://user:pw@proxy.example.test:8080' }).success).toBe(false);
    expect(
      BrowserProxySettingSchema.safeParse({
        url: 'http://proxy.example.test:8080',
        username: '${secret:PROXY_USER}',
        password: 'hunter2',
      }).success,
    ).toBe(false);
    expect(
      BrowserProxySettingSchema.safeParse({
        url: 'socks5://proxy.example.test:1080',
        username: '${secret:PROXY_USER}',
        password: '${secret:PROXY_PASS}',
      }).success,
    ).toBe(true);
  });
  test('the browser runs headless unless the owner chose a window', () => {
    expect(BrowsersConfigSchema.parse({}).mode).toBe('headless');
  });
});
