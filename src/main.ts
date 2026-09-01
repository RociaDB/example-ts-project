/**
 * A small ERP — quotes, orders, invoices, stock, customers, suppliers —
 * built on the RociaDB TypeScript SDK.
 *
 * The business side is deliberately small. The point is to use every part of
 * the SDK once, at the place where it is the right tool.
 *
 * Run it with:
 *
 * ```text
 * ROCIA_NO_AUTH=1 npm start
 * ```
 */

import { status, type ServiceError } from "@grpc/grpc-js";
import {
  RociaDbBuilder,
  RociaDbError,
  TokenManager,
  fetchOAuthToken,
  type RociaDbClient,
} from "@rocia/rociadb-sdk";
import * as documents from "./documents.js";
import { BUCKET, Erp, GRAPH } from "./erp.js";
import * as files from "./files.js";
import * as graph from "./graph.js";
import {
  INVOICE_ISSUED,
  INVOICE_PAID,
  ORDER_PREPARING,
  ORDER_SHIPPED,
  QUOTE_ACCEPTED,
  QUOTE_SENT,
  VAT_REDUCED,
  VAT_STANDARD,
  money,
  totals,
  type Customer,
  type Invoice,
  type Line,
  type Order,
  type Product,
  type Quote,
  type StockMove,
  type Supplier,
} from "./model.js";

// Fixed dates keep the example readable and its output stable.
const TODAY = "2026-09-01";
const DUE_DATE = "2026-10-01";

await main();

async function main(): Promise<void> {
  const host = process.env["ROCIA_HOST"] ?? "http://127.0.0.1:50051";
  const tenant = process.env["ROCIA_TENANT"] ?? "demo";

  let client: RociaDbClient;
  try {
    client = await buildClient(host);
  } catch (error) {
    fail(error);
    return;
  }

  const erp = new Erp(client, tenant, `run-${Math.floor(Date.now() / 1000)}`);
  console.log(`Tenant "${erp.tenant}", graph "${GRAPH}", bucket "${BUCKET}"`);

  try {
    await seed(erp);
    await queryCatalogue(erp);
    await sell(erp);
    await attachments(erp);
    await traverse(erp);
    await explore(erp);
    await showErrorHandling(erp);

    if (process.env["ROCIA_CLEANUP"] !== undefined) {
      await cleanup(erp);
    }

    console.log("\nDone.");
  } catch (error) {
    fail(error);
  } finally {
    // Release the four gRPC channels and the cached token, in a `finally` so
    // a failed step still gives them up. Note what this is *not*: what lets
    // the process exit. grpc-js keeps an idle session unref'd, so forgetting
    // the call still terminates the program — which is exactly why a
    // long-lived service has to remember it, since nothing will remind you.
    client.close();
  }
}

/**
 * Build the client.
 *
 * Authentication is on by default: without `disableAuth()`, the builder reads
 * `AUTH_TOKEN_URL`, `AUTH_CLIENT_ID` and `AUTH_CLIENT_SECRET` itself at
 * `build()` time. Set `ROCIA_NO_AUTH=1` for a local server.
 */
async function buildClient(host: string): Promise<RociaDbClient> {
  // Every setter returns the builder, so the whole thing chains. The direct
  // `RociaDbClient.connect({ host, auth, connectTimeoutMs })` entry point
  // takes the same three settings as one object, for callers assembling
  // configuration rather than writing it out.
  const builder = new RociaDbBuilder().host(host).connectTimeout(10_000);

  const credentials = authFromEnvironment();
  if (process.env["ROCIA_NO_AUTH"] !== undefined) {
    builder.disableAuth();
  } else if (credentials) {
    // Passing them explicitly is the same thing the builder would do from the
    // environment; shown here because credentials usually come from a vault
    // rather than the process environment.
    builder.authClientCredentials(
      credentials.tokenUrl,
      credentials.clientId,
      credentials.clientSecret,
    );
  }

  // One client per upstream configuration, reused across every call: it owns
  // the gRPC channels and the cached token, and nothing here needs a second.
  return builder.build();
}

