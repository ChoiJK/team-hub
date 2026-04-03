/**
 * Team Hub 데이터 저장소 — JSON 파일 기반
 * 에이전트 메모리, 메시지, 태스크, 빌드 잠금
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "fs";
import { join } from "path";

const DATA_DIR = join(import.meta.dir, "..", "data");

// ── 타입 ──

export interface Agent {
  id: string;
  role: string;
  project: string | null;
  memory: Record<string, unknown>;
  online: boolean;
  lastSeen: string;
  createdAt: string;
}

export interface Message {
  id: string;
  from: string;
  to: string | "all";
  content: string;
  timestamp: string;
  project: string | null;
}

export type TaskStage = "backlog" | "research" | "spec" | "implement" | "review" | "revision" | "done";

export interface TaskHistoryEntry {
  from: string;
  to: string;
  by: string;
  reason?: string;
  timestamp: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: "todo" | "in-progress" | "done" | "blocked";
  assignee: string | null;
  project: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  // Stage machine 필드
  stage?: TaskStage;
  dependsOn?: string[];
  branch?: string;
  lastCommit?: string;
  history?: TaskHistoryEntry[];
}

// ── 스테이지 머신 ──

export const STAGE_FLOW: Partial<Record<TaskStage, TaskStage>> = {
  backlog: "research",
  research: "spec",
  spec: "implement",
  implement: "review",
  review: "done",
  revision: "review",
};

export const STAGE_ROLE_MAP: Partial<Record<TaskStage, string>> = {
  backlog: "pm",
  research: "researcher",
  spec: "architect",
  implement: "coder",
  review: "reviewer",
};

export interface BuildLock {
  locked: boolean;
  lockedBy: string | null;
  lockedAt: string | null;
  reason: string;
  queue: string[];
}

// ── 유틸 ──

function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return fallback;
  }
}

function writeJson(path: string, data: unknown) {
  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
}

// ── 에이전트 ──

const AGENTS_DIR = join(DATA_DIR, "agents");
ensureDir(AGENTS_DIR);

export function getAgent(id: string): Agent | null {
  const path = join(AGENTS_DIR, `${id}.json`);
  return readJson<Agent | null>(path, null);
}

export function saveAgent(agent: Agent) {
  const path = join(AGENTS_DIR, `${agent.id}.json`);
  writeJson(path, agent);
}

export function listAgents(): Agent[] {
  ensureDir(AGENTS_DIR);
  return readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson<Agent | null>(join(AGENTS_DIR, f), null))
    .filter((a): a is Agent => a !== null);
}

export function registerAgent(
  id: string,
  role: string,
  project: string | null
): Agent {
  const existing = getAgent(id);
  const agent: Agent = {
    id,
    role,
    project,
    memory: existing?.memory ?? {},
    online: true,
    lastSeen: new Date().toISOString(),
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };
  saveAgent(agent);
  return agent;
}

export function setAgentOffline(id: string) {
  const agent = getAgent(id);
  if (agent) {
    agent.online = false;
    agent.lastSeen = new Date().toISOString();
    saveAgent(agent);
  }
}

// ── 메모리 (에이전트별, 프로젝트 독립) ──

export function storeMemory(agentId: string, key: string, value: unknown) {
  const agent = getAgent(agentId);
  if (!agent) return;
  agent.memory[key] = value;
  agent.lastSeen = new Date().toISOString();
  saveAgent(agent);
}

export function retrieveMemory(agentId: string, key: string): unknown {
  const agent = getAgent(agentId);
  return agent?.memory[key] ?? null;
}

export function listMemory(agentId: string): Record<string, unknown> {
  const agent = getAgent(agentId);
  return agent?.memory ?? {};
}

// ── 메시지 ──

const MESSAGES_DIR = join(DATA_DIR, "messages");
ensureDir(MESSAGES_DIR);

function todayFile(): string {
  const d = new Date().toISOString().slice(0, 10);
  return join(MESSAGES_DIR, `${d}.json`);
}

export function addMessage(msg: Omit<Message, "id" | "timestamp">): Message {
  const full: Message = {
    ...msg,
    id: crypto.randomUUID().slice(0, 8),
    timestamp: new Date().toISOString(),
  };
  const path = todayFile();
  const msgs = readJson<Message[]>(path, []);
  msgs.push(full);
  writeJson(path, msgs);
  return full;
}

export function getMessages(limit = 50, project?: string): Message[] {
  ensureDir(MESSAGES_DIR);
  const files = readdirSync(MESSAGES_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse();

  const all: Message[] = [];
  for (const f of files) {
    const msgs = readJson<Message[]>(join(MESSAGES_DIR, f), []);
    all.push(...msgs);
    if (all.length >= limit * 2) break;
  }

  const filtered = project
    ? all.filter((m) => !m.project || m.project === project)
    : all;

  return filtered.slice(0, limit);
}

// ── 태스크 ──

const TASKS_FILE = join(DATA_DIR, "tasks", "tasks.json");
ensureDir(join(DATA_DIR, "tasks"));

export function getTasks(project?: string): Task[] {
  const tasks = readJson<Task[]>(TASKS_FILE, []);
  return project ? tasks.filter((t) => t.project === project) : tasks;
}

function saveTasks(tasks: Task[]) {
  writeJson(TASKS_FILE, tasks);
}

export function createTask(
  title: string,
  description: string,
  createdBy: string,
  project: string | null
): Task {
  const tasks = getTasks();
  const task: Task = {
    id: crypto.randomUUID().slice(0, 8),
    title,
    description,
    status: "todo",
    stage: "backlog",
    assignee: null,
    project,
    createdBy,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  tasks.push(task);
  saveTasks(tasks);
  return task;
}

export function updateTask(
  id: string,
  updates: Partial<Pick<Task, "status" | "assignee" | "stage" | "dependsOn" | "branch" | "lastCommit" | "history">>
): Task | null {
  const tasks = getTasks();
  const idx = tasks.findIndex((t) => t.id === id);
  if (idx === -1) return null;
  Object.assign(tasks[idx], updates, { updatedAt: new Date().toISOString() });
  saveTasks(tasks);
  return tasks[idx];
}

export function getTaskById(id: string): Task | null {
  const tasks = getTasks();
  return tasks.find((t) => t.id === id) ?? null;
}

export type AdvanceResult =
  | { success: true; task: Task; nextRole: string }
  | { success: false; error: "not_found" | "already_done" | "invalid_stage" };

export function advanceTaskStage(
  id: string,
  by: string
): AdvanceResult {
  const task = getTaskById(id);
  if (!task) return { success: false, error: "not_found" };

  const currentStage = task.stage ?? "backlog";

  const nextStage = STAGE_FLOW[currentStage];
  if (!nextStage) return { success: false, error: "already_done" };

  const nextRole = STAGE_ROLE_MAP[nextStage] ?? "pm";
  const historyEntry: TaskHistoryEntry = {
    from: currentStage,
    to: nextStage,
    by,
    timestamp: new Date().toISOString(),
  };

  const history = [...(task.history ?? []), historyEntry];
  const status: Task["status"] = nextStage === "done" ? "done" : "in-progress";

  const updated = updateTask(id, {
    stage: nextStage,
    status,
    history,
    assignee: null,
  });

  return updated
    ? { success: true, task: updated, nextRole }
    : { success: false, error: "not_found" };
}

export type RevisionResult =
  | { success: true; task: Task; nextRole: string }
  | { success: false; error: "not_found" | "invalid_stage" };

export function revisionTask(
  id: string,
  by: string,
  reason: string
): RevisionResult {
  const task = getTaskById(id);
  if (!task) return { success: false, error: "not_found" };

  if (task.stage !== "review") {
    return { success: false, error: "invalid_stage" };
  }

  const historyEntry: TaskHistoryEntry = {
    from: "review",
    to: "revision",
    by,
    reason,
    timestamp: new Date().toISOString(),
  };

  const history = [...(task.history ?? []), historyEntry];

  const updated = updateTask(id, {
    stage: "revision",
    status: "in-progress",
    history,
    assignee: null,
  });

  return updated
    ? { success: true, task: updated, nextRole: "coder" }
    : { success: false, error: "not_found" };
}

// ── 빌드 잠금 ──

const BUILD_FILE = join(DATA_DIR, "build-lock.json");

export function getBuildLock(): BuildLock {
  return readJson<BuildLock>(BUILD_FILE, {
    locked: false,
    lockedBy: null,
    lockedAt: null,
    reason: "",
    queue: [],
  });
}

export function acquireBuildLock(
  agentId: string,
  reason: string
): { success: boolean; lock: BuildLock } {
  const lock = getBuildLock();
  if (lock.locked) {
    if (!lock.queue.includes(agentId)) {
      lock.queue.push(agentId);
      writeJson(BUILD_FILE, lock);
    }
    return { success: false, lock };
  }
  lock.locked = true;
  lock.lockedBy = agentId;
  lock.lockedAt = new Date().toISOString();
  lock.reason = reason;
  writeJson(BUILD_FILE, lock);
  return { success: true, lock };
}

export function releaseBuildLock(): {
  released: boolean;
  nextInQueue: string | null;
  lock: BuildLock;
} {
  const lock = getBuildLock();
  lock.locked = false;
  lock.lockedBy = null;
  lock.lockedAt = null;
  lock.reason = "";
  const next = lock.queue.shift() ?? null;
  writeJson(BUILD_FILE, lock);
  return { released: true, nextInQueue: next, lock };
}
