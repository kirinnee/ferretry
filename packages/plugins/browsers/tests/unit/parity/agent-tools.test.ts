/**
 * Parity rows T-0003 … T-0031 (docs/design/rebuild-parity.tsv): today's 29 browser agent tools. Each is declared by
 * the manifest AND answered by the daemon half, through the test host's admission, as the ferret that calls it.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { FakeGate, ferretStanding, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { FakeVault } from '@ferretry/core-vault/contract/testing';
import type { FerretId } from '@ferretry/kernel/contract';
import { implementDaemon } from '@ferretry/kernel/manifest';
import { ferret, type TestHost, testHost } from '@ferretry/kernel/testing';
import daemon, { buildBrowsers } from '../../../daemon/index.ts';
import manifest from '../../../manifest.ts';
import { Tabs } from '../../support/tabs.ts';

/** Today's tools, by parity row: the MCP name and the wire name the daemon answers. */
const ROWS = [
  ['T-0003', 'browser_ask_owner', 'browser.ask_owner'],
  ['T-0004', 'browser_check', 'browser.check'],
  ['T-0005', 'browser_click', 'browser.click'],
  ['T-0006', 'browser_close', 'browser.close'],
  ['T-0007', 'browser_console', 'browser.console'],
  ['T-0008', 'browser_dialog', 'browser.dialog'],
  ['T-0009', 'browser_download', 'browser.download'],
  ['T-0010', 'browser_drag', 'browser.drag'],
  ['T-0011', 'browser_emulate', 'browser.emulate'],
  ['T-0012', 'browser_eval', 'browser.eval'],
  ['T-0013', 'browser_fill_form', 'browser.fill_form'],
  ['T-0014', 'browser_highlight', 'browser.highlight'],
  ['T-0015', 'browser_hover', 'browser.hover'],
  ['T-0016', 'browser_list', 'browser.list'],
  ['T-0017', 'browser_mouse', 'browser.mouse'],
  ['T-0018', 'browser_navigate', 'browser.navigate'],
  ['T-0019', 'browser_network', 'browser.network'],
  ['T-0020', 'browser_open', 'browser.open'],
  ['T-0021', 'browser_pdf', 'browser.pdf'],
  ['T-0022', 'browser_press', 'browser.press'],
  ['T-0023', 'browser_read', 'browser.read'],
  ['T-0024', 'browser_request_input', 'browser.request_input'],
  ['T-0025', 'browser_screenshot', 'browser.screenshot'],
  ['T-0026', 'browser_scroll', 'browser.scroll'],
  ['T-0027', 'browser_select', 'browser.select'],
  ['T-0028', 'browser_tabs', 'browser.tabs'],
  ['T-0029', 'browser_type', 'browser.type'],
  ['T-0030', 'browser_upload', 'browser.upload'],
  ['T-0031', 'browser_wait_for', 'browser.wait_for'],
] as const;

const FERRETS = { get: async (id: string) => (id === 'f1' ? { name: id } : undefined) };

async function built(): Promise<TestHost> {
  const tabs = new Tabs();
  const half = implementDaemon(daemon.manifest, {
    build: ctx => buildBrowsers(ctx, { launcher: { launch: async () => tabs.automation } }),
  });
  const gate = new StandInAdmission(request =>
    request.arrival.kind === 'local' && request.arrival.privileged ? ferretStanding('f1' as FerretId) : ownerStanding(),
  );
  return await testHost({
    plugins: [half],
    // Every switch on: this test proves the half answers each tool; the switch refusals are tools/service.test.ts's.
    // Unbound, the agent-control port fails closed and refuses every tool, `browser.list` included (today's `switchOf`).
    uses: { ferrets: FERRETS, agentControl: { allows: async () => true } },
    fakes: { vault: new FakeVault(), gate: new FakeGate() },
    gate,
  });
}

describe("today's browser agent tools", () => {
  let host: TestHost | undefined;
  afterEach(async () => {
    await host?.stop();
    host = undefined;
  });

  test('the manifest declares exactly the 29 tools the parity rows name', () => {
    expect(manifest.actions.agentTools.map(tool => tool.name).sort()).toEqual(ROWS.map(([, name]) => name).sort());
  });

  for (const [id, name, wire] of ROWS) {
    test(`${id} ${name} (${wire}) is answered by the daemon half, never left to the skeleton`, async () => {
      // Arrange
      host = await built();

      // Act — a call that names no page: the half's own handler takes it. The list answers; every other tool refuses
      // the input by its own schema — thrown as the half's `invalid_request` (the MCP door turns it into the tool's
      // error text), or, for the four page-input tools, answered as that error text already.
      const answer: { text: string; isError?: boolean } | Error = await host
        .tool(name, {}, { as: ferret('f1') })
        .catch((error: unknown) => error as Error);

      // Assert — the half answered, never the kernel's "not built" sentence.
      if (answer instanceof Error) {
        expect(answer).toMatchObject({ code: 'invalid_request' });
        return;
      }
      expect(answer.text).not.toContain('is not built yet');
      expect(answer.isError === true).toBe(name !== 'browser_list');
    });
  }
});
