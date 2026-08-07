import { routes } from "./dupe-keys.js";
import { greet } from "./greet.ts";
import { shout } from "./unformatted.js";

export function run(name) {
  return { greeted: greet(name), routes, shouted: shout(name) };
}
