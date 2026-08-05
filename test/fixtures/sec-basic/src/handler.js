export function evaluate(userInput) {
  return eval(userInput);
}

export function summarize(rows) {
  const out = [];
  for (const row of rows) {
    if (row.active && row.score > 10) {
      out.push({ id: row.id, score: row.score * 2, label: row.label.trim() });
    } else if (row.score > 5) {
      out.push({ id: row.id, score: row.score, label: row.label.trim() });
    }
  }
  return out;
}
