/** Trusted application context; never take these IDs from model output. */
export interface Context {
  tenantId: string;
  userId: string;
  workspaceId?: string;
  projectId?: string;
  threadId: string;
  origin: "human" | "agent" | "group";
}
export type Scope = "user" | "workspace" | "project" | "thread";
export type Category =
  "identity" | "preference" | "entity" | "decision" | "procedure";
export interface Message {
  id: string;
  author: { kind: "human" | "agent" | "tool" | "system"; id: string };
  content: string;
  timestamp: string;
}
export interface Source {
  messageId: string;
  authorKind: Message["author"]["kind"];
  authorId: string;
  timestamp: string;
}
export interface FactCandidate {
  category: Category;
  content: string;
  sourceMessageIds: string[];
  entityKey?: string;
  replaces?: string[];
  expiresAt?: string;
}
export interface Extraction {
  facts: FactCandidate[];
  summary?: string;
}
export interface Memory {
  id: string;
  category: Category;
  content: string;
  scope: Scope;
  workspaceId?: string;
  projectId?: string;
  threadId?: string;
  entityKey?: string;
  sources: Source[];
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  supersedes: string[];
  supersededBy?: string;
  deletedAt?: string;
}
export interface Summary {
  id: string;
  threadId: string;
  content: string;
  sourceMessageIds: string[];
  workspaceId?: string;
  projectId?: string;
  createdAt: string;
}
export interface State {
  memories: Memory[];
  summaries: Summary[];
  operations: { id: string; fingerprint: string }[];
}
export interface Snapshot {
  revision: number;
  state: State;
}
/** CAS must be atomic; engine instances can share a store safely. */
export interface MemoryStore {
  load(key: string): Promise<Snapshot>;
  compareAndSwap(
    key: string,
    expectedRevision: number,
    state: State,
  ): Promise<boolean>;
}
export interface ExtractionInput {
  context: Context;
  messages: readonly Message[];
  existing: readonly Memory[];
}
export type Extractor = (
  input: ExtractionInput,
  signal: AbortSignal,
) => Promise<Extraction>;
export type Embedder = (
  texts: readonly string[],
  signal: AbortSignal,
) => Promise<readonly (readonly number[])[]>;
export interface ConsolidationAction {
  type: "merge" | "delete";
  ids: string[];
  content?: string;
}
export type Consolidator = (
  memories: readonly Memory[],
  signal: AbortSignal,
) => Promise<readonly ConsolidationAction[]>;
export interface Policy {
  scope: Scope;
  requireHuman: boolean;
  entityKeyRequired: boolean;
  upsert: boolean;
}
export interface Options {
  store: MemoryStore;
  extract: Extractor;
  embed?: Embedder;
  consolidate?: Consolidator;
  policies?: Partial<Record<Category, Policy>>;
  countTokens?: (text: string) => number;
  timeoutMs?: number;
  embeddingTimeoutMs?: number;
  maxInputTokens?: number;
  maxContentTokens?: number;
  maxCandidates?: number;
  maxRetries?: number;
  now?: () => Date;
}
export interface Rejection {
  index: number;
  reason: string;
}
export interface IngestResult {
  duplicate: boolean;
  stored: string[];
  rejected: Rejection[];
}
export interface RecallItem {
  id: string;
  kind: "fact" | "summary";
  content: string;
  score: number;
  tokens: number;
  reason: "semantic" | "lexical" | "recent-summary";
}
export interface RecallResult {
  items: RecallItem[];
  text: string;
  tokens: number;
  retrieval: "semantic" | "lexical";
  embeddingFailure?: string;
}
