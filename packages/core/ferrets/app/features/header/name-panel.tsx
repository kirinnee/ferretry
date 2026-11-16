/**
 * `ferret.toolbar` › `name` — what this ferret IS: its task title and, when that differs, its callsign. Presentational
 * over one ferret record; the bar around it is the host's.
 */

import type { FerretSummary } from '../../../contract/index.ts';
import { displayCallsign } from '../../lib/callsign.ts';
import { ferretTitles } from '../../lib/ferret-title.ts';

export function FerretName({ ferret, compact }: { readonly ferret: FerretSummary; readonly compact: boolean }) {
  const { title } = ferretTitles(ferret);
  const name = displayCallsign(ferret.name) || ferret.id;
  return (
    <div className="fy-ferret-name" data-ferret-name="" title={title === name ? name : `${title} — ${name}`}>
      <h1 className="fy-ferret-name__title">{title}</h1>
      {title === name || compact ? null : (
        <span className="fy-ferret-name__callsign" data-ferret-callsign="">
          {name}
        </span>
      )}
    </div>
  );
}
