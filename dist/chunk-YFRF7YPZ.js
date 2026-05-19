// src/durable/types.ts
function isEdgeObserver(backend) {
  return "observe" in backend && "stop" in backend && !("save" in backend);
}

export {
  isEdgeObserver
};
//# sourceMappingURL=chunk-YFRF7YPZ.js.map