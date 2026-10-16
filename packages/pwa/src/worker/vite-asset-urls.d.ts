// The two Vite asset-import forms `src/main.tsx` uses. Declared here rather than by pulling
// `vite/client`'s whole ambient surface into a package that otherwise uses none of it.

declare module '*?url' {
  const url: string;
  export default url;
}

declare module '*?worker&url' {
  const url: string;
  export default url;
}
