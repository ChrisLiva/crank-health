import { merge } from "./accumulate.js";
import { add } from "./clean.js";
import { classify } from "./complex.js";
import { bumpLimit } from "./const-assign.js";
import { routes } from "./dupe-keys.js";
import { pickBranch } from "./unreachable.js";
import { shout } from "./unformatted.js";
import { titleCase } from "./util/format.js";

export function run(rows) {
  return {
    merged: merge(rows),
    total: add(1, 2),
    score: classify(1, 2, 3, 4),
    limit: bumpLimit(),
    routes,
    branch: pickBranch(true),
    shouted: shout("hi"),
    title: titleCase("hello"),
  };
}
