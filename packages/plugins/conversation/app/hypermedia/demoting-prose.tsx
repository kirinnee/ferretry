import type { ProseProps } from '@ferretry/app';
import { DemoteHeadings } from './demoted-heading.tsx';
import { ProvidedProse } from './hypermedia-prose.tsx';

/**
 * What Conversation hands the shell as `shell.prose`: the provided view ({@link ProvidedProse}) for a surface that is not the
 * chat's (the agenda), told whether that surface wants its headings demoted (see `demoted-heading.tsx`). A plain function,
 * because the shell calls it as a view; `copyable` is Markdown's and a part has its own copy, so it is not read.
 */
export function DemotingProse({ demoteHeadings, ...rest }: ProseProps) {
  return (
    <DemoteHeadings.Provider value={demoteHeadings === true}>
      <ProvidedProse {...rest} />
    </DemoteHeadings.Provider>
  );
}
