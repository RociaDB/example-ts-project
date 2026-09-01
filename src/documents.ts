/**
 * The document service: write, read, search, query, delete.
 */

import type { CollectionInfo, DocumentQueryFilter, DocumentQuerySort } from "@rocia/rociadb-sdk";
import { GRAPH, type Erp } from "./erp.js";
import {
  INVOICE_ISSUED,
  INVOICE_OVERDUE,
  type Customer,
  type Invoice,
  type Product,
  type StockMove,
  type Supplier,
} from "./model.js";

// Collections are never declared: one appears the first time a document is
// written to it. Constants keep a typo from silently creating another one.
export const CUSTOMERS = "customers";
export const SUPPLIERS = "suppliers";
export const PRODUCTS = "products";
export const QUOTES = "quotes";
export const ORDERS = "orders";
export const INVOICES = "invoices";
export const STOCK_MOVES = "stock_moves";

/**
 * Write a customer, plus the graph node pointing back at it.
 *
 * `createDocument` does two things: it writes the document, then, when
 * `nodeLabel` and `nodeGraph` are both given, it upserts the node
 * `"{label}:{id}"` holding a `{ collection, id }` pointer to the document.
 * Supplying only one of the two is rejected client-side, before any RPC, with
 * a `RociaDbError` of kind `"validation"`.
 *
 * The two writes are not atomic. If the node write fails, the document is
 * left without its binding.
 */
export async function createCustomer(erp: Erp, customer: Customer): Promise<void> {
  await erp.client.createDocument(erp.tenant, CUSTOMERS, customer.id, customer, {
    nodeLabel: "customer",
    nodeGraph: GRAPH,
  });
}

/**
 * Same thing with an idempotency key we choose.
 *
 * The server deduplicates on `(tenantId, operation, requestId)` for 24 hours,
 * so replaying an interrupted import with the same keys is safe. Note the key
 * covers only the document write: the node binding generates its own.
 */
export async function createSupplier(erp: Erp, supplier: Supplier): Promise<void> {
  await erp.client.createDocument(erp.tenant, SUPPLIERS, supplier.id, supplier, {
    nodeLabel: "supplier",
    nodeGraph: GRAPH,
    requestId: erp.key(`supplier:${supplier.id}`),
  });
}

/** Write a product. `putDocument` writes the document only, no graph node. */
export async function saveProduct(erp: Erp, product: Product): Promise<void> {
  await erp.client.putDocument(erp.tenant, PRODUCTS, product.id, product);
}

/** Same, with a stable key: this is the replayable-import case. */
export async function importProduct(erp: Erp, product: Product): Promise<void> {
  await erp.client.putDocument(
    erp.tenant,
    PRODUCTS,
    product.id,
    product,
    erp.key(`import:${product.id}`),
  );
}

/**
 * Read one document into the requested type.
 *
 * The generic is a compile-time claim, not a runtime check: the SDK parses the
 * stored JSON and hands it back as `T` without validating its shape. Only
 * unparseable JSON fails, with a `RociaDbError` of kind `"decode"`.
 */
export function get<T>(erp: Erp, collection: string, id: string): Promise<T> {
  return erp.client.getDocument<T>(erp.tenant, collection, id);
}

/** Write any business document (quote, order, invoice, stock move). */
export async function put(erp: Erp, collection: string, id: string, value: unknown): Promise<void> {
  await erp.client.putDocument(erp.tenant, collection, id, value);
}

/** Write a document and bind it to a graph node, with a chosen key. */
export async function createBound(
  erp: Erp,
  collection: string,
  label: string,
  id: string,
  value: unknown,
): Promise<void> {
  await erp.client.createDocument(erp.tenant, collection, id, value, {
    nodeLabel: label,
    nodeGraph: GRAPH,
    requestId: erp.key(`${collection}:${id}`),
  });
}

/**
 * Every product, page after page.
 *
 * This is the cursor pattern: the cursor is opaque, you pass it back
 * unchanged, and it is absent once the server has nothing more. Note what
 * ends the loop — the missing cursor, never a short page: an index entry that
 * briefly outlives the document it points to can make a page in the middle of
 * a walk come back short, or even empty, without it being the last one.
 */