/** Step 1: customers, suppliers, products, and who supplies what. */
async function seed(erp: Erp): Promise<void> {
  step("1. Customers, suppliers and catalogue");

  for (const customer of demoCustomers()) {
    await documents.createCustomer(erp, customer);
  }
  for (const supplier of demoSuppliers()) {
    await documents.createSupplier(erp, supplier);
  }
  console.log("   3 customers and 2 suppliers written, each with its graph node");

  const products = demoProducts();
  for (const product of products) {
    await documents.importProduct(erp, product);
  }
  // Product nodes are written separately and enriched, so a traversal can
  // show a name without reading each document again.
  await graph.putProductNodes(erp, products);
  console.log(`   ${products.length} products imported`);

  // A product added outside the import: `putDocument` writes the document,
  // `putNode` writes its node. That is what `createDocument` does in one call.
  const extra: Product = {
    id: "P-006",
    reference: "GLUE-PU",
    name: "Polyurethane glue 310 ml",
    family: "hardware",
    unitPrice: 890,
    vatRate: VAT_STANDARD,
    stock: 24,
    minStock: 10,
    active: true,
  };
  await documents.saveProduct(erp, extra);
  await graph.putNode(erp, graph.node("product", extra.id), {
    collection: documents.PRODUCTS,
    id: extra.id,
  });
  console.log("   1 product added outside the import (putDocument + putNode)");

  // `createDocument` writes the document and then the node, with no
  // transaction between them: if the second write fails, the document is left
  // unbound. This is the repair — same payload, stable key, so running it
  // twice costs nothing.
  await graph.putNodeWithKey(erp, graph.node("customer", "C-003"), {
    collection: documents.CUSTOMERS,
    id: "C-003",
  });
  console.log("   customer C-003 node binding re-asserted (putNode with a requestId)");

  // Edges last: both endpoints must already exist as nodes.
  await graph.linkSupplierProducts(erp, "S-001", [
    ["P-001", 780],
    ["P-002", 1180],
    ["P-003", 190],
  ]);
  await graph.linkSupplierProducts(erp, "S-002", [
    ["P-004", 9800],
    ["P-001", 830],
  ]);
  console.log('   "supplies" edges created');

  // A delivery from a supplier: one stock move in.
  const product = await moveStock(erp, "P-005", "in", 50, "delivery from S-001");
  console.log(`   received 50 x ${product.name}, stock now ${product.stock}`);
}

/** Step 2: the four ways to read documents. */
async function queryCatalogue(erp: Erp): Promise<void> {
  step("2. Reading the catalogue");

  const products = await documents.allProducts(erp);
  const value = products.reduce((sum, product) => sum + product.unitPrice * product.stock, 0);
  console.log(
    `   listDocuments: ${products.length} products, stock worth ${money(value)}`,
  );

  const search = await documents.searchProducts(erp, "hardware", "screw");
  console.log(
    `   queryDocuments (family = hardware AND name contains "screw"): ` +
      `${search.items.length} of ${search.totalCount}`,
  );
  for (const product of search.items) {
    console.log(`     - ${product.name} at ${money(product.unitPrice)}`);
  }

  const toReorder = await documents.productsToReorder(erp);
  console.log(
    `   below minimum stock: ` +
      join(toReorder.map((p) => `${p.reference} (${p.stock}/${p.minStock})`)),
  );

  const email = "orders@bertrand.example";
  const found = await documents.findCustomerByEmail(erp, email);
  console.log(`   findDocumentsByField on "${email}": ${found[0]?.name ?? "nothing"}`);
}

