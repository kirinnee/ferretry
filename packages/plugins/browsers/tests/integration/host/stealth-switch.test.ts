/**
 * The ONE stealth switch through the kernel's real config writer (docs/config-files.md): off → on is a loosening, so it
 * is HELD for the owner and the tighter `off` stays in effect; on → off applies at once. The audit record is made
 * when the switch really changes, so a held `on` leaves none until it is confirmed.
 */
import { describe, it } from 'bun:test';
import should from 'should';
import type { ConfigFileDef, Log } from '@ferretry/kernel/contract';
import { config, state } from '@ferretry/kernel/host';
import { fixedClock } from '@ferretry/kernel/testing';
import type { AuditDraft } from '@ferretry/core-gate/contract';
import { AUDIT, type BrowsersConfig } from '../../../contract/index.ts';
import { auditStealthSwitch } from '../../../daemon/stealth-audit.ts';
import manifest from '../../../manifest.ts';

const DEF = manifest.data.config[0] as ConfigFileDef<BrowsersConfig>;
const HOME = '/home/fy';
const quiet: Log = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
} as unknown as Log;

async function machine() {
  const files = config.createConfigFiles({
    home: HOME,
    fs: state.createMemoryHostFs(),
    clock: fixedClock('2026-11-24T09:00:00.000Z'),
    log: quiet,
    binary: 'fy',
    defs: [{ plugin: 'browsers', def: DEF }],
    // Gate's judge never lets a plugin's own loosening into effect here: only the owner confirms one.
    judge: () => false,
  });
  await files.reload();
  const port = files.port('browsers');
  should((await port.write(DEF, undefined, '# the shared browser\nmode: headless\n')).kind).equal('written');
  const recorded: AuditDraft[] = [];
  const failures: unknown[] = [];
  auditStealthSwitch({
    read: () => port.file(DEF)?.stealth ?? 'off',
    watch: listener => port.watch(DEF, listener),
    record: async draft => void recorded.push(draft),
    failed: error => void failures.push(error),
  });
  return { files, port, recorded, failures };
}

describe('browsers stealth switch — held when it comes on, immediate when it goes off', () => {
  it('should hold off → on for the owner, keep stealth off in effect and record nothing yet', async () => {
    const { port, recorded } = await machine();

    const outcome = await port.write(DEF, undefined, { patch: { stealth: 'on' } });

    should(outcome.kind).equal('held');
    should(port.file(DEF)?.stealth).equal('off');
    should(port.fileState(DEF).state).equal('held');
    should(recorded).eql([]);
  });

  it('should put a held on into effect once the owner confirms it, and record from off to on', async () => {
    const { files, port, recorded } = await machine();
    const outcome = await port.write(DEF, undefined, { patch: { stealth: 'on' } });
    if (outcome.kind !== 'held') throw new Error('expected a held edit');

    should(await files.confirm(outcome.id)).equal(true);

    should(port.file(DEF)?.stealth).equal('on');
    should(recorded.map(draft => [draft.event, draft.detail])).eql([
      [AUDIT.stealthSwitched, { from: 'off', to: 'on' }],
    ]);
  });

  it('should apply on → off at once and record it', async () => {
    const { files, port, recorded } = await machine();
    const held = await port.write(DEF, undefined, { patch: { stealth: 'on' } });
    if (held.kind === 'held') await files.confirm(held.id);
    recorded.length = 0;

    const outcome = await port.write(DEF, undefined, { patch: { stealth: 'off' } });

    should(outcome.kind).equal('written');
    should(port.file(DEF)?.stealth).equal('off');
    should(recorded.map(draft => draft.detail)).eql([{ from: 'on', to: 'off' }]);
  });

  it('should record nothing when a save leaves the switch where it was', async () => {
    const { port, recorded } = await machine();

    await port.write(DEF, undefined, { patch: { mode: 'window' } });

    should(recorded).eql([]);
  });
});
