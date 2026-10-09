import test from "node:test";
import assert from "node:assert/strict";
import {
  applyLocal,
  applyCanonical,
  applyRemote,
  createOperation,
  redoOperation,
  store,
  undoOperation,
} from "./store.js";

test("keeps the highest CRDT version when edits arrive out of order", () => {
  const stale = { opId: "old", elementId: "one", type: "rect", data: { x: 1 }, deleted: false, clock: 1, actorId: "alice" };
  const newer = { ...stale, opId: "new", data: { x: 9 }, clock: 4 };
  store.dispatch(applyRemote(newer));
  store.dispatch(applyRemote(stale));
  assert.equal(store.getState().board.elements.one.data.x, 9);
});

test("tracks only local actions in the undo history", () => {
  const operation = createOperation({
    elementId: "local", type: "text", data: { text: "note" },
  }, "me", store.getState().board.clock + 1);
  store.dispatch(applyLocal({ operation }));
  store.dispatch(applyRemote({
    ...operation, opId: "remote", elementId: "other", actorId: "someone-else",
  }));
  assert.deepEqual(
    store.getState().board.undoStack.map((entry) => entry.elementId),
    ["local"]
  );
});

test("undo and redo create fresh versions of the local edit", () => {
  const operation = createOperation({
    elementId: "history", type: "text", data: { text: "idea" },
  }, "me", store.getState().board.clock + 1);
  store.dispatch(applyLocal({ operation }));

  const undo = undoOperation(store.getState(), "me");
  assert.ok(undo);
  store.dispatch(applyLocal({ operation: undo, history: "undo" }));
  assert.equal(store.getState().board.elements.history.deleted, true);

  const redo = redoOperation(store.getState(), "me");
  assert.ok(redo);
  store.dispatch(applyLocal({ operation: redo, history: "redo" }));
  assert.equal(store.getState().board.elements.history.deleted, false);
  assert.deepEqual(store.getState().board.elements.history.data, { text: "idea" });
});

test("reconciles an optimistic edit with its lower server-assigned version", () => {
  const optimistic = createOperation({
    elementId: "canonical", type: "rect", data: { x: 4 },
  }, "me", 90);
  store.dispatch(applyLocal({ operation: optimistic }));
  store.dispatch(applyCanonical({ ...optimistic, clock: 12 }));
  assert.equal(store.getState().board.elements.canonical.clock, 12);
});
