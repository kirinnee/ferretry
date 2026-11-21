/**
 * The browser entry for "the catalogs' choices from a list are the app's own SelectBox" (r11 S3d), over fake data:
 *
 *   ?scene=add     the REAL "Add to catalog" sheet over nine catalogs (a list long enough to carry a search field)
 *   ?scene=share   the REAL invite sheet (its "The link works for" list has five options: no scroll bar, search only on a phone)
 *   &theme=<family>-<mode>
 *
 * The machine's catalog client is faked: every request it is sent is recorded on `window.__calls` (method, path, body) and
 * answered, so the test asserts the exact request a pick leads to.
 */
import { createRoot } from 'react-dom/client';
import { AddToCatalogSheet } from '../../../../app/features/catalogs/add-to-catalog-sheet.tsx';
import { ShareSheet } from '../../../../app/features/catalogs/share-sheet.tsx';
import { daemonConnection } from '../../../../app/lib/machine.ts';
import { fakeClient } from '../../../unit/app/support/catalog-client.ts';
import { itemPreview, ownedCatalog } from '../../../unit/app/support/catalog-views.ts';
import { memberView, mintResponse, shareView, T0_MS } from '../../../unit/app/support/catalog-sharing.ts';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const scene = params.get('scene') ?? 'add';

const connection = daemonConnection({ daemonId: 'alpha' });

const NAMES = [
  'Team skills',
  'Design system',
  'Data science',
  'Security',
  'Mobile',
  'Backend',
  'Frontend',
  'Infrastructure',
  'Research',
] as const;
const LETTERS = 'abcdefghi';
const catalogs = NAMES.map((name, at) =>
  ownedCatalog({ id: `cat_${LETTERS[at]?.repeat(22)}`, name }, { itemId: `itm_${'z'.repeat(22)}` }),
);
const source = { kind: 'skill', skill: '/home/k/.claude/skills/pdf-tools/SKILL.md' } as const;

const handlers: Parameters<typeof fakeClient>[0] = {
  'GET /v1/catalogs': () => ({ catalogs }),
  'GET /v1/catalog-members': () => ({ members: [memberView()] }),
  'POST /v1/catalog-shares': () => mintResponse({ share: shareView() }),
  ...Object.fromEntries(
    catalogs.flatMap(catalog => [
      [`POST /v1/catalogs/${catalog.id}/items/preview`, () => itemPreview({ catalogId: catalog.id })],
      [
        `POST /v1/catalogs/${catalog.id}/items`,
        () => ({
          itemId: `itm_${'s'.repeat(22)}`,
          kind: 'skill',
          name: 'pdf-tools',
          itemVersion: 1,
          digest: itemPreview().digest,
        }),
      ],
    ]),
  ),
};
const fake = fakeClient(handlers);
(window as unknown as { __calls: typeof fake.calls }).__calls = fake.calls;

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    scene === 'share' ? (
      <ShareSheet
        catalog={catalogs[0] ?? ownedCatalog()}
        connection={connection}
        copyText={async () => undefined}
        createClient={fake.factory}
        now={() => T0_MS}
        onClose={() => undefined}
      />
    ) : (
      <AddToCatalogSheet
        connection={connection}
        createClient={fake.factory}
        label="pdf-tools"
        onClose={() => undefined}
        source={source}
      />
    ),
  );
