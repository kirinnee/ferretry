/**
 * The browser entry for "which agent an Add skills install is for": the REAL `AddSkillsPage` over a scripted
 * subscription, for a ferret whose address names no harness (or one a catalog cannot install into).
 *
 *   ?style=<style>&palette=<palette>&mode=light|dark
 *   ?case=claude-only | both | unknown
 *
 * The case names what the machine runs. `window.__open()` presses Install on the first skill and then "Install on
 * machine", which shows the agent picker; the driver reads and opens it.
 */
import { createRoot } from 'react-dom/client';
import { AddSkillsPage } from '../../../../app/features/add-skills/add-skills-page.tsx';
import type { RuntimeChoice } from '../../../../app/features/add-skills/add-skills-model.ts';
import { readPlace } from '../../../../app/lib/add-skills-address.ts';
import { daemonConnection } from '../../../../app/lib/machine.ts';
import { fakeClient } from '../../../unit/app/support/catalog-client.ts';
import { testSubscription } from '../../../unit/app/support/member-keys.ts';
import { fakeMembers, okAttempt, sharedItemFixture } from '../../../unit/app/support/shared-screens.ts';

const params = new URLSearchParams(window.location.search);
const html = document.documentElement;
html.dataset.style = params.get('style') ?? 'studio';
html.dataset.palette = params.get('palette') ?? 'studio';
html.dataset.mode = params.get('mode') ?? 'light';
html.dataset.theme = `${html.dataset.palette}-${html.dataset.mode}`;

const CASE = params.get('case') ?? 'claude-only';
const claude: RuntimeChoice = { id: 'box', wrapper: 'box', profile: 'default', harness: 'claude-code' };
const codex: RuntimeChoice = { id: 'cx', wrapper: 'cx', profile: 'default', harness: 'codex' };
const runtimes: readonly RuntimeChoice[] = CASE === 'both' ? [claude, codex] : [claude];
const place = readPlace(CASE === 'unknown' ? '?folder=/work/app&harness=fake-third' : '?folder=/work/app');

const shared = await sharedItemFixture();
const studio = await testSubscription(shared.identity.daemonId, { ownLabel: 'Studio' });
const fake = fakeClient({ 'GET /v1/catalog-installs': () => ({ installs: [] }) });
const members = fakeMembers({
  list: async () => [studio],
  browse: async () => okAttempt(shared.browse),
  openItem: async () => okAttempt({ item: shared.skill, opened: shared.opened, entry: shared.entries[0]! }),
});

const press = (selector: string): void => {
  const target = document.querySelector<HTMLElement>(selector);
  if (target === null) throw new Error(`❌ nothing at ${selector}`);
  target.click();
};
(window as unknown as { __open: () => void }).__open = () => press('[data-add-skills-install]');
(window as unknown as { __next: () => void }).__next = () => press('[data-shared-install-button]');

const root = document.getElementById('root');
if (root === null) throw new Error('❌ the add-skills scene has no #root');
createRoot(root).render(
  <AddSkillsPage
    connection={daemonConnection({ daemonId: 'alpha' })}
    machineName="Studio laptop"
    ferret="f1"
    place={place}
    members={members.members}
    onBack={() => undefined}
    onSubscribe={() => undefined}
    install={{
      createClient: fake.factory as never,
      projects: [{ name: 'app', path: '/work/app' }],
      runtimes: runtimes.map(choice => ({ runtime: choice.id, profiles: [choice.profile], harness: choice.harness })),
    }}
    runtimes={runtimes}
  />,
);
