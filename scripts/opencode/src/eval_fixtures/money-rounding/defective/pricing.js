export function cartTotal(items) {
  let total = 0;
  for (const item of items) {
    total += item.price;
  }
  return total;
}
