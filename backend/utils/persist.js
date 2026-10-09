import Element from "../models/Element.js";
import Session from "../models/Session.js";

function newerVersionExpression(operation) {
  return {
    $or: [
      { $gt: [operation.clock, { $ifNull: ["$clock", -1] }] },
      {
        $and: [
          { $eq: [operation.clock, { $ifNull: ["$clock", -1] }] },
          { $gt: [operation.actorId, { $ifNull: ["$actorId", ""] }] },
        ],
      },
    ],
  };
}

export async function persistBatch(batch) {
  if (batch.length === 0) return;
  const latestByElement = new Map();
  for (const { roomId, operation } of batch) {
    const key = `${roomId}:${operation.elementId}`;
    const prior = latestByElement.get(key);
    if (!prior || operation.clock > prior.operation.clock ||
      (operation.clock === prior.operation.clock && operation.actorId > prior.operation.actorId)) {
      latestByElement.set(key, { roomId, operation });
    }
  }

  const writes = [...latestByElement.values()].map(({ roomId, operation }) => {
    const newer = newerVersionExpression(operation);
    const chooseIncoming = (field, fallback) => ({
      $cond: [newer, { $literal: operation[field] ?? fallback }, `$${field}`],
    });
    return {
      updateOne: {
        filter: { roomId, elementId: operation.elementId },
        update: [
          {
            $set: {
              roomId: { $literal: roomId },
              elementId: { $literal: operation.elementId },
              type: chooseIncoming("type", "stroke"),
              data: chooseIncoming("data", {}),
              deleted: chooseIncoming("deleted", false),
              clock: chooseIncoming("clock", 0),
              actorId: chooseIncoming("actorId", ""),
              opId: chooseIncoming("opId", ""),
              updatedAt: { $cond: [newer, "$$NOW", "$updatedAt"] },
              createdAt: { $ifNull: ["$createdAt", "$$NOW"] },
            },
          },
        ],
        upsert: true,
      },
    };
  });

  await Element.bulkWrite(writes, { ordered: false });
  await Session.bulkWrite(
    [...new Set(batch.map(({ roomId }) => roomId))].map((roomId) => ({
      updateOne: { filter: { roomId }, update: { $set: { lastUpdated: new Date() } } },
    }))
  );
}
