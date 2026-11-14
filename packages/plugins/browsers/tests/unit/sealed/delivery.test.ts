import { afterEach, describe, it } from 'bun:test';
import { FakeGate, ferretStanding, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import type { AgentControlReader, FerretId } from '@ferretry/kernel/contract';
import { implementDaemon, type Needer } from '@ferretry/kernel/manifest';
import { ferret, type TestHost, testHost } from '@ferretry/kernel/testing';
import should from 'should';
import { BrowsersPort, type BrowsersCopyApi } from '../../../contract/port.ts';
import type { BrowserScreencastFrame } from '../../../contract/wire/browser.ts';
import daemon, { buildBrowsers } from '../../../daemon/index.ts';
import { SealedGate } from '../../../daemon/sealed/gate.ts';
import { SealedPages } from '../../../daemon/sealed/page-guards.ts';
import type { FrameClock, FrameTimer } from '../../../daemon/stream/contracts.ts';
import { sealedDelivery } from '../../../daemon/stream/delivery.ts';
import { heldViewerHost } from '../../../daemon/stream/held-host.ts';
import {
  type BrowserViewerHost,
  type ViewerDownstream,
  type ViewerStreamOptions,
  type ViewerTerminalSignal,
} from '../../../daemon/stream/viewer-contracts.ts';
import { BrowserViewerStream } from '../../../daemon/stream/viewer-stream.ts';
import { Tabs } from '../../support/tabs.ts';

/**
 * R1 (secure-clip-2 fix round 2): sealed OUTPUT is checked where the bytes LEAVE, not only before the asynchronous work that
 * made them. A seal that starts while a frame or a picture is being made stops that frame; a frame held back for a congested
 * socket is not resent once a value lives; and an agent's stream already open is ended the moment a value is sealed. A
 * person's own viewing never changes. Fake values only.
 */
const SOURCE = 'https://keys.example.test';
const LIVE = () => Date.now() + 60_000;
const shot: BrowserScreencastFrame = { dataBase64: btoa('AAAA'), width: 1, height: 1, pageId: 'p1' };

describe('R1: SealedGate.mayDeliver is the one synchronous delivery check', () => {
  const build = () => {
    const sealed = new SealedPages();
    return { sealed, gate: new SealedGate({ sealed, mask: async text => text }) };
  };

  it('should let a person’s output through whatever lives or began since', () => {
    const { sealed, gate } = build();
    const since = gate.stamp();
    sealed.hold('f1', 'token', [SOURCE], LIVE);

    should(gate.mayDeliver('person', since, { picture: true })).be.true();
  });

  it('should refuse an agent’s output when a value began to live after the output was started', () => {
    const { sealed, gate } = build();
    const since = gate.stamp();
    sealed.hold('f1', 'token', [SOURCE], LIVE);

    should(gate.mayDeliver('agent', since)).be.false();
  });

  it('should refuse an agent’s output when a value lived and ENDED after the output was started', () => {
    const { sealed, gate } = build();
    const since = gate.stamp();
    let end: number | undefined = Date.now() + 60_000;
    sealed.hold('f1', 'token', [SOURCE], () => end);
    end = undefined;

    should(sealed.anyLive()).be.false();
    should(gate.mayDeliver('agent', since)).be.false();
  });

  it('should pass an agent’s output when nothing changed, and refuse a picture while any value lives', () => {
    const { sealed, gate } = build();
    const idle = gate.stamp();
    should(gate.mayDeliver('agent', idle, { picture: true })).be.true();

    sealed.hold('f1', 'token', [SOURCE], LIVE);
    const live = gate.stamp();
    // A checked read may pass while a value lives and nothing new began; a stream's picture may not.
    should(gate.mayDeliver('agent', live)).be.true();
    should(gate.mayDeliver('agent', live, { picture: true })).be.false();
  });
});

describe('R1: the viewer socket’s frame is checked again where it is sent', () => {
  function world() {
    const sealed = new SealedPages();
    const gate = new SealedGate({ sealed, mask: async text => text });
    let deliver: ((frame: BrowserScreencastFrame) => void) | undefined;
    const host = {
      attachViewer: async (_session: string, onFrame: (frame: BrowserScreencastFrame) => void) => {
        deliver = onFrame;
        return { detach: () => undefined };
      },
    };
    const release: (() => void)[] = [];
    const kernel = {
      act: async () => {
        await new Promise<void>(resolve => release.push(resolve));
        return { ok: true as const, value: { kind: 'content' as const } };
      },
    };
    const viewer = heldViewerHost(kernel as never, host as never, { mayType: false, delivery: sealedDelivery(gate) });
    const frames: unknown[] = [];
    const ended: ViewerTerminalSignal[] = [];
    return {
      sealed,
      frames,
      ended,
      release,
      async attach() {
        await viewer.attachViewer(
          'f1',
          each => frames.push(each),
          signal => ended.push(signal),
        );
      },
      send: () => deliver?.(shot),
    };
  }

  it('should NOT deliver a frame whose act was still awaited when a value began to live', async () => {
    const w = world();
    await w.attach();
    w.send();
    // The act is awaiting; the value is sealed now.
    w.sealed.hold('f1', 'token', [SOURCE], LIVE);
    for (const resolve of w.release) resolve();
    await new Promise(resolve => setTimeout(resolve, 5));

    should(w.frames).eql([]);
  });

  it('should end an agent stream that is already open the moment a value is sealed, with no new frame needed', async () => {
    const w = world();
    await w.attach();

    w.sealed.hold('f1', 'token', [SOURCE], LIVE);

    should(w.ended).have.length(1);
    should(w.ended[0]?.code).equal(1008);
    should(w.ended[0]?.reason).containEql('picture of a page cannot be masked');
  });
});

describe('R1: a frame held back for a congested socket is not resent once a value lives', () => {
  class Clock implements FrameClock {
    due: (() => void) | undefined;
    now = () => 0;
    schedule(callback: () => void): FrameTimer {
      this.due = callback;
      return { cancel: () => (this.due = undefined) };
    }
  }
  class Down implements ViewerDownstream {
    sent: Uint8Array[] = [];
    closes: { code: number; reason: string }[] = [];
    buffered = 1;
    send(envelope: Uint8Array): void {
      this.sent.push(envelope);
    }
    close(code: number, reason: string): void {
      this.closes.push({ code, reason });
    }
    bufferedBytes = () => this.buffered;
  }

  async function connect(guard: ViewerStreamOptions['delivery']) {
    let onFrame: ((frame: BrowserScreencastFrame) => void) | undefined;
    const host: BrowserViewerHost = {
      attachViewer: async (_s, frame) => {
        onFrame = frame;
        return { detach: () => undefined };
      },
      dispatchHumanInput: async () => undefined,
    };
    const down = new Down();
    const clock = new Clock();
    const stream = await BrowserViewerStream.connect(host, 'f1', down, clock, { delivery: guard });
    return { down, clock, stream, frame: () => onFrame?.(shot) };
  }

  it('should send nothing on the recovery retry when the delivery check now says no, and end the stream with a sentence', async () => {
    let allowed = true;
    const { down, clock, stream, frame } = await connect({
      stamp: () => 0,
      mayDeliver: () => allowed,
      refusal: 'closed: sealed',
    });
    frame();
    should(down.sent).eql([]);
    should(clock.due).not.equal(undefined);

    allowed = false;
    down.buffered = 0;
    clock.due?.();

    should(down.sent).eql([]);
    should(down.closes).eql([{ code: 1008, reason: 'closed: sealed' }]);
    should(stream.finished).be.true();
  });

  it('should send the retained frame when the delivery check still says yes', async () => {
    const { down, clock, frame } = await connect({ stamp: () => 0, mayDeliver: () => true, refusal: 'closed' });
    frame();
    down.buffered = 0;
    clock.due?.();

    should(down.sent.length).be.above(0);
  });

  it('should not send a NEW frame either when the delivery check says no', async () => {
    const { down, stream, frame } = await connect({ stamp: () => 0, mayDeliver: () => false, refusal: 'closed' });
    down.buffered = 0;
    frame();

    should(down.sent).eql([]);
    should(stream.finished).be.true();
  });
});

describe('R1: the HTTP picture and read leave only if no value began to live meanwhile', () => {
  const FERRETS = { get: async (id: string) => (id === 'f1' ? { name: id } : undefined) };
  const ALL_ON: AgentControlReader = { allows: async () => true };
  const calling = 'f1' as FerretId;
  const needer = (id: string): Needer => ({
    id,
    permissions: { network: [], spawn: [], secrets: [] } as unknown as Needer['permissions'],
    ownedSecretReferences: () => new Set(),
  });
  let held: TestHost | undefined;
  afterEach(async () => {
    await held?.stop();
    held = undefined;
  });

  async function built(): Promise<{ host: TestHost; tabs: Tabs; copy: BrowsersCopyApi }> {
    const tabs = new Tabs();
    const half = implementDaemon(daemon.manifest, {
      build: ctx => buildBrowsers(ctx, { launcher: { launch: async () => tabs.automation } }),
    });
    const gate = new StandInAdmission(request =>
      request.arrival.kind === 'local' && request.arrival.privileged ? ferretStanding(calling) : ownerStanding(),
    );
    const host = await testHost({
      plugins: [half],
      uses: { ferrets: FERRETS, agentControl: ALL_ON },
      fakes: { vault: new FakeVault(), gate: new FakeGate() },
      gate,
    });
    held = host;
    const copy = host.provided(BrowsersPort, needer('accounts')).copy;
    if (copy === undefined) throw new Error('Accounts should be handed the copy reach');
    return { host, tabs, copy };
  }

  const ACT = '/v1/ferrets/f1/browser';
  const asAgent = { as: ferret('f1') };

  async function ready() {
    const world = await built();
    await world.host.tool('browser_open', { name: 'dash', url: 'https://dash.example.test/' }, asAgent);
    await world.host.request('POST', ACT, { body: { action: 'activate-page', pageId: 'p1' }, ...asAgent });
    world.tabs.documentHost = 'dash.example.test';
    world.tabs.pageText = 'Documentation';
    return world;
  }

  it('should refuse an agent’s screenshot when a value began to live while the picture was being taken', async () => {
    const { host, tabs, copy } = await ready();
    tabs.automation.screenshot = async pageId => {
      // The value is sealed while the browser is taking the picture.
      copy.sealed.hold('f1' as FerretId, 'token', [SOURCE], LIVE);
      tabs.calls.push(`screenshot:${pageId}`);
      return {
        url: 'https://dash.example.test/',
        title: '',
        pages: [],
        actedPageId: pageId,
        screenshotBase64: 'iVBOR',
      } as never;
    };

    const agent = await host.request('POST', ACT, { body: { action: 'screenshot' }, ...asAgent });

    should(agent.status).equal(403);
    should(agent.body).not.containEql('iVBOR');
  });

  it('should let a person have the same picture', async () => {
    const { host, tabs, copy } = await ready();
    tabs.automation.screenshot = async pageId => {
      copy.sealed.hold('f1' as FerretId, 'token', [SOURCE], LIVE);
      return {
        url: 'https://dash.example.test/',
        title: '',
        pages: [],
        actedPageId: pageId,
        screenshotBase64: 'iVBOR',
      } as never;
    };

    const person = await host.request('POST', ACT, { body: { action: 'screenshot' } });

    should(person.status).equal(200);
  });

  it('should refuse an agent’s read when a value began to live while the page was being read', async () => {
    const { host, tabs, copy } = await ready();
    tabs.automation.read = async pageId =>
      (copy.sealed.hold('f1' as FerretId, 'token', [SOURCE], LIVE),
      {
        url: 'https://dash.example.test/',
        title: '',
        pages: [],
        actedPageId: pageId,
        text: 'hello',
      }) as never;

    const agent = await host.request('POST', ACT, { body: { action: 'read' }, ...asAgent });

    should(agent.status).equal(403);
  });

  it('should still answer an agent when nothing changed', async () => {
    const { host } = await ready();

    const agent = await host.request('POST', ACT, { body: { action: 'screenshot' }, ...asAgent });

    should(agent.status).equal(200);
  });
});
