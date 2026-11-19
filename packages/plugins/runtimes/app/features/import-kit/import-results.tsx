/**
 * What an import wrote or refused, one sentence per line in the daemon's own words (`ImportApplied.sentences`). The wizard's
 * "is set up" panel and a harness plugin's last import page draw the same list.
 */
export interface ImportResultListProps {
  readonly sentences: readonly string[];
}

export function ImportResultList({ sentences }: ImportResultListProps) {
  return (
    <ul className="m-0 flex list-disc flex-col gap-1 pl-5 text-cell text-muted" data-import-results="">
      {sentences.map(sentence => (
        <li key={sentence} className="[overflow-wrap:anywhere]">
          {sentence}
        </li>
      ))}
    </ul>
  );
}
