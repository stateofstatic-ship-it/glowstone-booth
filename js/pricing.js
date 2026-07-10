export const PRICE_MULTIPLIERS = [6, 8, 12, 15, 18, 20, 25, 30];

export function tagPrice(raw) {
  if (!(raw > 0)) return 0;
  if (raw >= 200) return Math.round(raw);
  const min = Math.max(3, Math.floor(raw) - 10);
  const max = Math.ceil(raw) + 10;
  let best = null;
  for (let dollars = min; dollars <= max; dollars += 1) {
    const ending = dollars % 10;
    if (ending !== 3 && ending !== 7) continue;
    const delta = Math.abs(dollars - raw);
    if (best === null || delta < best.delta || (delta === best.delta && dollars > best.price)) best = { price: dollars, delta };
  }
  return best?.price || Math.round(raw);
}
