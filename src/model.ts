/**
 * Business types, and the small amount of arithmetic that needs no server.
 */

/**
 * Money is stored in cents, so no rounding depends on operation order.
 *
 * A `number` is enough: every intermediate here stays a safe integer
 * (`Number.MAX_SAFE_INTEGER` is about 90 trillion euros in cents), so nothing
 * needs the `bigint` the SDK uses for wire `uint64` counts and file sizes.
 */
export type Cents = number;

/** VAT rates in basis points: 2000 is 20.00%. */
export const VAT_STANDARD = 2000;
export const VAT_REDUCED = 1000;

// Statuses are plain strings. They are written into documents and used as-is
// in query filters, so one constant per value keeps both sides in sync: a
// typo in a filter returns zero rows instead of failing.
export const QUOTE_SENT = "sent";
export const QUOTE_ACCEPTED = "accepted";
export const ORDER_PREPARING = "preparing";
export const ORDER_SHIPPED = "shipped";
export const INVOICE_ISSUED = "issued";
export const INVOICE_OVERDUE = "overdue";
export const INVOICE_PAID = "paid";

export interface Customer {
  id: string;
  name: string;
  email: string;
  city: string;
  active: boolean;
}

export interface Supplier {
  id: string;
  name: string;
  email: string;
  leadTimeDays: number;
}

export interface Product {
  id: string;
  reference: string;
  name: string;
  family: string;
  unitPrice: Cents;
  vatRate: number;
  stock: number;
  minStock: number;
  active: boolean;
}

export interface Line {
  productId: string;
  name: string;
  quantity: number;
  unitPrice: Cents;
  vatRate: number;
}

export interface Totals {
  net: Cents;
  vat: Cents;
  gross: Cents;
}

export interface Quote {
  id: string;
  customerId: string;
  status: string;
  date: string;
  lines: Line[];
  totals: Totals;
}

export interface Order {
  id: string;
  customerId: string;
  quoteId: string;
  status: string;
  date: string;
  lines: Line[];
  totals: Totals;
}

export interface Invoice {
  id: string;
  customerId: string;
  orderId: string;
  status: string;
  date: string;
  dueDate: string;
  lines: Line[];
  totals: Totals;
}

export interface StockMove {
  id: string;
  productId: string;
  /** `"in"` on a delivery from a supplier, `"out"` on a shipment. */
  direction: string;
  quantity: number;
  source: string;
}

/**
 * VAT on a net amount, rounded to the nearest cent.
 *
 * `Math.trunc` and not `Math.round`: the addition of half a cent already
 * carries the rounding, and dividing two integers in JavaScript yields a
 * fraction where Rust's `i64 / i64` would have truncated on its own.
 */
export function vat(net: Cents, rate: number): Cents {
  return Math.trunc((net * rate + 5_000) / 10_000);
}

/**
 * Add up lines. VAT is computed per line and then summed, the way it is
 * printed on the invoice: rounding once at the end would be off by a cent
 * against the printed detail.
 */
export function totals(lines: readonly Line[]): Totals {
  let net = 0;
  let vatTotal = 0;
  for (const line of lines) {
    const lineNet = line.unitPrice * line.quantity;
    net += lineNet;
    vatTotal += vat(lineNet, line.vatRate);
  }
  return { net, vat: vatTotal, gross: net + vatTotal };
}

/** `123456` becomes `"1234.56 EUR"`. */
export function money(amount: Cents): string {
  const sign = amount < 0 ? "-" : "";
  const abs = Math.abs(amount);
  const cents = String(abs % 100).padStart(2, "0");
  return `${sign}${Math.trunc(abs / 100)}.${cents} EUR`;
}
