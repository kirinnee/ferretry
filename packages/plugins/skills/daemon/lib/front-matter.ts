/** The `name` and `description` of a SKILL.md's YAML front matter, or `undefined` when either is missing. */
export function skillFrontMatter(markdown: string): { name: string; description: string } | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown);
  if (!match) return undefined;
  const fields = new Map<string, string>();
  for (const line of match[1]!.split(/\r?\n/u)) {
    const field = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*?)\s*$/u.exec(line);
    if (field) fields.set(field[1]!, field[2]!.replace(/^['"]|['"]$/gu, '').trim());
  }
  const name = fields.get('name')?.trim();
  const description = fields.get('description')?.trim();
  return name && description ? { name, description } : undefined;
}
