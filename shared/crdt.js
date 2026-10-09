export function compareVersions(left, right) {
  if (!right) return 1;
  if (!left) return -1;
  if (left.clock !== right.clock) return left.clock - right.clock;
  return String(left.actorId).localeCompare(String(right.actorId));
}

export function mergeElement(elements, operation) {
  const current = elements[operation.elementId];
  if (current && compareVersions(operation, current) <= 0) return elements;

  return {
    ...elements,
    [operation.elementId]: {
      elementId: operation.elementId,
      type: operation.type,
      data: operation.data,
      deleted: operation.deleted,
      clock: operation.clock,
      actorId: operation.actorId,
      opId: operation.opId,
    },
  };
}