/** Step 3: quote, order, shipment, invoice, payment. */
async function sell(erp: Erp): Promise<void> {
  step("3. Quote, order, invoice");

  const customer = await documents.get<Customer>(erp, documents.CUSTOMERS, "C-001");
  const screws = await documents.get<Product>(erp, documents.PRODUCTS, "P-001");
  const brackets = await documents.get<Product>(erp, documents.PRODUCTS, "P-003");

  const lines: Line[] = [
    {
      productId: screws.id,
      name: screws.name,
      quantity: 12,
      unitPrice: screws.unitPrice,
      vatRate: screws.vatRate,
    },
    {
      productId: brackets.id,
      name: brackets.name,
      quantity: 80,
      unitPrice: brackets.unitPrice,
      vatRate: brackets.vatRate,
    },
  ];

  // The quote.
  const quote: Quote = {
    id: "Q-2026-0001",
    customerId: customer.id,
    status: QUOTE_SENT,
    date: TODAY,
    lines,
    totals: totals(lines),
  };
  await documents.createBound(erp, documents.QUOTES, "quote", quote.id, quote);
  await graph.link(
    erp,
    graph.REQUESTED,
    graph.node("customer", customer.id),
    graph.node("quote", quote.id),
  );
  console.log(
    `   quote ${quote.id} for ${customer.name}: ${money(quote.totals.net)} net, ` +
      `${money(quote.totals.vat)} VAT, ${money(quote.totals.gross)} gross`,
  );

  // Accepted, so it becomes an order.
  const accepted: Quote = { ...quote, status: QUOTE_ACCEPTED };
  await documents.put(erp, documents.QUOTES, accepted.id, accepted);

  const order: Order = {
    id: "SO-2026-0001",
    customerId: customer.id,
    quoteId: quote.id,
    status: ORDER_PREPARING,
    date: TODAY,
    lines: quote.lines,
    totals: quote.totals,
  };
  await documents.createBound(erp, documents.ORDERS, "order", order.id, order);
  await graph.linkWithKey(
    erp,
    graph.CONVERTED_TO,
    graph.node("quote", quote.id),
    graph.node("order", order.id),
  );
  console.log(`   quote accepted, order ${order.id} created`);

  // Shipped: one stock move out per line.
  for (const line of order.lines) {
    const product = await moveStock(erp, line.productId, "out", line.quantity, order.id);
    console.log(
      `     - ${product.reference}: -${line.quantity} leaves ${product.stock} in stock`,
    );
  }
  await documents.put(erp, documents.ORDERS, order.id, { ...order, status: ORDER_SHIPPED });

  // Invoiced.
  const invoice: Invoice = {
    id: "INV-2026-0001",
    customerId: customer.id,
    orderId: order.id,
    status: INVOICE_ISSUED,
    date: TODAY,
    dueDate: DUE_DATE,
    lines: order.lines,
    totals: order.totals,
  };
  await documents.createBound(erp, documents.INVOICES, "invoice", invoice.id, invoice);
  await graph.linkWithKey(
    erp,
    graph.BILLED_AS,
    graph.node("order", order.id),
    graph.node("invoice", invoice.id),
  );
  console.log(
    `   invoice ${invoice.id} issued, due ${invoice.dueDate}, ` +
      `${money(invoice.totals.gross)} gross`,
  );

  const unpaid = await documents.unpaidInvoices(erp);
  console.log(
    `   queryDocuments (status in [issued, overdue], due date first): ` +
      `${unpaid.items.length} of ${unpaid.totalCount}`,
  );

  // Paid.
  await documents.put(erp, documents.INVOICES, invoice.id, {
    ...invoice,
    status: INVOICE_PAID,
  });
  console.log(`   invoice ${invoice.id} marked ${INVOICE_PAID}`);

  const moves = await documents.movesForProduct(erp, "P-001");
  console.log(
    `   stock moves on P-001: ` + join(moves.map((m) => `${m.direction} ${m.quantity}`)),
  );

  // A second quote, declined by the customer.
  //
  // Order matters: `deleteDocument` is idempotent, `deleteEdge` is not.
  // Removing the document first means a restart after a crash passes quietly
  // over the done half and finishes the edge; the other way round it would
  // hit NOT_FOUND.
  const drill = await documents.get<Product>(erp, documents.PRODUCTS, "P-004");
  const declinedLines: Line[] = [
    {
      productId: drill.id,
      name: drill.name,
      quantity: 2,
      unitPrice: drill.unitPrice,
      vatRate: drill.vatRate,
    },
  ];
  const declined: Quote = {
    id: "Q-2026-0002",
    customerId: "C-002",
    status: QUOTE_SENT,
    date: TODAY,
    lines: declinedLines,
    totals: totals(declinedLines),
  };
  await documents.createBound(erp, documents.QUOTES, "quote", declined.id, declined);
  const customerNode = graph.node("customer", declined.customerId);
  const quoteNode = graph.node("quote", declined.id);
  await graph.link(erp, graph.REQUESTED, customerNode, quoteNode);

  await documents.removeWithKey(erp, documents.QUOTES, declined.id);
  await graph.unlinkWithKey(erp, graph.edge(graph.REQUESTED, customerNode, quoteNode));
  console.log(`   quote ${declined.id} declined and removed`);
}

