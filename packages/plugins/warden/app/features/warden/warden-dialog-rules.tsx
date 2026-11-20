/**
 * Settings › Warden › Screens Ferretry clears: what it presses by itself, and how to teach it one more.
 *
 * A screen a rule knows is left at once; this card lists those rules (the built-in tables and the ones taught), and is
 * where the owner teaches a new one: name the ferret that is parked on the screen, read the rule that is proposed and
 * the row it would press, and say yes. Nothing is saved until that yes; a row that grants or trusts something is held and
 * never saved. The frame the proposal came from is kept on the machine and is never shown here.
 */
import { useCallback, useEffect, useState } from 'react';
import type {
  DialogLearnAnswer,
  DialogProposal,
  DialogRulesView,
  DialogRuleView,
} from '../../../contract/dialog-rules.ts';
import type { DaemonConnection } from '../../lib/machine.ts';
import { useWardenClientFactory } from '../../lib/warden-client-context.tsx';
import type { WardenClient } from '../../lib/warden-client.ts';

const HARNESS_NAMES = { claude: 'Claude Code', codex: 'Codex' } as const;

function RuleList({ rules, empty }: { readonly rules: readonly DialogRuleView[]; readonly empty: string }) {
  if (rules.length === 0) return <p className="m-0 text-cell text-muted">{empty}</p>;
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0">
      {rules.map(rule => (
        <li key={rule.id} className="text-cell leading-base text-fg">
          <span className="font-medium">{HARNESS_NAMES[rule.harness]}</span>
          <span className="text-muted"> · {rule.kind} · </span>
          {rule.does}
        </li>
      ))}
    </ul>
  );
}

/** One proposal: the screen's own title, its rows with the one that would be pressed marked, and the owner's yes. */
function Proposal({
  proposal,
  busy,
  onConfirm,
}: {
  readonly proposal: DialogProposal;
  readonly busy: boolean;
  readonly onConfirm: (ferret: string) => void;
}) {
  return (
    <section className="kt-panel p-panel" aria-label={`Proposed rule for ${proposal.ferret}`}>
      <h4 className="m-0 text-row font-semibold text-fg">
        {proposal.ferret} is parked on: {proposal.title}
      </h4>
      <ol className="my-2 flex list-none flex-col gap-1 p-0">
        {proposal.rows.map(row => (
          <li
            key={row.number}
            className="text-cell leading-base text-fg"
            data-pressed={row.pressed ? 'true' : undefined}
          >
            {row.pressed ? '→ ' : '   '}
            {row.number}. {row.label}
            {row.pressed && <span className="text-muted"> (the rule would press this)</span>}
          </li>
        ))}
      </ol>
      {proposal.note !== undefined && <p className="m-0 mb-2 text-cell leading-base text-muted">{proposal.note}</p>}
      {proposal.rule !== undefined && !proposal.held && (
        <button
          type="button"
          className="kt-btn min-h-[44px]"
          data-variant="primary"
          disabled={busy}
          onClick={() => onConfirm(proposal.ferret)}
        >
          Save this rule
        </button>
      )}
    </section>
  );
}

export interface WardenDialogRulesViewProps {
  readonly view: DialogRulesView;
  readonly proposal?: DialogProposal | undefined;
  readonly message?: string | undefined;
  readonly busy: boolean;
  readonly onLearn: (ferret: string) => void;
  readonly onConfirm: (ferret: string) => void;
}

export function WardenDialogRulesView(props: WardenDialogRulesViewProps) {
  const { view, proposal, message, busy, onLearn, onConfirm } = props;
  const [ferret, setFerret] = useState('');
  const waiting = view.pending.filter(each => each.ferret !== proposal?.ferret);
  return (
    <section className="kt-panel kt-panel--flat py-panel" aria-label="Screens Ferretry clears">
      <h3 className="m-0 text-row font-semibold text-fg">Screens Ferretry clears by itself</h3>
      <p className="mb-2 mt-1 text-cell leading-base text-muted">
        When a ferret stops on one of these, Ferretry presses the way out at once: a row that declines, or Esc. It never
        presses a row that trusts or approves anything.
      </p>
      <RuleList rules={view.builtIn} empty="None." />
      <h4 className="mb-1 mt-3 text-ui font-semibold text-fg">Taught by you</h4>
      <RuleList rules={view.taught} empty="Nothing yet." />
      <h4 className="mb-1 mt-3 text-ui font-semibold text-fg">Teach it a screen</h4>
      <p className="mb-2 mt-0 text-cell leading-base text-muted">
        Leave the ferret on the screen, name it here, and read the rule Ferretry proposes. Nothing is saved until you
        say yes.
      </p>
      <label className="flex flex-col gap-1 text-ui text-fg">
        Ferret
        <input
          className="kt-input min-h-[44px] w-full max-w-[16rem] rounded-control border border-border bg-surface-2 px-2 text-fg"
          value={ferret}
          onChange={event => setFerret(event.target.value)}
          placeholder="its name"
        />
      </label>
      <button
        type="button"
        className="kt-btn mt-2 min-h-[44px]"
        data-variant="primary"
        disabled={busy || ferret.trim() === ''}
        onClick={() => onLearn(ferret.trim())}
      >
        Look at its screen
      </button>
      {message !== undefined && (
        <p role="status" className="mb-0 mt-2 text-cell leading-base text-muted">
          {message}
        </p>
      )}
      <div className="mt-3 flex flex-col gap-2">
        {proposal !== undefined && <Proposal proposal={proposal} busy={busy} onConfirm={onConfirm} />}
        {waiting.map(each => (
          <Proposal key={each.ferret} proposal={each} busy={busy} onConfirm={onConfirm} />
        ))}
      </div>
    </section>
  );
}

const reasonOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/** The card over one daemon's client: the rules, the proposal in hand, and the owner's yes. */
export function WardenDialogRules({ connection }: { readonly connection: DaemonConnection }) {
  const createClient = useWardenClientFactory();
  const [client, setClient] = useState<WardenClient | undefined>(undefined);
  const [view, setView] = useState<DialogRulesView | undefined>(undefined);
  const [proposal, setProposal] = useState<DialogProposal | undefined>(undefined);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void createClient(connection)
      .then(async made => {
        const rules = await made.dialogRules();
        if (live) {
          setClient(made);
          setView(rules);
        }
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [connection, createClient]);

  const act = useCallback(
    async (work: (made: WardenClient) => Promise<DialogLearnAnswer>) => {
      if (client === undefined) return;
      setBusy(true);
      setMessage(undefined);
      try {
        const answer = await work(client);
        setProposal(answer.saved ? undefined : answer.proposal);
        setView(await client.dialogRules());
        setMessage(
          answer.saved
            ? 'Saved. The next time that screen shows, it is cleared at once.'
            : answer.heldFor.length > 0
              ? `Waiting for your approval: ${answer.heldFor.join(' ')}`
              : undefined,
        );
      } catch (cause) {
        setMessage(reasonOf(cause));
      } finally {
        setBusy(false);
      }
    },
    [client],
  );

  if (view === undefined) return null;
  return (
    <WardenDialogRulesView
      view={view}
      proposal={proposal}
      message={message}
      busy={busy}
      onLearn={ferret => void act(made => made.learnDialog({ ferret }))}
      onConfirm={ferret => void act(made => made.learnDialog({ ferret, confirm: true }))}
    />
  );
}
