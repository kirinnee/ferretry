/** Decode the quoted arguments of scriptLine for the in-memory server; never run a shell or tmux. */
export function scriptWords(script: string): string[] {
  const words: string[] = [];
  let word = '';
  let quote = '';
  let started = false;
  for (let i = 0; i < script.length; i++) {
    const char = script[i] ?? '';
    if (quote !== '') {
      if (char === quote) quote = '';
      else if (quote === '"' && char === '\\') {
        const next = script[++i];
        word += next === 'n' ? '\n' : next === 'r' ? '\r' : next;
      } else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/u.test(char)) {
      if (started) words.push(word);
      word = '';
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (started) words.push(word);
  return words;
}