export async function allProducts(erp: Erp): Promise<Product[]> {
  const products: Product[] = [];
  let cursor: string | undefined;
  do {
    const page = await erp.client.listDocuments<Product>(erp.tenant, PRODUCTS, {
      limit: 50,
      cursor,
    });
    products.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return products;
}

/**
 * How many customers, without fetching them.
 *
 * `totalCount` is a `bigint`, so a protobuf `uint64` never loses precision.
 * On `listDocuments` it is free — the server keeps a per-collection counter —
 * where `queryDocuments` has to evaluate the whole filtered set to produce it.
 */
export async function countCustomers(erp: Erp): Promise<bigint> {
  const page = await erp.client.listDocuments<Customer>(erp.tenant, CUSTOMERS, { limit: 1 });
  return page.totalCount;
}

/**
 * Find customers by exact e-mail.
 *
 * `findDocumentsByField` matches one field exactly, and the value must be a
 * JSON scalar (string, number, boolean, null). An object or an array is
 * rejected with `INVALID_ARGUMENT`.
 */
export async function findCustomerByEmail(erp: Erp, email: string): Promise<Customer[]> {
  const page = await erp.client.findDocumentsByField<Customer>(
    erp.tenant,
    CUSTOMERS,
    "email",
    email,
    { limit: 20 },
  );
  return page.items;
}

/** Stock moves for one product. */
export async function movesForProduct(erp: Erp, productId: string): Promise<StockMove[]> {
  const page = await erp.client.findDocumentsByField<StockMove>(
    erp.tenant,
    STOCK_MOVES,
    "productId",
    productId,
    { limit: 50 },
  );
  return page.items;
}

/**
 * Search the catalogue: one family, one word in the name, sorted.
 *
 * Filters combine with AND — there is no OR. `contains` is a case-insensitive
 * substring, but a term shorter than 3 characters is not indexable, and a
 * query where no filter is indexable is refused rather than served by a full
 * scan — which is why the `eq` on `family` is there alongside it.
 *
 * Field names are the ones in the stored JSON, so they are camelCase here for
 * the same reason the documents are: a filter on a field that does not exist
 * matches nothing rather than failing.
 */
export async function searchProducts(
  erp: Erp,
  family: string,
  word: string,
): Promise<{ items: Product[]; totalCount: bigint }> {
  const filters: DocumentQueryFilter[] = [
    { field: "family", operator: "eq", values: [family] },
    { field: "name", operator: "contains", values: [word] },
  ];
  const sort: DocumentQuerySort[] = [{ field: "name", direction: "asc" }];

  const page = await erp.client.queryDocuments<Product>(erp.tenant, PRODUCTS, {
    filters,
    sort,
    limit: 50,
  });
  return { items: page.items, totalCount: page.totalCount };
}

/**
 * Products to reorder.
 *
 * The operators are `eq`, `in` and `contains` only — there is no comparison
 * between two fields, so "stock < minStock" cannot be a filter. We ask the
 * server for active products sorted by stock and compare here, on a set it
 * has already narrowed and ordered.
 */
export async function productsToReorder(erp: Erp): Promise<Product[]> {
  const page = await erp.client.queryDocuments<Product>(erp.tenant, PRODUCTS, {
    filters: [{ field: "active", operator: "eq", values: [true] }],
    sort: [{ field: "stock", direction: "asc" }],
    limit: 50,
  });
  return page.items.filter((product) => product.stock < product.minStock);
}

/**
 * Invoices still to be collected, oldest due date first.
 *
 * `in` takes several values on one field where `eq` takes one. Dates are
 * stored as ISO strings, which is what makes the server's lexicographic sort
 * match chronological order.
 */
export async function unpaidInvoices(
  erp: Erp,
): Promise<{ items: Invoice[]; totalCount: bigint }> {
  const page = await erp.client.queryDocuments<Invoice>(erp.tenant, INVOICES, {
    filters: [{ field: "status", operator: "in", values: [INVOICE_ISSUED, INVOICE_OVERDUE] }],
    sort: [{ field: "dueDate", direction: "asc" }],
    limit: 50,
  });
  return { items: page.items, totalCount: page.totalCount };
}

/** Which collections exist for this tenant, and how many documents each holds. */
export async function listCollections(erp: Erp): Promise<CollectionInfo[]> {
  const page = await erp.client.listCollections(erp.tenant, { limit: 50 });
  return page.items;
}

/**
 * Delete a document. This is idempotent: deleting an id that is not there
 * succeeds, unlike `deleteEdge`.
 */
export async function remove(erp: Erp, collection: string, id: string): Promise<void> {
  await erp.client.deleteDocument(erp.tenant, collection, id);
}

/** Delete with a chosen key, so a restarted cleanup does not replay. */
export async function removeWithKey(erp: Erp, collection: string, id: string): Promise<void> {
  await erp.client.deleteDocument(
    erp.tenant,
    collection,
    id,
    erp.key(`delete:${collection}:${id}`),
  );
}
