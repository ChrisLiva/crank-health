import { routes } from "./dupe-keys.js";
import { shout } from "./unformatted.js";

export function run(name) {
  return { routes, shouted: shout(name) };
}
