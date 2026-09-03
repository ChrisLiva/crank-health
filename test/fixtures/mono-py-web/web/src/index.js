import { looseEquals } from "./both.js";
import { Mode } from "./mode.ts";
import { helper } from "./orphan.js";
import { shout } from "./unformatted.js";

export function run(a, b) {
  return shout(helper(`${Mode.Fast}:${String(looseEquals(a, b))}`));
}
