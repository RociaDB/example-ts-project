# erp-example

A small ERP — **quotes, orders, invoices, stock, customers, suppliers** —
built on [`@rocia/rociadb-sdk`](https://www.npmjs.com/package/@rocia/rociadb-sdk),
the RociaDB TypeScript SDK.

The business logic is deliberately plain. The point is to use every part of
the SDK once, at the place where it is the right tool.

This is the TypeScript twin of
[`example-rust-project`](https://github.com/RociaDB/example-rust-project): same
ERP, same eight steps, same output. Where the two differ, the difference is
the language's, not the example's — and each one is called out below.

## Running it

```bash
npm install

ROCIA_NO_AUTH=1 npm start
```

Node.js 20 or newer. There is nothing to install beyond `npm install`: the
SDK ships its compiled protobuf loader and the `.proto` files with it, so no
`protoc` is needed.

With no RociaDB listening on `127.0.0.1:50051` it stops on a clear message
rather than a stack trace, and exits 1.

| Variable | Default | Meaning |
|---|---|---|
| `ROCIA_HOST` | `http://127.0.0.1:50051` | host and port, **no path** |
| `ROCIA_TENANT` | `demo` | business partition to write to |
| `ROCIA_NO_AUTH` | unset | set it to skip authentication (local dev) |
| `ROCIA_CLEANUP` | unset | set it to delete the demo data at the end |
| `AUTH_TOKEN_URL`, `AUTH_CLIENT_ID`, `AUTH_CLIENT_SECRET` | — | OAuth2 credentials |

Leave `ROCIA_NO_AUTH` unset and the SDK reads the three `AUTH_*` variables
itself — that is the builder's default behaviour. Set all three and the
example also runs a short tour of the auth helpers on their own.

## What it does

```
customer ──requested──▶ quote ──converted_to──▶ order ──billed_as──▶ invoice

supplier ──supplies──▶ product
```

Each business record is a **document** (the source of truth: lines, totals,
status) plus a **graph node** (an index for navigation). Shipments and
deliveries write `stock_moves` documents and update the product's stock; the
invoice text and the stock export go to the **file service**.

The program runs eight steps in order, printing what each SDK call returned:
seed, catalogue queries, the sales flow, attachments, graph traversals,
deployment exploration, error handling, and optional cleanup.

## Layout

Six files, one per SDK service area plus the context they share:

| File | What it covers |
|---|---|
| [`model.ts`](src/model.ts) | business types, VAT and totals, the only logic testable without a server |
| [`erp.ts`](src/erp.ts) | the client, the tenant, the idempotency-key prefix, the graph and bucket names |
| [`documents.ts`](src/documents.ts) | write, read, search, query, delete documents |
| [`graph.ts`](src/graph.ts) | nodes and edges, single and batched, traversals both ways |
| [`files.ts`](src/files.ts) | the three uploads, the two downloads, the wire contract |
| [`main.ts`](src/main.ts) | the builder, tenants, token lifecycle, error handling, the demo |

Rust keeps `erp.ts`'s contents in `main.rs` and reaches them through
`crate::`. TypeScript has no crate root, so doing the same would make every
module import from the entry point and back; the shared context gets its own
module instead, and nothing imports `main.ts`.

Money is stored in cents and VAT rates in basis points, so no rounding
depends on the order of operations. Cents are a plain `number`: every
intermediate stays a safe integer, and `bigint` is reserved for the places
the SDK actually hands you one.

## Things worth knowing about RociaDB

**Nothing is declared.** A collection, a graph or a bucket exists from the
first write to it. That is convenient, and it is why names live in constants:
a typo does not fail, it silently creates one more collection.

**The document is the source of truth; the graph is an index.** No RPC reads
an edge's value back — `neighborsOut` returns a `nodeId` and an `edgeId`,
nothing else. Product nodes are written *enriched* so a traversal can show a
name without another `getDocument`.

**No two writes are atomic.** `createDocument` writes the document and then
the node with no transaction between them: if the second fails, the document
is left unbound, which is why the example shows the repair. Ordering is a
choice every time — `moveStock` updates the stock *before* writing its trace,
because an up-to-date stock with no trace is easier to reconcile than the
reverse.

**Deletes do not all behave the same.** `deleteDocument` and `deleteFile` are
idempotent; `deleteEdge` returns `NOT_FOUND` on a missing edge; and **nothing
deletes a node** — there is no RPC for it, so an orphaned node stays listed by
`listNodes`.

**Only the cursor ends a paginated walk.** A short page, or even an empty
one, is not the end: an index entry can briefly outlive the document it
points to. Loop while `nextCursor` is there, and expect one extra empty page
when the total is an exact multiple of the limit.

**Idempotency keys are a design choice.** The server deduplicates on
`(tenantId, operation, requestId)` for 24 hours. A stable key is what makes an
interrupted import safe to replay — but if this demo reused the same keys
every run, a second run after a cleanup would write nothing at all. So the
prefix changes per run and the key is stable within one.

**`tenantId` is a business partition, not a security boundary.** It is
derived from no identity: any authenticated client can address any tenant.
Deciding who may touch what is the application's job.

**Only one error is worth retrying.** `UNAUTHENTICATED` is temporary (refresh
the token, replay); `PERMISSION_DENIED` is final (the token is valid but
lacks the scope). Everything else is in `kind` and `reason`.

## Things worth knowing in TypeScript

**Close the client — not to exit, but to release it.** Rust releases the
connection by dropping the last clone; here it is an explicit `client.close()`,
in a `finally` block, tearing down the four gRPC channels and the cached
token. It is not what lets the process exit: grpc-js keeps an idle session
unref'd, so a program that forgot the call would still terminate. That is
precisely why a long-lived service has to remember it — nothing will remind
you.

**Counts and sizes are `bigint`.** `totalCount`, `CollectionInfo.count`,
`FileMetadata.sizeBytes` and `FileStreamUpload.sizeBytes` are protobuf
`uint64` on the wire, and the SDK refuses to narrow them to `number` on your
behalf. They interpolate into a template literal like any other value; what
they will not do is mix with `number` in arithmetic.

**A checksum is 32 raw bytes, never hex.** `createHash("sha256").digest()`
gives exactly that; `statFile` hands the same 32 bytes back, so hex-encode
them for display.

**The generic on `getDocument<T>` is a claim, not a check.** The SDK parses
the JSON and hands it back as `T` without validating its shape. Only
unparseable JSON fails, as a `RociaDbError` of kind `"decode"`.

**Query fields are the stored JSON's, so they are camelCase here.** The
documents this example writes use camelCase keys, which is why the unpaid
invoices sort on `dueDate` and not `due_date`. A filter or sort naming a field
that does not exist matches nothing rather than failing — which is the whole
argument for keeping the model in one file. `minStock` is not a query field at
all: with only `eq`, `in` and `contains` there is no comparing two fields, so
"stock below minimum" is narrowed server-side and compared in the client.

**`RociaDbError` is one class with a `kind` field**, so an
`instanceof RociaDbError` check never breaks when a cause is added, and
`switch (error.kind)` over the six kinds is checked exhaustively by `tsc`.
Rust's enum is `#[non_exhaustive]` and forces a wildcard arm; here a seventh
kind would be a compile error instead. Same safety, opposite direction.

**`@grpc/grpc-js` is a direct dependency on purpose.** The example imports
`status` from it to name a gRPC code, so it declares the package rather than
reaching through the SDK's own copy — pinned to the same major version the SDK
depends on, the way the Rust example pins `reqwest`.

**Do not port upload calls between the two SDKs by name.** The assisted
streaming tier is `uploadFileStream` here and `upload_file_chunked` in Rust;
the raw escape hatch is `uploadFileRaw` here and `upload_file_stream` there.
The two names that look alike are the two that are *not* each other's
counterpart. [`files.ts`](src/files.ts) says so at the top, next to the calls.

## Development

```bash
npm run typecheck
npm test
npm run check     # both
```

The six unit tests are deterministic and need no server: VAT and totals, and
the node/edge id conventions. The demo itself needs a running RociaDB.

## Licence

Apache-2.0, like the SDK.
