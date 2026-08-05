// Entry point: keeps the two modules below reachable, so the only findings in
// this fixture are the security and duplication ones it plants on purpose.
import { evaluate, summarize } from "./handler.js";
import { summarize as summarizeReport } from "./report.js";

export { evaluate, summarize, summarizeReport };
