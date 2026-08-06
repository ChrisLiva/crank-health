import { routes } from "./dupe-keys.js";

export function serve() {
  return Object.keys(routes);
}
