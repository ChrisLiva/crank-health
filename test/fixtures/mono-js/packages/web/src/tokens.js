/**
 * The extension tables the bundler consults. Every lookup is a flat switch and
 * every rule is a guard: many branches, none of them nested, and no single
 * function anywhere near the cognitive ceiling — which is the point. fta scores
 * the *file*, and this file is a maintainability problem no per-function
 * complexity measure will ever report.
 */

/** What kind of thing an extension names. */
export function kindOf(extension) {
  switch (extension) {
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
    case "py":
    case "rb":
    case "go":
    case "rs":
    case "java":
    case "kt":
    case "swift":
    case "php":
      return "source";
    case "css":
    case "scss":
    case "sass":
    case "less":
    case "styl":
    case "pcss":
      return "style";
    case "html":
    case "htm":
    case "xml":
    case "svg":
    case "md":
    case "mdx":
      return "markup";
    case "json":
    case "yaml":
    case "yml":
    case "toml":
    case "ini":
    case "csv":
    case "tsv":
    case "lock":
      return "data";
    default:
      return "opaque";
  }
}

/** Which build pass an extension belongs to, lowest first. */
export function tierOf(extension) {
  switch (extension) {
    case "lock":
    case "json":
    case "toml":
    case "ini":
    case "yaml":
    case "yml":
      return 1;
    case "ts":
    case "mts":
    case "cts":
    case "tsx":
    case "java":
    case "kt":
    case "swift":
    case "rs":
    case "go":
      return 2;
    case "js":
    case "mjs":
    case "cjs":
    case "jsx":
    case "py":
    case "rb":
    case "php":
      return 3;
    case "css":
    case "pcss":
    case "scss":
    case "sass":
    case "less":
    case "styl":
    case "svg":
    case "html":
    case "htm":
    case "md":
    case "mdx":
    case "xml":
      return 4;
    default:
      return 5;
  }
}

/** Whether the bundler emits a sourcemap beside the output. */
export function mapsFor(extension) {
  switch (extension) {
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
    case "js":
    case "mjs":
    case "cjs":
    case "jsx":
      return "inline";
    case "scss":
    case "sass":
    case "less":
    case "styl":
    case "pcss":
    case "css":
      return "external";
    case "md":
    case "mdx":
    case "html":
    case "htm":
    case "svg":
    case "xml":
      return "none";
    default:
      return "none";
  }
}

/** The loader an extension is handed to. */
export function loaderFor(extension) {
  switch (extension) {
    case "ts":
    case "mts":
    case "cts":
    case "tsx":
      return "typescript";
    case "js":
    case "mjs":
    case "cjs":
    case "jsx":
      return "babel";
    case "scss":
    case "sass":
      return "sass";
    case "less":
      return "less";
    case "styl":
      return "stylus";
    case "css":
    case "pcss":
      return "postcss";
    case "md":
    case "mdx":
      return "markdown";
    case "json":
    case "toml":
    case "yaml":
    case "yml":
      return "data";
    default:
      return "raw";
  }
}

/** Whether an entry is complete enough for the bundler to plan around. */
export function isPlannable(entry) {
  return (
    entry.name !== undefined &&
    (entry.size ?? 0) < 2_000_000 &&
    entry.extension !== undefined &&
    (entry.depth ?? 0) < 24 &&
    entry.owner !== undefined &&
    (entry.count ?? 0) < 512 &&
    entry.kind !== undefined &&
    (entry.age ?? 0) < 90
  );
}
