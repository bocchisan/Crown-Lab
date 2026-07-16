// Node globals the Solana packages expect. This must be a module of its own,
// imported first: an ES module evaluates its imports before its own body, so a
// polyfill written in main.ts's body runs AFTER @solana/spl-token has already
// been evaluated — and that package touches `Buffer` at module top level, so
// the page dies with "Buffer is not defined" before a single line of ours runs.
//
// Importing "buffer/" with the trailing slash forces the npm package: plain
// "buffer" resolves to the node builtin, which vite externalizes to a stub
// whose .Buffer throws.

import { Buffer } from "buffer/";

declare global {
  // eslint-disable-next-line no-var
  var global: typeof globalThis;
}

globalThis.Buffer ??= Buffer as unknown as typeof globalThis.Buffer;
globalThis.global ??= globalThis;