/** Step 4: the three uploads and the two downloads. */
async function attachments(erp: Erp): Promise<void> {
  step("4. Attachments");

  // 4a. The invoice as a text document: it fits in memory, so `uploadFile`
  //     handles chunking and hashing.
  const invoice = await documents.get<Invoice>(erp, documents.INVOICES, "INV-2026-0001");
  const lines = invoice.lines.map(
    (line) => `${line.quantity} x ${line.name} = ${money(line.unitPrice * line.quantity)}`,
  );
  const text =
    `INVOICE ${invoice.id}\nDue ${invoice.dueDate}\n\n` +
    `${lines.join("\n")}\n\nTotal: ${money(invoice.totals.gross)}\n`;
  const invoiceBytes = Buffer.from(text, "utf8");

  const invoiceFile = `invoices/${invoice.id}.txt`;
  await files.upload(erp, invoiceFile, invoiceBytes, "text/plain; charset=utf-8");
  console.log(`   uploadFile: ${invoiceFile} (${invoiceBytes.byteLength} bytes)`);

  // 4b. The stock export: produced in pieces, re-chunked by the SDK.
  const products = await documents.allProducts(erp);
  const rows = products.map((p) =>
    [p.reference, p.name, p.family, p.stock, p.minStock, p.unitPrice].join(";"),
  );
  const csv = `reference;name;family;stock;minStock;unitPrice\n${rows.join("\n")}\n`;

  const exportFile = `exports/stock-${TODAY}.csv`;
  await files.uploadStreamed(erp, exportFile, Buffer.from(csv, "utf8"), "text/csv");
  console.log(`   uploadFileStream: ${exportFile}`);

  // 4c. A short note, one hand-built message.
  await files.uploadRaw(
    erp,
    "notes/reorder.txt",
    Buffer.from("Check P-005 before the next order.\n", "utf8"),
  );
  console.log("   uploadFileRaw: notes/reorder.txt");

  const info = await files.stat(erp, invoiceFile);
  console.log(
    `   statFile: ${info.sizeBytes} bytes, ${info.contentType}, created ${info.createdAt}`,
  );
  // The checksum comes back as the raw 32 bytes, not hex: display it as hex.
  console.log(`   sha256: ${Buffer.from(info.checksum).toString("hex")}`);

  const downloaded = await files.download(erp, invoiceFile);
  console.log(
    `   downloadFile: ${downloaded.byteLength} bytes back, ` +
      `identical: ${Buffer.from(downloaded).equals(invoiceBytes)}`,
  );

  const streamed = await files.downloadStreamed(erp, exportFile);
  console.log(`   downloadFileStream: ${streamed} bytes read`);

  console.log(`   listFiles: ` + join(await files.listFiles(erp)));

  await files.removeWithKey(erp, "notes/reorder.txt");
  console.log("   deleteFile: note removed");
}

/** Step 5: graph traversals. */
async function traverse(erp: Erp): Promise<void> {
  step("5. Graph traversals");

  const supplied = await graph.productsOfSupplier(erp, "S-001");
  console.log(
    `   getOutgoingNeighborNodes (S-001 -supplies->): ` + join(supplied.map((p) => p.name)),
  );

  const sources = await graph.suppliersOfProduct(erp, "P-001");
  console.log(`   getIncomingNeighborNodes (-supplies-> P-001): ` + join(sources));

  const quotes = await graph.neighborsOut(erp, graph.node("customer", "C-001"), graph.REQUESTED);
  console.log(`   neighborsOut (C-001 -requested->): ` + join(quotes.map((n) => n.nodeId)));

  const orders = await graph.neighborsIn(
    erp,
    graph.node("invoice", "INV-2026-0001"),
    graph.BILLED_AS,
  );
  console.log(`   neighborsIn (-billed_as-> INV-2026-0001): ` + join(orders.map((n) => n.nodeId)));

  // The node `createDocument` wrote: a pointer to the document.
  const nodeId = graph.node("invoice", "INV-2026-0001");
  console.log(`   getNode<JsonValue> (raw): ${JSON.stringify(await graph.rawNode(erp, nodeId))}`);
  const docRef = await graph.nodeRef(erp, nodeId);
  console.log(
    `   getNode<DocRef> (typed): collection "${docRef.collection}", id "${docRef.id}"`,
  );
}

