import { greet } from "./lint.js";
import { summarize } from "./shared.js";

export function render(rows) {
  return {
    greeting: greet("world"),
    totals: summarize(rows),
  };
}
