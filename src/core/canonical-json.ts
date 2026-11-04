/** Object keys use code-point order; input arrays retain their semantic order. */
export function canonicalJson(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item !== null && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, val]) => [key, canonical(val)])
      );
    return item;
  };
  return JSON.stringify(canonical(value));
}
