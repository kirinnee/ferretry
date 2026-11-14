import { afterEach, describe, it } from 'bun:test';
import { homedir } from 'node:os';
import should from 'should';
import { FakeAsks, entryId, sourceKey } from '@ferretry/core-asks/contract/testing';
import { FakeFerrets, ferretId, T0 } from '@ferretry/core-ferrets/contract/testing';
import { fakeConversation } from '@ferretry/plugin-conversation/contract/testing';
import { createWardenSubsystem } from '../../daemon/subsystem.ts';
import { fakeKernel, wardenConfig } from '../support/kernel.ts';

const HOUR = 60 * 60 * 1000;

/** The owner turned investigations on and named one login: the only thing a spawn needs besides a flag. */
const investigating = {
  enabled: true,
  layers: { jev: false, llm: true },
  minSpawnGapMinutes: 0,
  accounts: [{ agent: 'acct' }],
  caps: { investigationUsdPerDay: 50 },
};

function world() {
  const fake = fakeKernel({ config: wardenConfig(investigating), start: '2026-11-07T12:00:00.000Z' });
  const ferrets = new FakeFerrets();
  const asks = new FakeAsks();
  const subsystem = createWardenSubsystem({
    kernel: fake.kernel,
    ferrets,
    conversation: fakeConversation(),
    asks,
    usage: () => undefined,
    board: () => undefined,
  });
  return { ...fake, ferrets, asks, subsystem };
}

/** A helper that asked a question nobody answered: a flag the Warden investigates. */
async function flagged(w: ReturnType<typeof world>): Promise<void> {
  w.ferrets.add({ id: ferretId('f1'), parent: ferretId('lead'), mode: 'auto', state: 'idle', stateAt: T0 });
  await w.asks.raise({
    source: sourceKey('ferret'),
    entry: entryId('f1-q'),
    ref: {},
    kind: 'yesno',
    subject: 'Ship it?',
    why: 'it needs a decision',
    raisedBy: { kind: 'ferret', ferret: 'f1' },
    ferret: 'f1',
  });
  await w.clock.advance(3 * HOUR);
}

describe('a warden investigator over the Ferrets port', () => {
  const worlds: ReturnType<typeof world>[] = [];
  afterEach(async () => {
    for (const w of worlds.splice(0)) await w.scratch.closeAll();
  });

  it('should start one in its own folder outside the home, as the Warden, through Ferrets', async () => {
    // Arrange
    const w = world();
    worlds.push(w);
    await flagged(w);

    // Act
    await w.subsystem.run(true);

    // Assert
    const starts = w.ferrets.starts.filter(start => start.by === 'warden');
    should(starts.length).equal(1);
    const [start] = starts;
    should(start?.runtime).equal('acct');
    should(start?.name).match(/^warden-[0-9a-f]{6}$/u);
    should(start?.options?.label).equal('fleet-warden');
    should(start?.options?.mode).equal('auto');
    // Its folder is the warden's own scratch folder: neither the owner's home nor anything the daemon keeps.
    should(start?.workFolder?.startsWith(`${w.scratch.opened[0]}/`)).equal(true);
    should(start?.workFolder?.startsWith(homedir())).equal(false);
    should(start?.workFolder).equal(start?.folder);
  });

  it('should tell it to hand its report back with signal done, not to write a file it cannot reach', async () => {
    // Arrange
    const w = world();
    worlds.push(w);
    await flagged(w);

    // Act
    await w.subsystem.run(true);

    // Assert
    const prompt = w.ferrets.starts.find(start => start.by === 'warden')?.prompt ?? '';
    should(prompt).containEql('signal done');
    should(prompt).not.containEql('Write your report to EXACTLY');
  });

  it("should read the report back from the investigator's summary once it has finished", async () => {
    // Arrange
    const w = world();
    worlds.push(w);
    await flagged(w);
    await w.subsystem.run(true);
    const investigator =
      w.ferrets.starts.length > 0 ? (await w.ferrets.list()).find(f => f.label === 'fleet-warden') : undefined;
    should(investigator).not.be.undefined();
    const report =
      'Verdict: LEAVE\n\n# Warden report — f1\n\n- **Recommended action:** LEAVE — it was only waiting on a person\n';
    w.ferrets.setSummary(investigator!.id, report);
    w.ferrets.setState(investigator!.id, 'stopped');
    await w.clock.advance(HOUR);

    // Act
    await w.subsystem.run(false);
    const verdicts = await w.subsystem.verdicts();

    // Assert
    should(verdicts.length).be.above(0);
    should(verdicts[0]?.verdict).equal('cleared');
  });
});
