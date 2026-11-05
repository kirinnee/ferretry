import { describe, it } from 'bun:test';
import { launchInstructions } from '@ferretry/fleet';
import type { SessionLaunchInstructions } from '@ferretry/protocol';
import should from 'should';
import { launchEnvironment } from '../../../../src/lib/fleet/launch-environment.ts';
import { outdatedSections, relaunchInstructionEnvironment } from '../../../../src/lib/session/launch/outdated.ts';
import { sessionPaneEnvironment } from '../../../../src/lib/session/lifecycle/policy.ts';
import { parseSessionId } from '../../../../src/lib/session-id.ts';

type Section = SessionLaunchInstructions['sections'][number];

const record = (sections: SessionLaunchInstructions['sections']): SessionLaunchInstructions => ({
  sections,
  mode: 'auto',
  questions: false,
});

const TOOLS: Section = { id: 'tools', chars: 10, digest: 'a' };
const SETTINGS: Section = { id: 'settings', chars: 20, digest: 'b' };
const NOTIFY: Section = { id: 'notify', chars: 30, digest: 'c' };
const base = [TOOLS, SETTINGS, NOTIFY];

describe('outdatedSections', () => {
  it('should find nothing for a session with no record', () => {
    should(outdatedSections(undefined, record(base))).deepEqual([]);
  });

  it('should find nothing when every section matches', () => {
    should(outdatedSections(record(base), record(base))).deepEqual([]);
  });

  it('should name a section whose words changed, by fingerprint', () => {
    const now = record([TOOLS, { id: 'settings', chars: 20, digest: 'z' }, NOTIFY]);
    should(outdatedSections(record(base), now)).deepEqual(['settings']);
  });

  it('should not call a section changed when only the size is compared and it matches', () => {
    const old = record([{ id: 'tools', chars: 10 }, SETTINGS, NOTIFY]);
    should(outdatedSections(old, record(base))).deepEqual([]);
    const grown = record([{ id: 'tools', chars: 11, digest: 'q' }, SETTINGS, NOTIFY]);
    should(outdatedSections(old, grown)).deepEqual(['tools']);
  });

  it('should compare sizes when the current section has no fingerprint', () => {
    const now = record([{ id: 'tools', chars: 10 }, SETTINGS, NOTIFY]);
    should(outdatedSections(record(base), now)).deepEqual([]);
  });

  it('should name a section switched on since the launch, and one switched off', () => {
    const on = record([...base, { id: 'agenda', chars: 5, digest: 'd' }]);
    should(outdatedSections(record(base), on)).deepEqual(['agenda']);
    should(outdatedSections(on, record(base))).deepEqual(['agenda']);
  });

  it('should read an old agenda section as notify, so the rename alone is not a change', () => {
    const old = record([TOOLS, SETTINGS, { id: 'attention', chars: 30, digest: 'c' }]);
    should(outdatedSections(old, record(base))).deepEqual([]);
    const changed = record([TOOLS, SETTINGS, { id: 'attention', chars: 99 }]);
    should(outdatedSections(changed, record(base))).deepEqual(['notify']);
  });

  it('should list differing sections in prompt order', () => {
    const now = record([
      { id: 'tools', chars: 1, digest: 'x' },
      SETTINGS,
      NOTIFY,
      { id: 'learning', chars: 4, digest: 'l' },
      { id: 'hypermedia', chars: 4, digest: 'h' },
    ]);
    should(outdatedSections(record(base), now)).deepEqual(['tools', 'hypermedia', 'learning']);
  });
});

describe('relaunchInstructionEnvironment', () => {
  const id = parseSessionId('00000000-0000-4000-8000-000000000154');

  it('should give an interactive ferret with no stored switch the hypermedia default a launch gives it', () => {
    const env = relaunchInstructionEnvironment(id, {}, 'interactive');
    should(env.FY_HYPERMEDIA).equal('1');
    should(launchInstructions('fy', env).sections.map(section => section.id)).containEql('hypermedia');
  });

  it('should leave a restarted interactive ferret current on the hypermedia section', () => {
    const launched = launchInstructions('fy', sessionPaneEnvironment(id, {}, 'interactive'));
    const now = launchInstructions('fy', relaunchInstructionEnvironment(id, {}, 'interactive'));
    should(outdatedSections(launched, now)).deepEqual([]);
  });

  it('should keep an explicit stored switch, and default an auto ferret to off', () => {
    should(relaunchInstructionEnvironment(id, { FY_HYPERMEDIA: '0' }, 'interactive').FY_HYPERMEDIA).equal('0');
    should(relaunchInstructionEnvironment(id, {}, 'auto').FY_HYPERMEDIA).equal('0');
  });
  describe('with the account launch environment merged as the launchers do', () => {
    const launched = (account: Record<string, string>, session: Record<string, string>) =>
      launchInstructions('fy', sessionPaneEnvironment(id, launchEnvironment(account, session), 'interactive'));
    const now = (account: Record<string, string>, session: Record<string, string>) =>
      launchInstructions('fy', relaunchInstructionEnvironment(id, launchEnvironment(account, session), 'interactive'));

    it('should stay current for an interactive ferret whose account turns hypermedia off', () => {
      const account = { FY_HYPERMEDIA: '0' };
      should(relaunchInstructionEnvironment(id, launchEnvironment(account, {}), 'interactive').FY_HYPERMEDIA).equal(
        '0',
      );
      should(outdatedSections(launched(account, {}), now(account, {}))).deepEqual([]);
    });

    it('should stay current for an interactive ferret whose account turns hypermedia on', () => {
      const account = { FY_HYPERMEDIA: '1' };
      should(relaunchInstructionEnvironment(id, launchEnvironment(account, {}), 'interactive').FY_HYPERMEDIA).equal(
        '1',
      );
      should(outdatedSections(launched(account, {}), now(account, {}))).deepEqual([]);
    });

    it('should let the session switch win over the account', () => {
      const env = relaunchInstructionEnvironment(
        id,
        launchEnvironment({ FY_HYPERMEDIA: '0' }, { FY_HYPERMEDIA: '1' }),
        'interactive',
      );
      should(env.FY_HYPERMEDIA).equal('1');
    });

    it('should call a ferret launched with the account switch off outdated when the account is ignored', () => {
      const account = { FY_HYPERMEDIA: '0' };
      should(
        outdatedSections(
          launched(account, {}),
          launchInstructions('fy', relaunchInstructionEnvironment(id, {}, 'interactive')),
        ),
      ).deepEqual(['hypermedia']);
    });
  });
});
