import { crossUsed } from "../../api/src/cross.js";
import { greet } from "./lint.js";
import { summarize } from "./shared.js";
import { isPlannable, kindOf, loaderFor, mapsFor, tierOf } from "./tokens.js";

export function render(rows) {
  const planned = rows.filter((row) => isPlannable(row));
  return {
    greeting: greet("world"),
    totals: summarize(planned),
    label: crossUsed("web"),
    assets: planned.map((row) => ({
      kind: kindOf(row.extension),
      tier: tierOf(row.extension),
      maps: mapsFor(row.extension),
      loader: loaderFor(row.extension),
    })),
  };
}
