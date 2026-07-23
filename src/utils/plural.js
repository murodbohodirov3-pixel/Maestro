// Russian needs three forms where English needs two, and the rule is not
// "1 vs many": 21 takes the same form as 1, and 11 does not.
export function pluralRu(count, one, few, many) {
  const number = Math.abs(Math.trunc(Number(count) || 0));
  const lastDigit = number % 10;
  const lastTwo = number % 100;

  if (lastTwo >= 11 && lastTwo <= 14) return many;
  if (lastDigit === 1) return one;
  if (lastDigit >= 2 && lastDigit <= 4) return few;
  return many;
}
