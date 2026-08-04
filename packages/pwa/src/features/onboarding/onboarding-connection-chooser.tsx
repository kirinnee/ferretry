/** The second chooser: a connection is a route, not a hidden setting. */

import { ChevronRight, Cloud, Network, Radio } from 'lucide-react';
import type { ReactNode } from 'react';

import { CONNECTION_METHODS, type ConnectionMethodId } from './onboarding-model.ts';

const ICON: Record<ConnectionMethodId, ReactNode> = {
  'default-relay': <Cloud size={22} aria-hidden="true" />,
  'own-relay': <Radio size={22} aria-hidden="true" />,
  direct: <Network size={22} aria-hidden="true" />,
};

const ROW =
  'flex w-full min-w-0 items-center gap-3 rounded-control border border-border bg-surface-2 px-3 py-3 text-left transition-colors hover:border-accent hover:bg-accent-bg focus-visible:outline-focus focus-visible:outline-offset-focus';

export interface OnboardingConnectionChooserProps {
  readonly onChoose: (connection: ConnectionMethodId) => void;
}

export function OnboardingConnectionChooser({ onChoose }: OnboardingConnectionChooserProps) {
  return (
    <div className="flex min-w-0 flex-col gap-2" data-onboarding-connection-chooser="">
      <p className="m-0 text-meta leading-base text-muted">
        Direct is used whenever it is reachable; otherwise the chosen relay carries the connection.
      </p>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {CONNECTION_METHODS.map(method => (
          <li key={method.id} className="min-w-0">
            <button
              type="button"
              className={ROW}
              onClick={() => onChoose(method.id)}
              data-onboarding-connection={method.id}
            >
              <span className="shrink-0 text-accent">{ICON[method.id]}</span>
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="font-display text-title font-bold tracking-display text-fg">
                  {method.title}
                  {method.recommended === true ? <span className="ml-2 text-meta text-accent">Recommended</span> : null}
                </span>
                <span className="text-meta leading-base text-muted">{method.answer}</span>
              </span>
              <ChevronRight size={18} aria-hidden="true" className="shrink-0 text-faint" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
