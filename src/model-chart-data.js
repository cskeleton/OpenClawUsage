function isValidDateParts(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function stripValidSuffix(name, pattern, toDateParts) {
  const match = name.match(pattern);
  if (!match) return null;

  const [year, month, day] = toDateParts(match);
  return isValidDateParts(year, month, day) ? match[1] : null;
}

export function stripDateCheckpoint(modelName) {
  const name = typeof modelName === 'string' ? modelName : '';

  return stripValidSuffix(name, /^(.*)-(\d{4})-(\d{2})-(\d{2})$/, (match) => [
    Number(match[2]), Number(match[3]), Number(match[4]),
  ])
    ?? stripValidSuffix(name, /^(.*)-(\d{4})(\d{2})(\d{2})$/, (match) => [
      Number(match[2]), Number(match[3]), Number(match[4]),
    ])
    ?? stripValidSuffix(name, /^(.*)-(\d{2})(\d{2})$/, (match) => [
      2000, Number(match[2]), Number(match[3]),
    ])
    ?? name;
}

function finiteNumber(value) {
  return Number.isFinite(value) ? value : 0;
}

function addFinite(left, right) {
  const sum = left + finiteNumber(right);
  if (Number.isFinite(sum)) return sum;
  return sum < 0 ? -Number.MAX_VALUE : Number.MAX_VALUE;
}

function createRow(key, label) {
  return {
    key,
    label,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalInput: 0,
    totalTokens: 0,
    totalCost: 0,
    requests: 0,
  };
}

export function buildModelChartRows(byModel, { mergeDateCheckpoints = true } = {}) {
  const rows = new Map();

  for (const [sourceKey, entry] of Object.entries(byModel ?? {})) {
    const model = typeof entry?.model === 'string' ? entry.model : '';
    const key = mergeDateCheckpoints ? stripDateCheckpoint(model) : sourceKey;
    const label = mergeDateCheckpoints ? key : model;
    const row = rows.get(key) ?? createRow(key, label);

    row.input = addFinite(row.input, entry?.input);
    row.output = addFinite(row.output, entry?.output);
    row.cacheRead = addFinite(row.cacheRead, entry?.cacheRead);
    row.cacheWrite = addFinite(row.cacheWrite, entry?.cacheWrite);
    row.totalTokens = addFinite(row.totalTokens, entry?.totalTokens);
    row.totalCost = addFinite(row.totalCost, entry?.totalCost);
    row.requests = addFinite(row.requests, entry?.requests);
    row.totalInput = addFinite(addFinite(row.input, row.cacheRead), row.cacheWrite);
    rows.set(key, row);
  }

  return [...rows.values()].sort((left, right) => (
    (right.totalInput + right.output) - (left.totalInput + left.output)
    || left.label.localeCompare(right.label)
    || left.key.localeCompare(right.key)
  ));
}
