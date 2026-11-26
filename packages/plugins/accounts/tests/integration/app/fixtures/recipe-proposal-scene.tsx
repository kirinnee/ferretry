/**
 * The browser entry for a ferret's recipe proposal on its ask card, over FAKE data (no daemon, no account): the REAL
 * `ask:sign-in-approval` card (`signInApprovalCard`) inside the panel an agenda card draws it in.
 *
 *   ?theme=<palette>-<mode>&state=ready|stale|gone|unreadable|approved|declined|refused
 */
import { createRoot } from 'react-dom/client';
import { AccountListSchema } from '../../../../contract/routes/index.ts';
import { signInApprovalCard } from '../../../../app/surfaces.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const state = params.get('state') ?? 'ready';

const AT = '2026-10-31T10:00:00.000Z';
const SI = 'si_0000000000000001';
const RP = 'rp_0123456789abcdef';
const BASE = 'Open github.com\nPress Sign in\nType the saved username and password\nWait for the two-step prompt';
const PROPOSED =
  'Open github.com\nPress Sign in\nType the saved username and password\nChoose "Use a passkey instead" when the two-step prompt appears\nWait for the dashboard to show';

const list = (over: { recipe?: string; proposed?: boolean } = {}) =>
  AccountListSchema.parse({
    v: 1,
    health: 'ready',
    accounts: [
      {
        id: 'GITHUB',
        label: 'GitHub',
        username: 'octo-fixture',
        fields: { password: true },
        factors: [],
        signIns: [SI],
        createdAt: AT,
        updatedAt: AT,
      },
    ],
    signIns: [
      {
        id: SI,
        account: 'GITHUB',
        place: { kind: 'site', domains: ['github.com'], match: [] },
        method: { kind: 'password' },
        recipe: over.recipe ?? BASE,
        recipeVersion: 1,
        createdAt: AT,
        updatedAt: AT,
        ...(over.proposed === false
          ? {}
          : {
              proposals: [
                {
                  id: RP,
                  recipe: PROPOSED,
                  base: BASE,
                  why: 'The two-step prompt now offers a passkey, which skips the code',
                  sessionId: 'sess-1',
                  proposedAt: AT,
                  pin: 'b'.repeat(64),
                },
              ],
            }),
      },
    ],
  });

const client = {
  call: async (route: string) => {
    if (route.startsWith('POST')) {
      if (state === 'refused') throw new Error('this device may not change secrets (grant secrets.configure)');
      return list().signIns[0];
    }
    if (state === 'unreadable') throw new Error('the daemon is down');
    return list({ ...(state === 'stale' ? { recipe: 'Edited by the owner since' } : {}), proposed: state !== 'gone' });
  },
};

const ask = {
  ref: { kind: 'recipe-proposal', signIn: SI, proposal: RP },
  ferret: 'sess-1',
  ferretName: 'judson',
  subject: 'Recipe change on github.com',
  why: 'Recipe change on github.com',
};

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <div className="mx-auto max-w-[640px] p-4" data-scene-ready="">
      <section className="kt-panel p-panel">
        <h3 className="m-0 mb-3 text-row font-semibold text-fg">{ask.subject}</h3>
        {signInApprovalCard(client as never, ask, undefined)}
      </section>
    </div>,
  );
