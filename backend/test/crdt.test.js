import test from "node:test";
import assert from "node:assert/strict";
import { compareVersions, mergeElement } from "../../shared/crdt.js";

test("CRDT operations converge regardless of delivery order", () => {
  const first = { opId: "a", elementId: "shape", type: "rect", data: { x: 10 }, deleted: false, clock: 2, actorId: "alice" };
  const second = { opId: "b", elementId: "shape", type: "rect", data: { x: 20 }, deleted: false, clock: 2, actorId: "bob" };
  const left = mergeElement(mergeElement({}, first), second);
  const right = mergeElement(mergeElement({}, second), first);
  assert.deepEqual(left, right);
  assert.equal(left.shape.data.x, 20);
});

test("newer tombstones prevent deleted elements from reappearing", () => {
  const add = { opId: "a", elementId: "line", type: "stroke", data: {}, deleted: false, clock: 1, actorId: "alice" };
  const remove = { ...add, opId: "b", deleted: true, clock: 3 };
  assert.equal(mergeElement(mergeElement({}, add), remove).line.deleted, true);
  assert.equal(mergeElement(mergeElement({}, remove), add).line.deleted, true);
});

test("equal Lamport clocks use actor IDs as a deterministic tie-breaker", () => {
  assert.equal(compareVersions({ clock: 5, actorId: "bob" }, { clock: 5, actorId: "alice" }) > 0, true);
});
