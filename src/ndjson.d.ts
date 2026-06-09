declare module "ndjson" {
  import { Transform } from "node:stream";

  interface NdjsonOptions {
    strict?: boolean;
  }

  export function parse(options?: NdjsonOptions): Transform;
  export function stringify(options?: NdjsonOptions): Transform;
}
