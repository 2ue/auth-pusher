export function formatCompactNumber(value: number | null | undefined) {
  if (value == null) return '--';
  if (Math.abs(value) < 1000) return String(value);

  if (Math.abs(value) >= 10000) {
    const wan = value / 10000;
    return `${stripTrailingZero(wan.toFixed(wan >= 100 ? 0 : 1))}w`;
  }

  const kilo = value / 1000;
  return `${stripTrailingZero(kilo.toFixed(kilo >= 100 ? 0 : 1))}k`;
}

function stripTrailingZero(value: string) {
  return value.replace(/\.0$/, '');
}
