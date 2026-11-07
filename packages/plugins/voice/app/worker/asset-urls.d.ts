// Vite's asset-URL queries, as the speech engines import them: `?worker&url` is a worker script's built URL and `?url`
// is a binary's. The bundler resolves them; nothing else types them.
declare module '*?worker&url' {
  const url: string;
  export default url;
}
declare module '*?url' {
  const url: string;
  export default url;
}