/** Step 6: what the deployment holds, and the token. */
async function explore(erp: Erp): Promise<void> {
  step("6. Exploring the deployment");

  // `listTenants` is the one RPC not scoped to a tenant. It enumerates the
  // whole deployment and may be refused by a dedicated policy, so
  // PERMISSION_DENIED here means "not your role", not "broken".
  //
  // Worth knowing: `tenantId` is a business partition, not a security
  // boundary. It is derived from no identity — any authenticated client can
  // address any tenant. Enforcing who may touch what is the application's job.
  try {
    const page = await erp.client.listTenants({ limit: 50 });
    console.log(`   listTenants: ` + join(page.items));
  } catch (error) {
    if (!isStatus(error, status.PERMISSION_DENIED)) throw error;
    console.log("   listTenants: refused, this RPC covers the whole deployment");
  }

  const collections = await documents.listCollections(erp);
  console.log(
    `   listCollections: ` + join(collections.map((c) => `${c.collection} (${c.count})`)),
  );
  console.log(`   listGraphs: ` + join(await graph.listGraphs(erp)));
  console.log(`   listNodes: ${(await graph.listNodes(erp)).length} nodes`);
  console.log(`   listBuckets: ` + join(await files.listBuckets(erp)));
  console.log(`   customers (free totalCount): ${await documents.countCustomers(erp)}`);

  // Both token calls are no-ops when the client was built with `disableAuth()`,
  // so callers need not know how it was built.
  await erp.client.refreshAuthToken();
  console.log("   refreshAuthToken: renewed now, caller waits");
  erp.client.invalidateToken();
  console.log("   invalidateToken: marks it stale without waiting");

  const credentials = authFromEnvironment();
  if (credentials) {
    await authModuleDemo(credentials.tokenUrl, credentials.clientId, credentials.clientSecret);
  }
}

/**
 * The auth helpers used without a `RociaDbClient`.
 *
 * `build()` sets all of this up for you. They are exported for when the same
 * token has to be used elsewhere, next to a service of your own.
 */
async function authModuleDemo(
  tokenUrl: string,
  clientId: string,
  clientSecret: string,
): Promise<void> {
  // One token, once. No caching, no renewal.
  const token = await fetchOAuthToken({ tokenUrl, clientId, clientSecret });

  // The manager caches and renews. Construction is synchronous, so the first
  // token comes from `initialize()` — which is what `build()` already awaited
  // on our behalf, and why bad credentials fail there rather than at the first
  // RPC. Standalone, you may skip it and let the first `metadata()` call fetch
  // lazily instead.
  const manager = new TokenManager({ tokenUrl, clientId, clientSecret });
  await manager.initialize();

  // The gRPC metadata carrying the bearer header, ready to attach to a call
  // of your own. Renewal happens here rather than in a background task: every
  // `metadata()` compares the cached token's age against `refreshSkewMs` (30 s
  // by default) and refetches inline if it is close to expiry, so there is
  // nothing to spawn and nothing to keep alive.
  const metadata = await manager.metadata();
  const header = String(metadata.get("authorization")[0] ?? "");

  // Two ways to renew: `refreshNow` awaits a new token, `invalidate` only
  // marks the cached one stale so the next `metadata()` fetches it.
  await manager.refreshNow();
  manager.invalidate();

  console.log(
    `   auth helpers: ${token.tokenType} token, valid ${token.expiresIn}s, ` +
      `header "${header.slice(0, 13)}…"`,
  );
}

/**
 * Step 7: what a `RociaDbError` tells you.
 *
 * One class with a `kind` field, not a class hierarchy: an existing
 * `instanceof RociaDbError` check never breaks when a cause is added. Two
 * questions decide whether to retry, and they are the ones to ask first.
 */
