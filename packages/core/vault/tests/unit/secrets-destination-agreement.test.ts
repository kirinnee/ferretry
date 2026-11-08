/**
 * The Vault's `allowedDestination` and the kernel's (`kernel.secrets.send`) are two copies of ONE rule: where a secret
 * may be sent. Nothing but this table keeps them from drifting, so an edit to one copy that is not made to the other
 * fails here.
 */
import { describe, expect, test } from 'bun:test';
import { allowedDestination as kernelCopy } from '@ferretry/kernel/contract';
import { allowedDestination as vaultCopy } from '../../contract/index.ts';

const TABLE: readonly (readonly [string, readonly string[]])[] = [
  ['https://api.example.test/x', ['api.example.test']],
  ['https://API.EXAMPLE.TEST/x', ['api.example.test']],
  ['https://api.example.test:8443/x', ['api.example.test']],
  ['https://api.example.test:8443/x', ['api.example.test:8443']],
  ['https://api.example.test:443/x', ['api.example.test']],
  ['https://other.example.test/x', ['api.example.test']],
  ['https://sub.api.example.test/x', ['api.example.test']],
  ['https://u:p@api.example.test/x', ['api.example.test']],
  ['https://u@api.example.test/x', ['api.example.test']],
  ['http://api.example.test/x', ['api.example.test']],
  ['http://localhost:4000/x', ['localhost:4000']],
  ['http://127.0.0.1:4000/x', ['127.0.0.1:4000']],
  ['http://[::1]:4000/x', ['[::1]:4000']],
  ['http://localhost.example.test/x', ['localhost.example.test']],
  ['http://127.0.0.1.example.test/x', ['127.0.0.1.example.test']],
  ['http://0.0.0.0:4000/x', ['0.0.0.0:4000']],
  ['ftp://api.example.test/x', ['api.example.test']],
  ['https://api.example.test/x', []],
  ['https://api.example.test/x', ['*']],
  ['not a url', ['api.example.test']],
  ['', ['api.example.test']],
];

describe('allowedDestination: the kernel’s copy and the Vault’s agree', () => {
  for (const [url, hosts] of TABLE)
    test(`${JSON.stringify(url)} against ${JSON.stringify(hosts)}`, () => {
      expect(kernelCopy(url, hosts)).toBe(vaultCopy(url, hosts));
    });
});
