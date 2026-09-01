import assert from "node:assert/strict";
import { test } from "node:test";
import {
  VAT_REDUCED,
  VAT_STANDARD,
  money,
  totals,
  vat,
  type Cents,
  type Line,
} from "./model.js";

function line(quantity: number, unitPrice: Cents, vatRate: number): Line {
  return { productId: "P-1", name: "Product", quantity, unitPrice, vatRate };
}

test("vat rounds to the nearest cent", () => {
  // 9.99 at 20% is 1.998: rounds up.
  assert.equal(vat(999, VAT_STANDARD), 200);
  // 0.01 at 10% is 0.001: rounds down to nothing.
  assert.equal(vat(1, VAT_REDUCED), 0);
  // Exactly half a cent rounds up.
  assert.equal(vat(5, VAT_REDUCED), 1);
  assert.equal(vat(0, VAT_STANDARD), 0);
});

test("totals sum vat line by line", () => {
  // 3 x 9.99 = 29.97 net, 5.99 VAT; 2 x 45.50 = 91.00 net, 9.10 VAT.
  const result = totals([line(3, 999, VAT_STANDARD), line(2, 4550, VAT_REDUCED)]);
  assert.equal(result.net, 2997 + 9100);
  assert.equal(result.vat, 599 + 910);
  assert.equal(result.gross, result.net + result.vat);
});

test("totals of nothing are zero", () => {
  assert.deepEqual(totals([]), { net: 0, vat: 0, gross: 0 });
});

test("money is readable", () => {
  assert.equal(money(123_456), "1234.56 EUR");
  assert.equal(money(5), "0.05 EUR");
  assert.equal(money(0), "0.00 EUR");
  assert.equal(money(-999), "-9.99 EUR");
});
