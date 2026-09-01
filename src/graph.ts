/**
 * The graph service: who supplies what, which quote became which invoice.
 *
 * Two things shape this module:
 *
 * - **The graph is an index, not the source of truth.** No RPC reads an
 *   edge's value back — `neighborsOut` returns a `nodeId` and an `edgeId`,
 *   nothing else. Anything you need to read lives in the document.
 * - **An edge needs both endpoints first.** `addEdge` returns `NOT_FOUND` if
 *   `from` or `to` is not already a node. Nodes first, edges after.
 */

import type { EdgeInput, JsonValue, Neighbor, NodeInput } from "@rocia/rociadb-sdk";
import { PRODUCTS } from "./documents.js";
import { GRAPH, type Erp } from "./erp.js";
import type { Product } from "./model.js";

// Edge labels.
export const SUPPLIES = "supplies";
export const REQUESTED = "requested";
export const CONVERTED_TO = "converted_to";
export const BILLED_AS = "billed_as";

/**
 * The value `createDocument` writes into the node it binds: a pointer back to
 * the document.
 */
export interface DocRef {
  collection: string;
  id: string;
}

/**
 * A node holding the pointer plus a couple of denormalized fields, so a
 * traversal can show something readable without re-reading each document.
 */
export interface ProductNode extends DocRef {
  reference: string;
  name: string;
}

/** Node ids follow `"{label}:{id}"` — the same shape `createDocument` uses. */
export function node(label: string, id: string): string {
  return `${label}:${id}`;
}

/**
 * Edge ids are ours to choose; `deleteEdge` takes only this id, so it has to
 * be rebuildable without reading the graph first.
 */
export function edge(label: string, from: string, to: string): string {
  return `${label}|${from}|${to}`;
}

/**
 * Write all product nodes in one batch.
 *
 * `putNodes` keeps at most 10 requests in flight. It is not atomic: the first
 * failure cancels the calls already dispatched alongside it, so earlier items
 * may be stored and later ones never sent. Retrying is safe precisely because
 * each item carries its own key.
 *
 * A node's value must be a JSON **object** — a scalar or an array is rejected.
 */
export async function putProductNodes(erp: Erp, products: readonly Product[]): Promise<void> {
  const nodes: NodeInput<ProductNode>[] = products.map((product) => ({
    nodeId: node("product", product.id),
    value: {
      collection: PRODUCTS,
      id: product.id,
      reference: product.reference,
      name: product.name,
    },
    requestId: erp.key(`node:${product.id}`),
  }));

  await erp.client.putNodes(erp.tenant, GRAPH, nodes);
}

/** Write one node. `putNode` generates its own idempotency key. */
export async function putNode(erp: Erp, nodeId: string, value: DocRef): Promise<void> {
  await erp.client.putNode(erp.tenant, GRAPH, nodeId, value);
}

/**
 * Write one node with a chosen key — what you would use to repair a document
 * whose node binding never made it.
 */
export async function putNodeWithKey(erp: Erp, nodeId: string, value: DocRef): Promise<void> {
  await erp.client.putNode(erp.tenant, GRAPH, nodeId, value, erp.key(`repair:${nodeId}`));
}

/**
 * Link a supplier to the products it supplies, in one batch.
 *
 * The edge value records the purchase terms. It is useful when reading the
 * data server-side, but the SDK cannot read it back.
 */
export async function linkSupplierProducts(
  erp: Erp,
  supplierId: string,
  products: readonly (readonly [productId: string, purchasePrice: number])[],
): Promise<void> {
  const from = node("supplier", supplierId);
  const edges: EdgeInput<{ purchasePrice: number }>[] = products.map(
    ([productId, purchasePrice]) => {
      const to = node("product", productId);
      return {
        edgeId: edge(SUPPLIES, from, to),
        from,
        to,
        label: SUPPLIES,
        value: { purchasePrice },
        requestId: erp.key(`supplies:${supplierId}:${productId}`),
      };
    },
  );

  await erp.client.addEdges(erp.tenant, GRAPH, edges);
}

