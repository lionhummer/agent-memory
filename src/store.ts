import type { MemoryStore, Snapshot, State } from "./types.js";
export const emptyState = (): State => ({
  memories: [],
  summaries: [],
  operations: [],
});
/** Process-local adapter for examples/tests. Use a durable adapter in production. */
export class InMemoryStore implements MemoryStore {
  private readonly states = new Map<string, Snapshot>();
  async load(key: string): Promise<Snapshot> {
    return structuredClone(
      this.states.get(key) ?? { revision: 0, state: emptyState() },
    );
  }
  async compareAndSwap(
    key: string,
    expectedRevision: number,
    state: State,
  ): Promise<boolean> {
    if ((this.states.get(key)?.revision ?? 0) !== expectedRevision)
      return false;
    this.states.set(key, {
      revision: expectedRevision + 1,
      state: structuredClone(state),
    });
    return true;
  }
}
