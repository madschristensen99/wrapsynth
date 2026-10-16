// Polyfill Node globals before anything else in the bundle evaluates.
import { Buffer } from "buffer";
globalThis.Buffer = Buffer;
globalThis.process = globalThis.process ?? { env: {}, browser: true };
