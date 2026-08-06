import { afterEach, describe, it } from 'bun:test';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import should from 'should';
import { BrowserProfileStore } from '../../../../src/adapters/browser/control/profile-store.ts';
import { NodeSessionBrowserLauncher } from '../../../../src/adapters/browser/runtime/session-browser-launcher.ts';

const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

async function fakeChrome(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ferretry-session-browser-'));
  roots.push(root);
  const file = join(root, 'chrome');
  await writeFile(
    file,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo 'Google Chrome 150.0'; exit 0; fi
port=$(printf '%s\\n' "$@" | sed -n 's/--remote-debugging-port=//p')
node -e "require('http').createServer((q,s)=>{s.writeHead(200,{'content-type':'application/json'});s.end('{}')}).listen(process.argv[1],'127.0.0.1')" "$port"
`,
  );
  await chmod(file, 0o700);
  return file;
}

describe('NodeSessionBrowserLauncher', () => {
  it('should lease a profile, wait for the private CDP endpoint, and release both worker and Chrome', async () => {
    const chrome = await fakeChrome();
    const root = await mkdtemp(join(tmpdir(), 'ferretry-session-profile-'));
    roots.push(root);
    const calls: string[] = [];
    const worker = {
      unexpectedExit: new Promise<number>(() => undefined),
      close: async () => {
        calls.push('worker-close');
      },
    };
    const launcher = new NodeSessionBrowserLauncher(
      new BrowserProfileStore(root),
      '/worker.ts',
      process.execPath,
      { FY_CHROME_BIN: chrome, DISPLAY: ':99', PATH: process.env.PATH, HOME: process.env.HOME },
      async options => {
        calls.push(`worker:${options.endpoint}`);
        return worker as never;
      },
    );
    const browser = await launcher.launch('s1', { width: 800, height: 600 });
    should(calls[0]).match(/^worker:http:\/\/127\.0\.0\.1:/);
    await browser.close();
    should(calls).containEql('worker-close');
    should(await new BrowserProfileStore(root).acquire({ sessionId: 'again' })).have.property('sessionId', 'again');
  });
});
