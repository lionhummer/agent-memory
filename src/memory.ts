import { createHash, randomUUID } from "node:crypto";
import type {
  Category,
  ConsolidationAction,
  Context,
  Extraction,
  FactCandidate,
  IngestResult,
  Memory,
  Options,
  Policy,
  RecallItem,
  RecallResult,
  State,
} from "./types.js";
export class MemoryError extends Error {
  constructor(
    public readonly code:
      | "INVALID"
      | "TIMEOUT"
      | "ABORTED"
      | "CONFLICT"
      | "MODEL_OUTPUT"
      | "INDETERMINATE",
    message: string,
  ) {
    super(message);
    this.name = "MemoryError";
  }
}
export const DEFAULT_POLICIES: Readonly<Record<Category, Policy>> = {
  identity: {
    scope: "user",
    requireHuman: true,
    entityKeyRequired: false,
    upsert: true,
  },
  preference: {
    scope: "user",
    requireHuman: true,
    entityKeyRequired: false,
    upsert: false,
  },
  entity: {
    scope: "workspace",
    requireHuman: false,
    entityKeyRequired: true,
    upsert: true,
  },
  decision: {
    scope: "project",
    requireHuman: true,
    entityKeyRequired: false,
    upsert: false,
  },
  procedure: {
    scope: "project",
    requireHuman: true,
    entityKeyRequired: false,
    upsert: false,
  },
};
const estimate = (text: string): number => Math.ceil(text.length / 4);
function assertContext(c: Context): void {
  if (
    ![c.tenantId, c.userId, c.threadId].every(
      (v) => typeof v === "string" && v.trim().length > 0,
    ) ||
    !["human", "agent", "group"].includes(c.origin) ||
    (c.projectId && !c.workspaceId)
  )
    throw new MemoryError(
      "INVALID",
      "tenantId, userId, threadId, valid origin and project workspace are required",
    );
}
function key(c: Context): string {
  assertContext(c);
  return JSON.stringify([c.tenantId, c.userId]);
}
function visible(m: Memory, c: Context, now: string): boolean {
  if (m.deletedAt || m.supersededBy || (m.expiresAt && m.expiresAt <= now))
    return false;
  return inScope(m, c);
}
function inScope(m: Memory, c: Context): boolean {
  switch (m.scope) {
    case "user":
      return true;
    case "workspace":
      return !!c.workspaceId && m.workspaceId === c.workspaceId;
    case "project":
      return (
        !!c.projectId &&
        m.workspaceId === c.workspaceId &&
        m.projectId === c.projectId
      );
    case "thread":
      return (
        m.workspaceId === c.workspaceId &&
        m.projectId === c.projectId &&
        m.threadId === c.threadId
      );
  }
}
function sameScope(a: Memory, b: Memory): boolean {
  return (
    a.scope === b.scope &&
    a.workspaceId === b.workspaceId &&
    a.projectId === b.projectId &&
    a.threadId === b.threadId
  );
}
function lexical(a: string, b: string): number {
  const words = new Set(a.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  const other = new Set(b.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  return words.size
    ? [...words].filter((w) => other.has(w)).length / words.size
    : 0;
}
function cosine(a: readonly number[], b: readonly number[]): number {
  if (
    !a.length ||
    a.length !== b.length ||
    ![...a, ...b].every(Number.isFinite)
  )
    throw new MemoryError(
      "MODEL_OUTPUT",
      "Embedding vectors must have matching dimensions and finite values",
    );
  let dot = 0,
    aa = 0,
    bb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0,
      y = b[i] ?? 0;
    dot += x * y;
    aa += x * x;
    bb += y * y;
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new MemoryError("ABORTED", "Operation aborted");
}
async function bounded<T>(
  call: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  parent?: AbortSignal,
): Promise<T> {
  throwIfAborted(parent);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    abort = () => {
      controller.abort();
      reject(new MemoryError("ABORTED", "Operation aborted"));
    };
    parent?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => {
      controller.abort();
      reject(new MemoryError("TIMEOUT", "External operation timed out"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => call(controller.signal)),
      stopped,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) parent?.removeEventListener("abort", abort);
  }
}
/** Facts, session summaries, source validation and bounded recall. No scheduler
 * or agent framework is required; the host decides when ingestion runs. */
export class AgentMemory {
  private readonly opts: Required<
    Pick<
      Options,
      | "timeoutMs"
      | "embeddingTimeoutMs"
      | "maxInputTokens"
      | "maxContentTokens"
      | "maxCandidates"
      | "maxRetries"
      | "countTokens"
      | "now"
    >
  > &
    Options;
  private readonly policies: Record<Category, Policy>;
  constructor(options: Options) {
    this.opts = {
      timeoutMs: 30_000,
      embeddingTimeoutMs: 500,
      maxInputTokens: 32_000,
      maxContentTokens: 2_000,
      maxCandidates: 50,
      maxRetries: 8,
      countTokens: estimate,
      now: () => new Date(),
      ...options,
    };
    for (const value of [
      this.opts.timeoutMs,
      this.opts.embeddingTimeoutMs,
      this.opts.maxInputTokens,
      this.opts.maxContentTokens,
      this.opts.maxCandidates,
      this.opts.maxRetries,
    ])
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new MemoryError(
          "INVALID",
          "Limits must be positive safe integers",
        );
    this.policies = structuredClone({
      ...DEFAULT_POLICIES,
      ...options.policies,
    });
    for (const p of Object.values(this.policies))
      if (
        !p ||
        !["user", "workspace", "project", "thread"].includes(p.scope) ||
        [p.requireHuman, p.entityKeyRequired, p.upsert].some(
          (v) => typeof v !== "boolean",
        )
      )
        throw new MemoryError("INVALID", "Invalid category policy");
  }
  private duplicate(state: State, id: string, fingerprint: string): boolean {
    const operation = state.operations.find((o) => o.id === id);
    if (operation && operation.fingerprint !== fingerprint)
      throw new MemoryError(
        "INVALID",
        "operationId was reused for different input",
      );
    return !!operation;
  }
  private async load(storeKey: string): Promise<import("./types.js").Snapshot> {
    return bounded(() => this.opts.store.load(storeKey), this.opts.timeoutMs);
  }
  private async commit(
    storeKey: string,
    revision: number,
    state: State,
    signal?: AbortSignal,
  ): Promise<boolean> {
    throwIfAborted(signal);
    try {
      return await bounded(
        () => this.opts.store.compareAndSwap(storeKey, revision, state),
        this.opts.timeoutMs,
        signal,
      );
    } catch (e) {
      if (
        e instanceof MemoryError &&
        (e.code === "TIMEOUT" || e.code === "ABORTED")
      )
        throw new MemoryError(
          "INDETERMINATE",
          "Storage commit outcome is uncertain; reconcile using the same operationId",
        );
      throw e;
    }
  }
  private tokens(text: string): number {
    const n = this.opts.countTokens(text);
    if (!Number.isSafeInteger(n) || n < 0)
      throw new MemoryError(
        "INVALID",
        "Token counter must return a nonnegative safe integer",
      );
    return n;
  }
  private now(): string {
    return this.opts.now().toISOString();
  }
  /** Host supplies a stable operation ID for this exact extraction window.
   * Successful replays do not call the extractor again. CAS retries do not
   * repeat model calls. Model failure leaves the window unprocessed. */
  async ingest(input: {
    operationId: string;
    context: Context;
    messages: readonly import("./types.js").Message[];
    signal?: AbortSignal;
  }): Promise<IngestResult> {
    const storeKey = key(input.context);
    if (!input.operationId.trim() || !input.messages.length)
      throw new MemoryError(
        "INVALID",
        "A stable operationId and messages are required",
      );
    const ids = new Set<string>();
    for (const m of input.messages) {
      if (
        !m.id ||
        ids.has(m.id) ||
        !m.author.id ||
        !["human", "agent", "tool", "system"].includes(m.author.kind) ||
        typeof m.content !== "string" ||
        !Number.isFinite(Date.parse(m.timestamp))
      )
        throw new MemoryError(
          "INVALID",
          "Messages need unique IDs, trusted authors and valid timestamps",
        );
      ids.add(m.id);
    }
    const operation = JSON.stringify([
      input.context.threadId,
      input.operationId,
    ]);
    const initial = await this.load(storeKey);
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([input.context, input.messages]))
      .digest("hex");
    if (this.duplicate(initial.state, operation, fingerprint))
      return { duplicate: true, stored: [], rejected: [] };
    throwIfAborted(input.signal);
    const messageTokens = this.tokens(JSON.stringify(input.messages));
    if (messageTokens > this.opts.maxInputTokens)
      throw new MemoryError(
        "INVALID",
        "Extraction window exceeds maxInputTokens; split it explicitly",
      );
    const existing: Memory[] = [];
    let used = messageTokens;
    for (const m of initial.state.memories
      .filter((m) => visible(m, input.context, this.now()))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
      const n = this.tokens(JSON.stringify(m));
      if (used + n > this.opts.maxInputTokens) continue;
      used += n;
      existing.push(m);
    }
    const extraction = await bounded(
      (s) =>
        this.opts.extract(
          {
            context: structuredClone(input.context),
            messages: structuredClone(input.messages),
            existing: structuredClone(existing),
          },
          s,
        ),
      this.opts.timeoutMs,
      input.signal,
    );
    this.validateExtraction(extraction);
    for (let attempt = 0; attempt < this.opts.maxRetries; attempt++) {
      throwIfAborted(input.signal);
      const snapshot = attempt === 0 ? initial : await this.load(storeKey);
      if (this.duplicate(snapshot.state, operation, fingerprint))
        return { duplicate: true, stored: [], rejected: [] };
      const state = structuredClone(snapshot.state),
        stored: string[] = [],
        rejected: IngestResult["rejected"] = [];
      const now = this.now();
      extraction.facts.forEach((candidate, index) => {
        const outcome = this.persist(
          candidate,
          input.context,
          input.messages,
          state,
          now,
        );
        if (typeof outcome === "string")
          rejected.push({ index, reason: outcome });
        else stored.push(outcome.id);
      });
      if (extraction.summary?.trim())
        state.summaries.push({
          id: randomUUID(),
          threadId: input.context.threadId,
          content: extraction.summary,
          sourceMessageIds: input.messages.map((m) => m.id),
          ...(input.context.workspaceId
            ? { workspaceId: input.context.workspaceId }
            : {}),
          ...(input.context.projectId
            ? { projectId: input.context.projectId }
            : {}),
          createdAt: now,
        });
      state.operations.push({ id: operation, fingerprint });
      if (await this.commit(storeKey, snapshot.revision, state, input.signal))
        return { duplicate: false, stored, rejected };
    }
    throw new MemoryError(
      "CONFLICT",
      "Concurrent memory updates exceeded retry limit",
    );
  }
  private validateExtraction(extraction: Extraction): void {
    if (
      !extraction ||
      !Array.isArray(extraction.facts) ||
      extraction.facts.length > this.opts.maxCandidates ||
      (extraction.summary !== undefined &&
        (typeof extraction.summary !== "string" ||
          this.tokens(extraction.summary) > this.opts.maxContentTokens))
    )
      throw new MemoryError(
        "MODEL_OUTPUT",
        "Invalid or oversized extraction output",
      );
    for (const f of extraction.facts)
      if (
        !f ||
        typeof f.category !== "string" ||
        !Object.hasOwn(this.policies, f.category) ||
        typeof f.content !== "string" ||
        !Array.isArray(f.sourceMessageIds) ||
        !f.sourceMessageIds.length ||
        !f.sourceMessageIds.every((id) => typeof id === "string") ||
        (f.entityKey !== undefined && typeof f.entityKey !== "string") ||
        (f.replaces !== undefined &&
          (!Array.isArray(f.replaces) ||
            !f.replaces.every((id) => typeof id === "string"))) ||
        (f.expiresAt !== undefined &&
          (typeof f.expiresAt !== "string" ||
            !Number.isFinite(Date.parse(f.expiresAt))))
      )
        throw new MemoryError("MODEL_OUTPUT", "Malformed fact candidate");
  }
  private persist(
    f: FactCandidate,
    c: Context,
    messages: readonly import("./types.js").Message[],
    state: State,
    now: string,
  ): Memory | string {
    const policy = this.policies[f.category];
    if (
      !f.content.trim() ||
      this.tokens(f.content) > this.opts.maxContentTokens
    )
      return "content-limit";
    const sourceMessages = [...new Set(f.sourceMessageIds)].map((id) =>
      messages.find((m) => m.id === id),
    );
    if (sourceMessages.some((m) => !m)) return "unknown-source";
    if (
      policy.requireHuman &&
      (c.origin !== "human" ||
        !sourceMessages.some(
          (m) => m?.author.kind === "human" && m.author.id === c.userId,
        ))
    )
      return "human-attribution-required";
    if (policy.entityKeyRequired && !f.entityKey?.trim())
      return "entity-key-required";
    if (
      (policy.scope === "workspace" && !c.workspaceId) ||
      (policy.scope === "project" && (!c.workspaceId || !c.projectId))
    )
      return "scope-context-required";
    const sources = sourceMessages.flatMap((m) =>
      m
        ? [
            {
              messageId: m.id,
              authorKind: m.author.kind,
              authorId: m.author.id,
              timestamp: new Date(m.timestamp).toISOString(),
            },
          ]
        : [],
    );
    const memory: Memory = {
      id: randomUUID(),
      category: f.category,
      content: f.content,
      scope: policy.scope,
      sources,
      createdAt: now,
      updatedAt: now,
      supersedes: [],
    };
    if (policy.scope !== "user" && c.workspaceId)
      memory.workspaceId = c.workspaceId;
    if (
      (policy.scope === "project" || policy.scope === "thread") &&
      c.projectId
    )
      memory.projectId = c.projectId;
    if (policy.scope === "thread") memory.threadId = c.threadId;
    if (f.entityKey && f.category !== "identity")
      memory.entityKey = f.entityKey;
    if (f.expiresAt) memory.expiresAt = new Date(f.expiresAt).toISOString();
    const explicit = [...new Set(f.replaces ?? [])];
    const targets = explicit.map((id) =>
      state.memories.find((m) => m.id === id),
    );
    if (
      targets.some(
        (m) =>
          !m ||
          !visible(m, c, now) ||
          !sameScope(m, memory) ||
          m.category !== f.category ||
          (policy.upsert && m.entityKey !== memory.entityKey),
      )
    )
      return "replacement-not-live-in-scope";
    if (policy.upsert && !explicit.length)
      targets.push(
        ...state.memories.filter(
          (m) =>
            visible(m, c, now) &&
            sameScope(m, memory) &&
            m.category === f.category &&
            m.entityKey === memory.entityKey,
        ),
      );
    for (const old of targets) {
      if (!old) continue;
      old.supersededBy = memory.id;
      old.updatedAt = now;
      memory.supersedes.push(old.id);
    }
    state.memories.push(memory);
    return memory;
  }
  async list(
    context: Context,
    options: { includeHistory?: boolean } = {},
  ): Promise<Memory[]> {
    const { state } = await this.load(key(context));
    return structuredClone(
      state.memories.filter((m) =>
        options.includeHistory
          ? inScope(m, context)
          : visible(m, context, this.now()),
      ),
    );
  }
  /** Budget includes headings, IDs and separators in the returned text. */
  async recall(input: {
    context: Context;
    query: string;
    tokenBudget?: number;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<RecallResult> {
    const tokenBudget = input.tokenBudget ?? 4000,
      limit = input.limit ?? 30;
    if (
      !Number.isSafeInteger(tokenBudget) ||
      tokenBudget < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1
    )
      throw new MemoryError("INVALID", "Invalid recall limits");
    throwIfAborted(input.signal);
    const { state } = await this.load(key(input.context));
    const memories = state.memories.filter((m) =>
      visible(m, input.context, this.now()),
    );
    // Bound embedding work by a deterministic lexical/recency shortlist.
    const candidates = memories
      .sort(
        (a, b) =>
          lexical(input.query, b.content) - lexical(input.query, a.content) ||
          b.updatedAt.localeCompare(a.updatedAt),
      )
      .slice(0, Math.max(limit, 100));
    let retrieval: RecallResult["retrieval"] = "lexical",
      embeddingFailure: string | undefined;
    let vectors: readonly (readonly number[])[] | undefined;
    if (this.opts.embed && candidates.length) {
      try {
        vectors = await bounded(
          (s) =>
            this.opts.embed!(
              [input.query, ...candidates.map((m) => m.content)],
              s,
            ),
          this.opts.embeddingTimeoutMs,
          input.signal,
        );
        if (vectors.length !== candidates.length + 1)
          throw new MemoryError("MODEL_OUTPUT", "Embedding count mismatch");
        for (const v of vectors.slice(1)) cosine(vectors[0] ?? [], v);
        retrieval = "semantic";
      } catch (e) {
        throwIfAborted(input.signal);
        embeddingFailure =
          e instanceof MemoryError ? e.code : "EMBEDDING_FAILED";
        vectors = undefined;
      }
    }
    const ranked: RecallItem[] = candidates.map((m, i) => ({
      id: m.id,
      kind: "fact",
      content: m.content,
      score: vectors
        ? cosine(vectors[0] ?? [], vectors[i + 1] ?? [])
        : lexical(input.query, m.content),
      tokens: 0,
      reason: retrieval,
    }));
    const summaries = state.summaries
      .filter(
        (s) =>
          s.threadId === input.context.threadId &&
          s.workspaceId === input.context.workspaceId &&
          s.projectId === input.context.projectId,
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 3);
    ranked.push(
      ...summaries.map((s, i): RecallItem => ({
        id: s.id,
        kind: "summary",
        content: s.content,
        score: 0.25 / (i + 1),
        tokens: 0,
        reason: "recent-summary",
      })),
    );
    ranked.sort((a, b) => b.score - a.score);
    const items: RecallItem[] = [],
      lines: string[] = [];
    for (const item of ranked) {
      if (items.length >= limit) break;
      const line = `[${item.kind}:${item.id}] ${item.content}`;
      if (this.tokens([...lines, line].join("\n\n")) > tokenBudget) continue;
      items.push({ ...item, tokens: this.tokens(line) });
      lines.push(line);
    }
    const text = lines.join("\n\n"),
      result: RecallResult = {
        items,
        text,
        tokens: this.tokens(text),
        retrieval,
      };
    if (embeddingFailure) result.embeddingFailure = embeddingFailure;
    return result;
  }
  /** Consolidates an explicitly bounded chunk in one exact scope/category.
   * Deletion/merging of human-required facts is disabled by default: a model
   * must not silently rewrite user commitments. Use new sourced ingestion. */
  async consolidate(input: {
    operationId: string;
    context: Context;
    category: Category;
    signal?: AbortSignal;
  }): Promise<{ merged: number; deleted: number }> {
    if (!this.opts.consolidate)
      throw new MemoryError("INVALID", "No consolidator configured");
    if (
      !Object.hasOwn(this.policies, input.category) ||
      this.policies[input.category].requireHuman
    )
      throw new MemoryError(
        "INVALID",
        "Consolidation of human-required categories is disabled",
      );
    const storeKey = key(input.context),
      now = this.now();
    if (!input.operationId.trim())
      throw new MemoryError(
        "INVALID",
        "Consolidation needs a stable operationId",
      );
    const operation = JSON.stringify([
      "consolidate",
      input.context.threadId,
      input.operationId,
    ]);
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([input.context, input.category]))
      .digest("hex");
    const snapshot = await this.load(storeKey);
    if (this.duplicate(snapshot.state, operation, fingerprint))
      return { merged: 0, deleted: 0 };
    throwIfAborted(input.signal);
    let used = 0;
    const facts = snapshot.state.memories
      .filter(
        (m) => m.category === input.category && visible(m, input.context, now),
      )
      .filter((m) => {
        const n = this.tokens(JSON.stringify(m));
        if (used + n > this.opts.maxInputTokens) return false;
        used += n;
        return true;
      });
    const scope = facts[0];
    const selected = scope ? facts.filter((m) => sameScope(m, scope)) : [];
    const actions = selected.length
      ? await bounded(
          (s) => this.opts.consolidate!(structuredClone(selected), s),
          this.opts.timeoutMs,
          input.signal,
        )
      : [];
    this.validateActions(actions, selected);
    throwIfAborted(input.signal);
    const state = structuredClone(snapshot.state);
    let merged = 0,
      deleted = 0;
    for (const action of actions) {
      const old = action.ids.flatMap(
        (id) => state.memories.find((m) => m.id === id) ?? [],
      );
      if (action.type === "delete") {
        for (const m of old) {
          m.deletedAt = now;
          m.updatedAt = now;
          deleted++;
        }
      } else {
        const first = old[0];
        if (!first || action.content === undefined) continue;
        const next: Memory = {
          ...first,
          id: randomUUID(),
          content: action.content,
          sources: old.flatMap((m) => m.sources),
          supersedes: old.map((m) => m.id),
          createdAt: now,
          updatedAt: now,
        };
        // Expiration follows the earliest source record, never silently extends it.
        const expiry = old
          .flatMap((m) => (m.expiresAt ? [m.expiresAt] : []))
          .sort()[0];
        if (expiry) next.expiresAt = expiry;
        state.memories.push(next);
        for (const m of old) {
          m.supersededBy = next.id;
          m.updatedAt = now;
        }
        merged++;
      }
    }
    state.operations.push({ id: operation, fingerprint });
    if (!(await this.commit(storeKey, snapshot.revision, state, input.signal)))
      throw new MemoryError(
        "CONFLICT",
        "Memory changed during consolidation; run a fresh consolidation",
      );
    return { merged, deleted };
  }
  private validateActions(
    actions: readonly ConsolidationAction[],
    facts: Memory[],
  ): void {
    if (!Array.isArray(actions) || actions.length > this.opts.maxCandidates)
      throw new MemoryError("MODEL_OUTPUT", "Invalid consolidation output");
    const used = new Set<string>();
    for (const a of actions) {
      if (
        !a ||
        !["merge", "delete"].includes(a.type) ||
        !Array.isArray(a.ids) ||
        !a.ids.length ||
        a.ids.some(
          (id: string) =>
            typeof id !== "string" ||
            used.has(id) ||
            !facts.some((m) => m.id === id),
        ) ||
        new Set(a.ids).size !== a.ids.length
      )
        throw new MemoryError(
          "MODEL_OUTPUT",
          "Consolidation targets must be distinct supplied memory IDs",
        );
      if (
        a.type === "merge" &&
        (a.ids.length < 2 ||
          typeof a.content !== "string" ||
          !a.content.trim() ||
          this.tokens(a.content) > this.opts.maxContentTokens ||
          new Set(
            facts.filter((m) => a.ids.includes(m.id)).map((m) => m.entityKey),
          ).size > 1)
      )
        throw new MemoryError(
          "MODEL_OUTPUT",
          "Merge needs bounded content and matching entity keys",
        );
      a.ids.forEach((id: string) => used.add(id));
    }
  }
}
