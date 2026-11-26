/**
 * The browser entry for a ferret's recipe proposal on its ask, from what a real accounts daemon made: `/fixture.json` holds the ask's
 * item as its board held it after a ferret called `account_propose` (its `askRef` is the daemon's) and the owner's account list.
 * The value is that item as Agenda hands it to the renderer (`AskOnScreen`), and the form is the REAL `ask:sign-in-approval`
 * renderer (`signInApprovalCard`) inside the panel an agenda card draws it in. No ref is written by hand.
 *
 *   ?theme=<palette>-<mode>&state=ready|stale|gone|unreadable|approved|declined|refused
 */
import { createRoot } from 'react-dom/client';
import { type AgendaItem, AskOnScreenSchema } from '@ferretry/core-asks/contract';
import { type AccountList, AccountListSchema } from '../../../../contract/routes/index.ts';
import { signInApprovalCard } from '../../../../app/surfaces.tsx';

const params = new URLSearchParams(window.location.search);
document.documentElement.dataset.theme = params.get('theme') ?? 'studio-light';
const state = params.get('state') ?? 'ready';

/** What the real daemon made, shown to the scene by the test. */
const made = (await (await fetch('/fixture.json')).json()) as { item: AgendaItem; list: unknown };
const real: AccountList = AccountListSchema.parse(made.list);

const list = (): AccountList => {
  const [signIn, ...rest] = real.signIns;
  if (signIn === undefined) throw new Error('the fixture holds no sign-in');
  if (state === 'gone') {
    const { proposals: _proposals, ...bare } = signIn;
    return { ...real, signIns: [bare, ...rest] };
  }
  if (state === 'stale') return { ...real, signIns: [{ ...signIn, recipe: 'Edited by the owner since' }, ...rest] };
  return real;
};

const client = {
  call: async (route: string) => {
    if (route.startsWith('POST')) {
      if (state === 'refused') throw new Error('this device may not change secrets (grant secrets.configure)');
      return real.signIns[0];
    }
    if (state === 'unreadable') throw new Error('the daemon is down');
    return list();
  },
};

const value = AskOnScreenSchema.parse({
  ref: made.item.askRef,
  subject: made.item.subject,
  why: made.item.why,
  ferret: 'F1',
  ferretName: 'judson',
});

const root = document.getElementById('root');
if (root !== null)
  createRoot(root).render(
    <div className="mx-auto max-w-[640px] p-4" data-scene-ready="">
      <section className="kt-panel p-panel">
        <h3 className="m-0 mb-3 text-row font-semibold text-fg">{value.subject}</h3>
        {signInApprovalCard(client as never, value, undefined)}
      </section>
    </div>,
  );
