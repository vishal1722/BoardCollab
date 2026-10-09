import { configureStore, createSlice } from "@reduxjs/toolkit";
import { compareVersions } from "../../shared/crdt.js";

function mergeIntoDraft(elements, operation) {
  const current = elements[operation.elementId];
  if (current && compareVersions(operation, current) <= 0) return;
  elements[operation.elementId] = {
    elementId: operation.elementId,
    type: operation.type,
    data: operation.data,
    deleted: operation.deleted,
    clock: operation.clock,
    actorId: operation.actorId,
    opId: operation.opId,
  };
}

const boardSlice = createSlice({
  name: "board",
  initialState: { elements: {}, undoStack: [], redoStack: [], outbox: [], clock: 0 },
  reducers: {
    applyRemote(state, { payload }) {
      mergeIntoDraft(state.elements, payload);
      state.clock = Math.max(state.clock, payload.clock ?? 0);
    },
    applyCanonical(state, { payload }) {
      const current = state.elements[payload.elementId];
      if (current?.opId === payload.opId) {
        state.elements[payload.elementId] = { ...current, ...payload };
      } else {
        mergeIntoDraft(state.elements, payload);
      }
      state.clock = Math.max(state.clock, payload.clock ?? 0);
    },
    applyLocal(state, { payload: { operation, history = "normal" } }) {
      const existing = state.elements[operation.elementId];
      const before = existing ? { ...existing } : null;
      mergeIntoDraft(state.elements, operation);
      state.clock = Math.max(state.clock, operation.clock ?? 0);
      if (history === "normal") {
        state.undoStack.push({ elementId: operation.elementId, before, after: operation });
        if (state.undoStack.length > 100) state.undoStack.shift();
        state.redoStack = [];
      } else if (history === "undo") {
        const entry = state.undoStack.pop();
        if (entry) state.redoStack.push({ ...entry, undoOp: operation });
      } else if (history === "redo") {
        const entry = state.redoStack.pop();
        if (entry) state.undoStack.push({ ...entry, after: operation });
      }
      state.outbox.push(operation);
    },
    applyLocalBatch(state, { payload: operations }) {
      for (const operation of operations) {
        const existing = state.elements[operation.elementId];
        const before = existing ? { ...existing } : null;
        mergeIntoDraft(state.elements, operation);
        state.clock = Math.max(state.clock, operation.clock ?? 0);
        state.undoStack.push({ elementId: operation.elementId, before, after: operation });
        if (state.undoStack.length > 100) state.undoStack.shift();
        state.outbox.push(operation);
      }
      state.redoStack = [];
    },
    acknowledgeOperation(state, { payload: opId }) {
      state.outbox = state.outbox.filter((operation) => operation.opId !== opId);
    },
    hydrateBoard(state, { payload }) {
      for (const element of Object.values(payload?.elements ?? {})) {
        mergeIntoDraft(state.elements, element);
        state.clock = Math.max(state.clock, element.clock ?? 0);
      }
      if (Array.isArray(payload?.outbox)) {
        const known = new Set(state.outbox.map((operation) => operation.opId));
        state.outbox.push(...payload.outbox.filter((operation) => !known.has(operation.opId)));
      }
    },
    resetBoard() {
      return { elements: {}, undoStack: [], redoStack: [], outbox: [], clock: 0 };
    },
  },
});

export const {
  applyRemote,
  applyCanonical,
  applyLocal,
  applyLocalBatch,
  acknowledgeOperation,
  hydrateBoard,
  resetBoard,
} = boardSlice.actions;

export const store = configureStore({ reducer: { board: boardSlice.reducer } });

export function createOperation(element, actorId, clock) {
  return {
    opId: crypto.randomUUID(),
    elementId: element.elementId,
    type: element.type,
    data: element.data ?? {},
    deleted: Boolean(element.deleted),
    clock,
    actorId,
  };
}

export function undoOperation(state, actorId) {
  const entry = state.board.undoStack.at(-1);
  if (!entry) return null;
  const current = state.board.elements[entry.elementId];
  if (!current || current.opId !== entry.after.opId) return null;
  const prior = entry.before;
  return createOperation({
    elementId: entry.elementId,
    type: prior?.type ?? current.type,
    data: prior?.data ?? {},
    deleted: prior?.deleted ?? true,
  }, actorId, Math.max(state.board.clock, current.clock, entry.after.clock) + 1);
}

export function redoOperation(state, actorId) {
  const entry = state.board.redoStack.at(-1);
  if (!entry) return null;
  const current = state.board.elements[entry.elementId];
  if (!current || current.opId !== entry.undoOp?.opId) return null;
  return createOperation({
    elementId: entry.elementId,
    type: entry.after.type,
    data: entry.after.data,
    deleted: entry.after.deleted,
  }, actorId, Math.max(state.board.clock, current.clock, entry.after.clock) + 1);
}
