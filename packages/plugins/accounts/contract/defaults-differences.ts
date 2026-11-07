import {
  type AccountDefaultLine,
  type AccountDefaultsFile,
  accountDefaultLines,
  accountDefaultScopeWords,
} from './routes/accounts.ts';

/** Today's judgement: unattributed additions, changes AND removals speak in the owner's name. */
export function accountDefaultsDifferences(
  before: AccountDefaultsFile,
  after: AccountDefaultsFile | undefined,
  of: 'both' | 'added-or-changed' = 'both',
): readonly string[] {
  const address = (line: AccountDefaultLine): string => JSON.stringify([line.scope, line.within ?? null, line.key]);
  const was = new Map(accountDefaultLines(before).map(line => [address(line), line]));
  const now = new Map(accountDefaultLines(after ?? {}).map(line => [address(line), line]));
  const sentences: string[] = [];
  for (const [where, line] of of === 'both' ? [...now, ...was] : [...now]) {
    if (was.get(where)?.account === now.get(where)?.account) continue;
    const sentence = `changes which account a card offers first for ${line.key} in ${accountDefaultScopeWords(line)}`;
    if (!sentences.includes(sentence)) sentences.push(sentence);
  }
  return sentences;
}
