import { looseEquals } from "./both.js";
import { shout } from "./unformatted.js";

export function run(a, b) {
  return shout(String(looseEquals(a, b)));
}