async function showErrorHandling(erp: Erp): Promise<void> {
  step("7. Reading an error");

  try {
    await erp.client.getDocument<Customer>(erp.tenant, documents.CUSTOMERS, "C-DOES-NOT-EXIST");
    console.log("   unexpectedly found a customer that should not exist");
  } catch (error) {
    // Anything that is not a `RociaDbError` is a bug here, not a server
    // answer, so it goes up rather than being described.
    if (!(error instanceof RociaDbError)) throw error;

    // UNAUTHENTICATED is the only case worth retrying: refresh the token,
    // then replay. PERMISSION_DENIED is final — the token is valid but lacks
    // the scope, so refreshing changes nothing.
    console.log(`   unauthenticated: ${error.code === status.UNAUTHENTICATED}`);
    console.log(`   permissionDenied: ${error.code === status.PERMISSION_DENIED}`);

    // Five fields, coarse to fine: which category of failure, the gRPC code,
    // the server's own reason (`not_found`, `invalid_argument`, ...), the
    // SDK's message — which names the call that failed, not the failure — and
    // `cause`. On a `"status"` error that cause is the grpc-js `ServiceError`,
    // and its `details` is the text the server actually sent, so nothing is
    // lost against calling the generated client directly.
    console.log(`   kind: ${error.kind}`);
    console.log(`   code: ${error.code === undefined ? "(none)" : status[error.code]}`);
    console.log(`   reason: ${error.reason ?? "(none)"}`);
    console.log(`   message: ${error.message}`);
    const cause = error.cause as ServiceError | undefined;
    console.log(`   cause.details: ${cause?.details ?? "(none)"}`);
    console.log(`   what to do: ${advice(error)}`);
  }
}

/**
 * One line of guidance per error kind.
 *
 * `RociaDbErrorKind` is a closed union of six strings, so `tsc` proves this
 * switch exhaustive and no default arm is needed. Leaving the default off is
 * the point: if the SDK ever adds a seventh kind, this stops compiling instead
 * of silently falling through to generic advice.
 */
function advice(error: RociaDbError): string {
  switch (error.kind) {
    case "status":
      return "the server refused the call; read reason to know why";
    case "connection":
      return "check the server is up, and that the host carries no path";
    case "auth":
      return "check AUTH_TOKEN_URL / AUTH_CLIENT_ID / AUTH_CLIENT_SECRET";
    case "encode":
      return "the value could not be serialized; fix the model";
    case "decode":
      return "the stored document no longer matches the TypeScript type";
    case "validation":
      return "rejected client-side; nothing was sent";
  }
}

/**
 * Step 8: remove the demo data.
 *
 * Three delete semantics meet here: `deleteDocument` and `deleteFile` are
 * idempotent, `deleteEdge` is not, and **nothing deletes a node** — there is
 * no RPC for it, so a node with no edges and no document stays listed by
 * `listNodes`.
 */
async function cleanup(erp: Erp): Promise<void> {
  step("8. Cleanup");

  // Edges first, while the traversals still find them. `Neighbor` carries the
  // real edge id, so there is nothing to rebuild.
  let edges = 0;
  for (const nodeId of await graph.listNodes(erp)) {
    for (const label of [graph.SUPPLIES, graph.REQUESTED, graph.CONVERTED_TO, graph.BILLED_AS]) {
      for (const neighbor of await graph.neighborsOut(erp, nodeId, label)) {
        await graph.unlink(erp, neighbor.edgeId);
        edges += 1;
      }
    }
  }

  let docs = 0;
  for (const collection of [
    documents.STOCK_MOVES,
    documents.INVOICES,
    documents.ORDERS,
    documents.QUOTES,
    documents.PRODUCTS,
    documents.CUSTOMERS,
    documents.SUPPLIERS,
  ]) {
    const page = await erp.client.listDocuments<{ id?: string }>(erp.tenant, collection, {
      limit: 200,
    });
    for (const document of page.items) {
      if (document.id === undefined) continue;
      await documents.remove(erp, collection, document.id);
      docs += 1;
    }
  }

  let removed = 0;
  for (const fileId of await files.listFiles(erp)) {
    await files.remove(erp, fileId);
    removed += 1;
  }

  console.log(`   ${docs} documents, ${edges} edges and ${removed} files deleted`);
  console.log(
    `   ${(await graph.listNodes(erp)).length} nodes remain: no RPC deletes a node`,
  );
}

