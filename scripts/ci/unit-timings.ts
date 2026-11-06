import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const decode = (value: string): string =>
  value.replace(
    /&(?:quot|apos|lt|gt|amp);/g,
    entity => ({ '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&amp;': '&' })[entity]!,
  );

export const slowestTest = (xml: string): { name: string; seconds: number } | undefined => {
  let slowest: { name: string; seconds: number } | undefined;
  for (const match of xml.matchAll(/<testcase\b([^>]+)>/g)) {
    const attrs = Object.fromEntries(
      [...(match[1] ?? '').matchAll(/([a-z]+)="([^"]*)"/g)].map(attr => [attr[1] ?? '', decode(attr[2] ?? '')]),
    );
    const seconds = Number(attrs.time);
    if (!Number.isFinite(seconds)) throw new Error('JUnit testcase has no numeric duration');
    if (slowest === undefined || seconds > slowest.seconds)
      slowest = { name: [attrs.file, attrs.classname, attrs.name].filter(Boolean).join(' › '), seconds };
  }
  return slowest;
};

if (import.meta.main) {
  const groups = JSON.parse(readFileSync('config/test-groups.json', 'utf8')).unit as { name: string }[];
  const rows = ['group\tseconds\ttest'];
  const summary = ['\n| Unit part | Slowest test | Test |', '| --- | --- | --- |'];
  let missing = false;
  for (const { name } of groups) {
    const path = `coverage/unit/groups/${name}/junit.xml`;
    const test = existsSync(path) ? slowestTest(readFileSync(path, 'utf8')) : undefined;
    const seconds = test?.seconds.toFixed(6) ?? 'missing';
    const title = (test?.name ?? 'JUnit report missing or empty').replace(/[\t\r\n]/g, ' ');
    rows.push(`${name}\t${seconds}\t${title}`);
    summary.push(`| unit-${name} | ${seconds}s | ${title.replaceAll('|', '\\|')} |`);
    console.log(`📝 unit-${name} slowest test: ${seconds}s — ${title}`);
    missing ||= test === undefined;
  }
  writeFileSync('coverage/ci/quick/unit-timings.tsv', rows.join('\n') + '\n');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY ?? '/dev/null', summary.join('\n') + '\n');
  if (missing) process.exitCode = 1;
}
