/**
 * Russian plural forms: pick(n, ["саб", "саба", "сабов"]).
 */
export const pickPluralRu = (value: number, forms: [string, string, string]): string => {
  const abs = Math.abs(value) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return forms[2];
  if (last > 1 && last < 5) return forms[1];
  if (last === 1) return forms[0];
  return forms[2];
};

/**
 * Russian compact counts for catalog/meta surfaces: 940 → «940»,
 * 1200 → «1,2 тыс.», 3500000 → «3,5 млн».
 */
export const formatCompactCount = (value: number | undefined | null): string => {
  if (value == null || !Number.isFinite(value)) return "0";
  if (value < 1000) return String(value);
  return new Intl.NumberFormat("ru", { notation: "compact", maximumFractionDigits: 1 }).format(value);
};
