/**
 * Parity rows T-0039 … T-0042 (docs/design/rebuild-parity.tsv): today's four secure-copy agent tools. Each is declared by
 * the manifest AND answered by the daemon half, through the test host, as the ferret that calls it. What each one does
 * (the sealed value, the paste, the takeover, the sentinel's absence) is `daemon/secure-copy/composition.test.ts`.
 * `task_plan` (T-0043) is not built and has no test here.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { FakeAsks } from '@ferretry/core-asks/contract/testing';
import { FakeGate, ferretStanding, ownerStanding, StandInAdmission } from '@ferretry/core-gate/contract/testing';
import { FakeSealedDocuments, FakeVault } from '@ferretry/core-vault/contract/testing';
import type { FerretId } from '@ferretry/kernel/contract';
import { ferret, type TestHost, testHost } from '@ferretry/kernel/testing';
import accounts from '../../../daemon/index.ts';
import manifest from '../../../manifest.ts';

async function built(): Promise<TestHost> {
  return await testHost({
    plugins: [accounts],
    gate: new StandInAdmission(request =>
      request.arrival.kind === 'local' && request.arrival.privileged
        ? ferretStanding('F1' as FerretId)
        : ownerStanding(),
    ),
    uses: { agentControl: { allows: async () => true }, ferrets: { workFolder: async () => ({ folder: '/work/f1' }) } },
    fakes: { gate: new FakeGate(), vault: new FakeVault(), asks: new FakeAsks(), sealed: new FakeSealedDocuments() },
  });
}

describe("today's secure-copy agent tools", () => {
  let host: TestHost | undefined;
  afterEach(async () => {
    await host?.stop();
    host = undefined;
  });

  /** Declared once, and answered by the half: a call with nothing in it gets the tool's own words, never the skeleton's. */
  async function proves(name: string, answersAsError: boolean): Promise<void> {
    // Arrange
    host = await built();

    // Act
    const answer = await host.tool(name, {}, { as: ferret('F1') });

    // Assert
    expect(manifest.actions.agentTools.filter(tool => tool.name === name)).toHaveLength(1);
    expect(answer.text).not.toContain('is not built yet');
    expect(answer.isError === true).toBe(answersAsError);
  }

  test('T-0039 secure_copy (secure.copy) is declared and answered by the daemon half', async () => {
    await proves('secure_copy', true);
  });

  test('T-0040 secure_discard (secure.discard) is declared and answered by the daemon half', async () => {
    await proves('secure_discard', true);
  });

  test('T-0041 secure_list (secure.list) is declared and answered by the daemon half', async () => {
    await proves('secure_list', false);
  });

  test('T-0042 secure_paste (secure.paste) is declared and answered by the daemon half', async () => {
    await proves('secure_paste', true);
  });
});
