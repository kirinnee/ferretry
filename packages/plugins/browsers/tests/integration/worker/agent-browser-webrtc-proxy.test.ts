import { afterAll, beforeAll, describe, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import should from 'should';
import { BrowserSessionService } from '../../../daemon/pages/service.ts';
import { NodeSessionBrowserLauncher } from '../../../daemon/worker/launcher.ts';
import { BrowserProfileStore } from '../../../daemon/worker/control/adapters/profile-store.ts';
import { chromeProxyArguments } from '../../../daemon/worker/control/policy.ts';
import { launcherPorts, REAL_WORKER } from '../../support/process-workers.ts';
import { unprovenListenerProver } from '../../support/listener-prover.ts';
import { waitFor } from '../../support/wait-for.ts';

/**
 * WEBRTC MUST NOT REACH AROUND THE BROWSER PROXY, AGAINST A REAL CHROME (B5 D5 follow-up).
 *
 * A page can open a UDP socket to any STUN server through `RTCPeerConnection`, and Chrome's default policy
 * sends that UDP straight out of the machine — past `--proxy-server` — so the server learns the machine's real
 * address. The check is made with a STUN server this test runs itself on a non-loopback address of this host:
 * every binding request it receives is UDP that did NOT go through the proxy (a CONNECT proxy cannot carry it).
 * The control launches Chrome with the proxy switches but WITHOUT `disable_non_proxied_udp` and must be seen
 * to leak, so a clean result from the product launch is a measurement and not a blind spot.
 */

const chrome = Bun.which('google-chrome') ?? Bun.which('chromium');
const SPOOFED_MAPPED_ADDRESS = [203, 0, 113, 7] as const;

const lanAddress = (): string | undefined =>
  Object.values(networkInterfaces())
    .flat()
    .find(entry => entry !== undefined && entry.family === 'IPv4' && !entry.internal)?.address;

/** A STUN server that answers every binding request, and remembers where each one came from. */
async function stunServer(host: string) {
  const sources: string[] = [];
  const socket = await Bun.udpSocket({
    hostname: '0.0.0.0',
    socket: {
      data: (udp, data, port, address) => {
        // A binding request: type 0x0001, magic cookie 0x2112A442 at byte 4.
        if (data.length < 20 || data[0] !== 0x00 || data[1] !== 0x01) return;
        sources.push(`${address}:${String(port)}`);
        const response = Buffer.alloc(32);
        response.writeUInt16BE(0x0101, 0);
        response.writeUInt16BE(12, 2);
        data.copy(response, 4, 4, 20); // cookie + transaction id
        response.writeUInt16BE(0x0020, 20); // XOR-MAPPED-ADDRESS
        response.writeUInt16BE(8, 22);
        response.writeUInt8(1, 25); // IPv4
        response.writeUInt16BE(port ^ 0x2112, 26);
        // The address is XORed with the magic cookie, which is already bytes 4..7 of the request.
        for (const [index, octet] of SPOOFED_MAPPED_ADDRESS.entries())
          response.writeUInt8(octet ^ (data[4 + index] ?? 0), 28 + index);
        udp.send(response, port, address);
      },
    },
  });
  return { url: `stun:${host}:${String(socket.port)}`, sources, stop: () => socket.close() };
}

/** A loopback HTTP proxy that only counts the CONNECT tunnels asked of it (the page itself is loopback and bypasses it). */
async function connectProxy() {
  const tunnels: string[] = [];
  const server: Server = createServer(client => {
    client.once('data', head => {
      tunnels.push(head.toString('latin1').split('\r\n')[0] ?? '');
      client.destroy();
    });
    client.on('error', () => undefined);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return { url: `http://127.0.0.1:${String(port)}`, tunnels, stop: () => server.close() };
}

/** What the page sees of its own ICE gathering, written into `#out` as JSON once gathering completes. */
const page = (stun: string): string =>
  `<html><head><title>ice</title></head><body><p id="out"></p><script>
const out = document.getElementById('out');
const found = [];
const pc = new RTCPeerConnection({ iceServers: [{ urls: ${JSON.stringify(stun)} }] });
pc.createDataChannel('probe');
pc.onicecandidate = event => { if (event.candidate) found.push(event.candidate.candidate); };
pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') out.textContent = JSON.stringify(found); };
pc.createOffer().then(offer => pc.setLocalDescription(offer));
</script></body></html>`;

const candidateTypes = (json: string): readonly string[] =>
  (JSON.parse(json) as string[]).map(line => / typ (\w+)/u.exec(line)?.[1] ?? '?');

let root = '';
let site: ReturnType<typeof Bun.serve>;
let stun: Awaited<ReturnType<typeof stunServer>>;
let proxy: Awaited<ReturnType<typeof connectProxy>>;
let browser: BrowserSessionService | undefined;

const lan = lanAddress();

describe.if(process.platform === 'linux' && lan !== undefined)('WebRTC under a browser proxy, in a real Chrome', () => {
  beforeAll(async () => {
    if (chrome === null) throw new Error('this test needs a real Chrome on PATH (the dev shell has it)');
    root = await mkdtemp(join(tmpdir(), 'ferretry-webrtc-proxy-'));
    stun = await stunServer(lan ?? '127.0.0.1');
    proxy = await connectProxy();
    site = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => new Response(page(stun.url), { headers: { 'content-type': 'text/html' } }),
    });
  }, 60_000);

  afterAll(async () => {
    await browser?.closeAll();
    site?.stop(true);
    stun?.stop();
    proxy?.stop();
    if (root !== '') await rm(root, { recursive: true, force: true });
  });

  it('control: a Chrome given the proxy switches but not the WebRTC policy sends STUN around the proxy', async () => {
    // Arrange: exactly the product's proxy switches, minus the policy under test.
    const args = chromeProxyArguments(proxy.url, []).filter(arg => !arg.includes('webrtc-ip-handling-policy'));
    const control = await chromium.launch({ executablePath: chrome ?? '', headless: true, args: [...args] });
    try {
      // Act
      const tab = await control.newPage();
      await tab.goto(`http://127.0.0.1:${String(site.port)}/`);
      await tab.waitForFunction(() => (document.getElementById('out')?.textContent ?? '') !== '', undefined, {
        timeout: 20_000,
      });
      const types = candidateTypes((await tab.textContent('#out')) ?? '[]');

      // Assert: the leak is real and visible both ways — the server was reached, and a reflexive candidate came back.
      should(stun.sources.length).be.above(0);
      should(types).containEql('srflx');
    } finally {
      await control.close();
    }
  }, 60_000);

  it('should send no STUN and gather no reflexive candidate when the product launches Chrome behind a proxy', async () => {
    // Arrange: the product's launcher, the product's proxy resolution, the same STUN server and page.
    stun.sources.length = 0;
    browser = new BrowserSessionService(
      { get: async id => (id === 's1' ? {} : undefined) },
      new NodeSessionBrowserLauncher(
        new BrowserProfileStore(root),
        REAL_WORKER().start,
        launcherPorts(),
        { FY_CHROME_BIN: chrome ?? '', PATH: process.env.PATH, HOME: process.env.HOME },
        undefined,
        {
          mode: async () => 'headless',
          platform: 'linux',
          transport: async () => 'port',
          listenerProver: unprovenListenerProver(),
          proxy: async () => ({ setting: { url: proxy.url, bypass: [] } }),
        },
      ),
      () => Date.now(),
    );
    await browser.openPage('s1', 'ice', { url: `http://127.0.0.1:${String(site.port)}/` });

    // Act
    const read = async (): Promise<string> => {
      const result = await browser?.actOnPage('s1', 'ice', { action: 'read', selector: '#out' });
      return result !== undefined && 'result' in result && 'text' in result.result ? String(result.result.text) : '';
    };
    await waitFor(async () => (await read()) !== '', 'ICE gathering to finish', { within: 20_000, every: 100 });
    const types = candidateTypes(await read());

    // Assert
    should(stun.sources).eql([]);
    should(types).not.containEql('srflx');
  }, 90_000);
});
