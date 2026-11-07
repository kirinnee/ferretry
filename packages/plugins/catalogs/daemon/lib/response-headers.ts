export function namesTag(ifNoneMatch: string, etag: string): boolean {
  return ifNoneMatch
    .split(',')
    .map(candidate => candidate.trim())
    .some(candidate => candidate === '*' || candidate.replace(/^W\//u, '') === etag);
}
