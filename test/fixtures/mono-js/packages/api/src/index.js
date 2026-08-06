import { bumpLimit } from "./const-assign.js";
import { summarize } from "./shared.js";
import { shout } from "./unformatted.js";

export function serve(rows) {
  return {
    limit: bumpLimit(),
    totals: summarize(rows),
    banner: shout("api"),
  };
}
