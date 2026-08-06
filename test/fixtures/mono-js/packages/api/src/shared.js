export function summarize(items) {
  const values = items.map((item) => Number(item.value));
  const count = values.length;
  const sum = values.reduce((total, value) => total + value, 0);
  const mean = count === 0 ? 0 : sum / count;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const spread = max - min;
  const label = `${count} rows, mean ${mean}, spread ${spread}`;
  return { count, sum, mean, min, max, spread, label };
}
