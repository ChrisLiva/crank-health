import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import stuff from "definitely-not-a-declared-package";

// TODO: implement the rest
export function load(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {}
  return existsSync(path) ? stuff : null;
}
