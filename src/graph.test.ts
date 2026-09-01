import assert from "node:assert/strict";
import { test } from "node:test";
import { SUPPLIES, edge, node } from "./graph.js";

test("node ids follow the sdk convention", () => {
  // `createDocument` builds exactly "{label}:{id}". If that changed, every
  // traversal here would look at the wrong node.
  assert.equal(node("customer", "C-1"), "customer:C-1");
  assert.equal(node("invoice", "INV-2026-1"), "invoice:INV-2026-1");
});

test("edge ids are rebuildable", () => {
  assert.equal(
    edge(SUPPLIES, "supplier:S-1", "product:P-1"),
    "supplies|supplier:S-1|product:P-1",
  );
});
