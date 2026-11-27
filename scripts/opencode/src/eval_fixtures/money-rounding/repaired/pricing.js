export function cartTotal(items) {
  let cents = 0;
  for (const item of items) {
    cents += Math.round(item.price * 100);
  }
  return cents / 100;
}