/** Add one edge. The SDK generates the idempotency key. */
export async function link(erp: Erp, label: string, from: string, to: string): Promise<void> {
  await erp.client.addEdge(erp.tenant, GRAPH, {
    edgeId: edge(label, from, to),
    from,
    to,
    label,
    value: { note: "created by the demo" },
  });
}

/**
 * Add one edge with a chosen key, so a retry after a timeout does not create
 * a second one.
 */
export async function linkWithKey(
  erp: Erp,
  label: string,
  from: string,
  to: string,
): Promise<void> {
  await erp.client.addEdge(erp.tenant, GRAPH, {
    edgeId: edge(label, from, to),
    from,
    to,
    label,
    value: { note: "created by the demo" },
    requestId: erp.key(`${label}:${from}:${to}`),
  });
}

/**
 * The products a supplier supplies, node values included.
 *
 * `getOutgoingNeighborNodes` does in one call what `neighborsOut` plus a
 * `getNode` per result would do — it follows every page and hydrates each
 * payload. Because product nodes carry the name, nothing else has to be read.
 */
export async function productsOfSupplier(erp: Erp, supplierId: string): Promise<ProductNode[]> {
  const neighbors = await erp.client.getOutgoingNeighborNodes<ProductNode>(
    erp.tenant,
    GRAPH,
    node("supplier", supplierId),
    SUPPLIES,
  );
  return neighbors.map((neighbor) => neighbor.value);
}

/** Who supplies a product: the same traversal, backwards. */
export async function suppliersOfProduct(erp: Erp, productId: string): Promise<string[]> {
  const neighbors = await erp.client.getIncomingNeighborNodes<DocRef>(
    erp.tenant,
    GRAPH,
    node("product", productId),
    SUPPLIES,
  );
  return neighbors.map((neighbor) => neighbor.value.id);
}

/**
 * Raw outgoing neighbors. Prefer this over the typed helper above once a node
 * has many edges: this one paginates, that one returns everything.
 */
export async function neighborsOut(erp: Erp, nodeId: string, label: string): Promise<Neighbor[]> {
  const page = await erp.client.neighborsOut(erp.tenant, GRAPH, nodeId, label, { limit: 50 });
  return page.items;
}

/** Raw incoming neighbors. */
export async function neighborsIn(erp: Erp, nodeId: string, label: string): Promise<Neighbor[]> {
  const page = await erp.client.neighborsIn(erp.tenant, GRAPH, nodeId, label, { limit: 50 });
  return page.items;
}

/**
 * A node as stored, without committing to a shape. `getNode<T>` is one method
 * on both sides of that choice: the generic decides what the caller gets back,
 * and `JsonValue` is the honest answer when the shape is unknown.
 */
export function rawNode(erp: Erp, nodeId: string): Promise<JsonValue> {
  return erp.client.getNode<JsonValue>(erp.tenant, GRAPH, nodeId);
}

/** The `{ collection, id }` pointer a bound node carries. */
export function nodeRef(erp: Erp, nodeId: string): Promise<DocRef> {
  return erp.client.getNode<DocRef>(erp.tenant, GRAPH, nodeId);
}

/**
 * The graphs in this tenant. Like collections, one exists as soon as a node
 * is written to it.
 */
export async function listGraphs(erp: Erp): Promise<string[]> {
  const page = await erp.client.listGraphs(erp.tenant, { limit: 50 });
  return page.items;
}

/** Every node id in the graph. */
export async function listNodes(erp: Erp): Promise<string[]> {
  const nodes: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await erp.client.listNodes(erp.tenant, GRAPH, { limit: 200, cursor });
    nodes.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor);
  return nodes;
}

/**
 * Delete an edge.
 *
 * This is **not** idempotent: a missing edge returns `NOT_FOUND`, unlike
 * `deleteDocument` and `deleteFile`.
 */
export async function unlink(erp: Erp, edgeId: string): Promise<void> {
  await erp.client.deleteEdge(erp.tenant, GRAPH, edgeId);
}

/** Delete an edge with a chosen key. */
export async function unlinkWithKey(erp: Erp, edgeId: string): Promise<void> {
  await erp.client.deleteEdge(erp.tenant, GRAPH, edgeId, erp.key(`unlink:${edgeId}`));
}
