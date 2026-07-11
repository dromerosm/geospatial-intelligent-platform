// Text-module imports (bundled via the wrangler "Text" rule for *.html).
declare module "*.html" {
  const content: string;
  export default content;
}