/**
 * Move stock and record the move.
 *
 * Two writes, not a transaction: RociaDB offers no atomicity across
 * documents. The stock is updated first, so a crash in between leaves an
 * up-to-date stock with no trace rather than a trace with no effect — the
 * easier of the two to reconcile.
 */
async function moveStock(
  erp: Erp,
  productId: string,
  direction: "in" | "out",
  quantity: number,
  source: string,
): Promise<Product> {
  const stored = await documents.get<Product>(erp, documents.PRODUCTS, productId);
  const delta = direction === "in" ? quantity : -quantity;
  if (stored.stock + delta < 0) {
    throw new Error(`not enough stock on ${productId}`);
  }

  const product: Product = { ...stored, stock: stored.stock + delta };
  await documents.saveProduct(erp, product);

  const stockMove: StockMove = {
    id: `MOV-${productId}-${direction}-${erp.run}`,
    productId,
    direction,
    quantity,
    source,
  };
  await documents.put(erp, documents.STOCK_MOVES, stockMove.id, stockMove);
  return product;
}

/** The three OAuth2 variables, or nothing if any one of them is missing. */
function authFromEnvironment():
  | { tokenUrl: string; clientId: string; clientSecret: string }
  | undefined {
  const tokenUrl = process.env["AUTH_TOKEN_URL"];
  const clientId = process.env["AUTH_CLIENT_ID"];
  const clientSecret = process.env["AUTH_CLIENT_SECRET"];
  if (!tokenUrl || !clientId || !clientSecret) return undefined;
  return { tokenUrl, clientId, clientSecret };
}

/** Is this a gRPC failure carrying one particular status code? */
function isStatus(error: unknown, code: status): boolean {
  return error instanceof RociaDbError && error.code === code;
}

/** Print the failure the way a CLI should, and leave a non-zero exit code. */
function fail(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`\nFailed: ${message}`);
  process.exitCode = 1;
}

function step(title: string): void {
  console.log(`\n${title}`);
}

function join(values: readonly string[]): string {
  return values.length === 0 ? "none" : values.join(", ");
}

function demoCustomers(): Customer[] {
  return [
    {
      id: "C-001",
      name: "Bertrand Joinery",
      email: "orders@bertrand.example",
      city: "Nantes",
      active: true,
    },
    {
      id: "C-002",
      name: "Woodcraft Studio",
      email: "buying@woodcraft.example",
      city: "Rennes",
      active: true,
    },
    {
      id: "C-003",
      name: "Morel Framing",
      email: "accounts@morel.example",
      city: "Angers",
      active: false,
    },
  ];
}

function demoSuppliers(): Supplier[] {
  return [
    {
      id: "S-001",
      name: "Central Fasteners",
      email: "sales@fasteners.example",
      leadTimeDays: 5,
    },
    { id: "S-002", name: "ProTools", email: "sales@protools.example", leadTimeDays: 12 },
  ];
}

function demoProducts(): Product[] {
  return [
    {
      id: "P-001",
      reference: "SCR-4X30",
      name: "Wood screw 4x30 (box of 200)",
      family: "hardware",
      unitPrice: 1250,
      vatRate: VAT_STANDARD,
      stock: 120,
      minStock: 40,
      active: true,
    },
    {
      id: "P-002",
      reference: "SCR-5X50",
      name: "Wood screw 5x50 (box of 100)",
      family: "hardware",
      unitPrice: 1890,
      vatRate: VAT_STANDARD,
      stock: 18,
      minStock: 30,
      active: true,
    },
    {
      id: "P-003",
      reference: "BRK-RAFT",
      name: "Galvanised rafter bracket",
      family: "hardware",
      unitPrice: 340,
      vatRate: VAT_STANDARD,
      stock: 640,
      minStock: 150,
      active: true,
    },
    {
      id: "P-004",
      reference: "DRL-18V",
      name: "Cordless drill 18V",
      family: "tools",
      unitPrice: 14900,
      vatRate: VAT_STANDARD,
      stock: 7,
      minStock: 4,
      active: true,
    },
    {
      id: "P-005",
      reference: "DOC-FIT",
      name: "Printed fitting guide",
      family: "documentation",
      unitPrice: 450,
      vatRate: VAT_REDUCED,
      stock: 2,
      minStock: 25,
      active: true,
    },
  ];
}
