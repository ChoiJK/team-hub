/**
 * Team Hub 데이터 저장소 — JSON 파일 기반
 * 에이전트 메모리, 메시지, 태스크, 빌드 잠금
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, renameSync } from "fs";
import { join } from "path";

const DATA_DIR = join(import.meta.dir, "..", "data");

// ── 타입 ──

export interface AgentStats {
  sessionsCount: number;
  tasksCompleted: number;
  tasksTotal: number;
  firstPassApprovals: number;    // revision 없이 바로 done
  totalReviews: number;          // 리뷰 받은 횟수
  totalRevisions: number;        // revision 당한 횟수
}

export interface Agent {
  id: string;
  role: string;
  project: string | null;
  memory: Record<string, unknown>;
  online: boolean;
  lastSeen: string;
  createdAt: string;
  // 하니스 성장 필드
  level: 1 | 2 | 3 | 4;
  stats: AgentStats;
  harnessVersion: string | null;  // "coder:v3" 형태
  persona: string | null;
}

export interface Message {
  id: string;
  from: string;
  to: string | "all";
  content: string;
  timestamp: string;
  project: string | null;
}

export type TaskStage = "backlog" | "research" | "spec" | "implement" | "review" | "qa" | "audit" | "revision" | "done";

export type ReviewCategory = "bug" | "style" | "architecture" | "missing-test" | "performance" | "spec-mismatch" | "test-failure" | "regression" | "build-failure" | "type-error" | "lint-error" | "other";

export interface TaskHistoryEntry {
  from: string;
  to: string;
  by: string;
  reason?: string;
  category?: ReviewCategory;
  harnessVersion?: string;
  timestamp: string;
}

export type PipelineType = "feature" | "bugfix" | "audit" | "refactor" | "research" | "design";

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
  pipeline?: PipelineType;
  dependsOn?: string[];
  branch?: string;
  lastCommit?: string;
  history?: TaskHistoryEntry[];
}

// ── 스테이지 머신 ──

// 파이프라인별 스테이지 순서 (backlog는 공통 시작점, 명시하지 않음)
export const PIPELINES: Record<PipelineType, TaskStage[]> = {
  feature:  ["backlog", "research", "spec", "implement", "review", "qa", "done"],
  bugfix:   ["backlog", "implement", "review", "qa", "done"],
  audit:    ["backlog", "audit", "implement", "review", "qa", "done"],
  refactor: ["backlog", "spec", "implement", "review", "done"],
  research: ["backlog", "research", "done"],
  design:   ["backlog", "spec", "implement", "review", "done"],
};

// 기본 파이프라인 (pipeline 미지정 태스크용)
const DEFAULT_PIPELINE: PipelineType = "feature";

// 레거시 호환: 단일 STAGE_FLOW (pipeline 미지정 시 fallback)
export const STAGE_FLOW: Partial<Record<TaskStage, TaskStage>> = {
  backlog: "research",
  research: "spec",
  spec: "implement",
  implement: "review",
  review: "qa",
  qa: "done",
  audit: "implement",
  revision: "review",
};

export const STAGE_ROLE_MAP: Partial<Record<TaskStage, string>> = {
  backlog: "pm",
  research: "researcher",
  spec: "architect",
  implement: "coder",
  review: "reviewer",
  qa: "qa",
  audit: "auditor",
};

// 파이프라인에서 다음 스테이지 결정
function getNextStage(currentStage: TaskStage, pipeline: PipelineType): TaskStage | null {
  if (currentStage === "revision") return "review";
  const stages = PIPELINES[pipeline];
  const idx = stages.indexOf(currentStage);
  if (idx === -1 || idx >= stages.length - 1) return null;
  return stages[idx + 1];
}

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
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tmp, path);
}

// ── 이벤트 로그 ──

export type EventType =
  | "agent-registered"
  | "agent-offline"
  | "agent-spawned"
  | "agent-stopped"
  | "task-created"
  | "task-stage-advanced"
  | "task-revision"
  | "task-updated"
  | "build-locked"
  | "build-unlocked"
  | "review-approved"    // advance from review → done
  | "review-rejected";   // revision from review

export interface HubEvent {
  id: string;
  type: EventType;
  timestamp: string;
  agentId: string | null;
  project: string | null;
  harnessVersion: string | null;
  data: Record<string, unknown>;
}

const EVENTS_DIR = join(DATA_DIR, "events");
ensureDir(EVENTS_DIR);

function eventTodayFile(): string {
  const d = new Date().toISOString().slice(0, 10);
  return join(EVENTS_DIR, `${d}.json`);
}

export function logEvent(
  type: EventType,
  agentId: string | null,
  project: string | null,
  data: Record<string, unknown> = {}
): HubEvent {
  const agent = agentId ? getAgent(agentId) : null;
  const event: HubEvent = {
    id: crypto.randomUUID().slice(0, 8),
    type,
    timestamp: new Date().toISOString(),
    agentId,
    project,
    harnessVersion: agent?.harnessVersion ?? null,
    data,
  };
  const path = eventTodayFile();
  const events = readJson<HubEvent[]>(path, []);
  events.push(event);
  writeJson(path, events);
  return event;
}

export function getEvents(days = 7): HubEvent[] {
  ensureDir(EVENTS_DIR);
  const files = readdirSync(EVENTS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse()
    .slice(0, days);

  const all: HubEvent[] = [];
  for (const f of files) {
    const events = readJson<HubEvent[]>(join(EVENTS_DIR, f), []);
    all.push(...events);
  }
  return all;
}

// ── 에이전트 ──

const AGENTS_DIR = join(DATA_DIR, "agents");
ensureDir(AGENTS_DIR);

const DEFAULT_STATS: AgentStats = {
  sessionsCount: 0,
  tasksCompleted: 0,
  tasksTotal: 0,
  firstPassApprovals: 0,
  totalReviews: 0,
  totalRevisions: 0,
};

export function getAgent(id: string): Agent | null {
  const path = join(AGENTS_DIR, `${id}.json`);
  const raw = readJson<any>(path, null);
  if (!raw) return null;
  // 기존 데이터 마이그레이션: 새 필드가 없으면 기본값
  return {
    ...raw,
    level: raw.level ?? 1,
    stats: raw.stats ?? { ...DEFAULT_STATS },
    harnessVersion: raw.harnessVersion ?? null,
    persona: raw.persona ?? null,
  } as Agent;
}

export function saveAgent(agent: Agent) {
  const path = join(AGENTS_DIR, `${agent.id}.json`);
  writeJson(path, agent);
}

export function listAgents(): Agent[] {
  ensureDir(AGENTS_DIR);
  return readdirSync(AGENTS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const raw = readJson<any>(join(AGENTS_DIR, f), null);
      if (!raw) return null;
      return {
        ...raw,
        level: raw.level ?? 1,
        stats: raw.stats ?? { ...DEFAULT_STATS },
        harnessVersion: raw.harnessVersion ?? null,
        persona: raw.persona ?? null,
      } as Agent;
    })
    .filter((a): a is Agent => a !== null);
}

export function registerAgent(
  id: string,
  role: string,
  project: string | null,
  opts?: { harnessVersion?: string; persona?: string }
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
    // 성장 필드: 기존 값 유지 또는 초기화
    level: existing?.level ?? 1,
    stats: existing?.stats ?? { ...DEFAULT_STATS },
    harnessVersion: opts?.harnessVersion ?? existing?.harnessVersion ?? null,
    persona: opts?.persona ?? existing?.persona ?? null,
  };
  // 세션 카운트 증가
  agent.stats.sessionsCount += 1;
  saveAgent(agent);
  logEvent("agent-registered", id, project, { role, harnessVersion: agent.harnessVersion });
  return agent;
}

export function updateAgentStats(id: string, updates: Partial<AgentStats>) {
  const agent = getAgent(id);
  if (!agent) return;
  Object.assign(agent.stats, updates);
  saveAgent(agent);
}

export function setAgentLevel(id: string, level: 1 | 2 | 3 | 4) {
  const agent = getAgent(id);
  if (!agent) return;
  agent.level = level;
  saveAgent(agent);
}

export function setAgentOffline(id: string) {
  const agent = getAgent(id);
  if (agent) {
    agent.online = false;
    agent.lastSeen = new Date().toISOString();
    saveAgent(agent);
    logEvent("agent-offline", id, agent.project);
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
  project: string | null,
  pipeline?: PipelineType
): Task {
  const tasks = getTasks();
  const task: Task = {
    id: crypto.randomUUID().slice(0, 8),
    title,
    description,
    status: "todo",
    stage: "backlog",
    pipeline: pipeline ?? "feature",
    assignee: null,
    project,
    createdBy,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  tasks.push(task);
  saveTasks(tasks);
  logEvent("task-created", createdBy, project, { taskId: task.id, title });
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
  const pipeline = task.pipeline ?? DEFAULT_PIPELINE;

  const nextStage = getNextStage(currentStage, pipeline);
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

  if (updated) {
    logEvent("task-stage-advanced", by, updated.project, {
      taskId: id,
      from: currentStage,
      to: nextStage,
      nextRole,
    });

    // review → done = 승인. 에이전트 통계 업데이트
    if (nextStage === "done") {
      const coder = findTaskCoder(updated);
      if (coder) {
        const agent = getAgent(coder);
        if (agent) {
          agent.stats.tasksCompleted += 1;
          agent.stats.totalReviews += 1;
          // revision 이력 없으면 first-pass approval
          const hadRevision = updated.history?.some((h) => h.to === "revision");
          if (!hadRevision) {
            agent.stats.firstPassApprovals += 1;
          }
          saveAgent(agent);
        }
      }
      logEvent("review-approved", by, updated.project, { taskId: id });
    }
  }

  return updated
    ? { success: true, task: updated, nextRole }
    : { success: false, error: "not_found" };
}

// 태스크에서 마지막 implement 스테이지를 담당한 에이전트 찾기
function findTaskCoder(task: Task): string | null {
  if (!task.history) return null;
  // 역순으로 implement 스테이지 진입 기록 찾기
  for (let i = task.history.length - 1; i >= 0; i--) {
    const h = task.history[i];
    if (h.to === "implement") return h.by;
  }
  return null;
}

export type RevisionResult =
  | { success: true; task: Task; nextRole: string }
  | { success: false; error: "not_found" | "invalid_stage" };

export function revisionTask(
  id: string,
  by: string,
  reason: string,
  category?: ReviewCategory
): RevisionResult {
  const task = getTaskById(id);
  if (!task) return { success: false, error: "not_found" };

  if (task.stage !== "review" && task.stage !== "qa") {
    return { success: false, error: "invalid_stage" };
  }

  const historyEntry: TaskHistoryEntry = {
    from: task.stage,
    to: "revision",
    by,
    reason,
    category: category ?? "other",
    timestamp: new Date().toISOString(),
  };

  const history = [...(task.history ?? []), historyEntry];

  const updated = updateTask(id, {
    stage: "revision",
    status: "in-progress",
    history,
    assignee: null,
  });

  if (updated) {
    // coder의 revision 횟수 증가
    const coder = findTaskCoder(updated);
    if (coder) {
      const agent = getAgent(coder);
      if (agent) {
        agent.stats.totalRevisions += 1;
        agent.stats.totalReviews += 1;
        saveAgent(agent);
      }
    }

    logEvent("task-revision", by, updated.project, {
      taskId: id,
      reason,
      category: category ?? "other",
    });
    logEvent("review-rejected", by, updated.project, {
      taskId: id,
      reason,
      category: category ?? "other",
    });
  }

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
  logEvent("build-locked", agentId, null, { reason });
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
  logEvent("build-unlocked", null, null, { nextInQueue: next });
  return { released: true, nextInQueue: next, lock };
}

// ── 스코어카드 ──

export interface AgentScorecard {
  agentId: string;
  role: string;
  level: 1 | 2 | 3 | 4;
  levelLabel: string;
  harnessVersion: string | null;
  quality: {
    firstPassApprovalRate: number;  // 0~1
    avgRevisions: number;
  };
  efficiency: {
    sessionsCount: number;
    tasksCompleted: number;
    tasksTotal: number;
  };
  compliance: {
    totalReviews: number;
    totalRevisions: number;
    revisionCategories: Record<string, number>;
  };
  recentEvents: HubEvent[];
}

const LEVEL_LABELS: Record<number, string> = {
  1: "Apprentice",
  2: "Practitioner",
  3: "Specialist",
  4: "Master",
};

export function getAgentScorecard(agentId: string): AgentScorecard | null {
  const agent = getAgent(agentId);
  if (!agent) return null;

  const s = agent.stats;
  const approvalRate = s.totalReviews > 0 ? s.firstPassApprovals / s.totalReviews : 0;
  const avgRevisions = s.tasksCompleted > 0 ? s.totalRevisions / s.tasksCompleted : 0;

  // revision 카테고리 집계
  const events = getEvents(30);
  const revisionEvents = events.filter(
    (e) => e.type === "review-rejected" && e.data.taskId
  );

  // 이 에이전트가 코더였던 태스크의 revision 카테고리
  const tasks = getTasks();
  const agentTaskIds = new Set(
    tasks
      .filter((t) => t.history?.some((h) => h.to === "implement" && h.by === agentId))
      .map((t) => t.id)
  );

  const categories: Record<string, number> = {};
  for (const e of revisionEvents) {
    if (agentTaskIds.has(e.data.taskId as string)) {
      const cat = (e.data.category as string) ?? "other";
      categories[cat] = (categories[cat] ?? 0) + 1;
    }
  }

  // 최근 이벤트 (이 에이전트 관련)
  const recentEvents = events
    .filter((e) => e.agentId === agentId)
    .slice(0, 20);

  return {
    agentId,
    role: agent.role,
    level: agent.level,
    levelLabel: LEVEL_LABELS[agent.level] ?? "Unknown",
    harnessVersion: agent.harnessVersion,
    quality: {
      firstPassApprovalRate: Math.round(approvalRate * 100) / 100,
      avgRevisions: Math.round(avgRevisions * 100) / 100,
    },
    efficiency: {
      sessionsCount: s.sessionsCount,
      tasksCompleted: s.tasksCompleted,
      tasksTotal: s.tasksTotal,
    },
    compliance: {
      totalReviews: s.totalReviews,
      totalRevisions: s.totalRevisions,
      revisionCategories: categories,
    },
    recentEvents,
  };
}
