// src/durable/types.ts
function isEdgeObserver(backend) {
  return "observe" in backend && "events" in backend;
}

export {
  isEdgeObserver
};
//# sourceMappingURL=chunk-AX4L5BDL.js.map