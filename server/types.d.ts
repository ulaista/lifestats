// The cloud bundle (esbuild) inlines the Mini App page as a string.
declare module '*.html' { const html: string; export default html; }
