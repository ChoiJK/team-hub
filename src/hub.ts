/**
 * Team Hub — HTTP 서버
 * 대시보드 + REST API + 에이전트 간 메시지 라우팅
 */

import {
  listAgents,
  getAgent,
  registerAgent,
  getMessages,
  addMessage,
  getTasks,
  createTask,
  updateTask,
  getBuildLock,
  acquireBuildLock,
  releaseBuildLock,
  listMemory,
  storeMemory,
  setAgentOffline,
  advanceTaskStage,
  revisionTask,
  getTaskById,
  STAGE_ROLE_MAP,
  logEvent,
  getEvents,
  getAgentScorecard,
  type Message,
  type Task,
  type AdvanceResult,
  type RevisionResult,
} from "./store";

import { spawn, type ChildProcess } from "child_process";
import { existsSync, writeFileSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";

const PORT = 4000;
const ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

// ── 프로젝트 경로 설정 ──

const PROJECT_PATHS: Record<string, string> = {
  elt: "D:/Workspace/EnglishLearningToolkit",
};

// ── 에이전트 프로세스 관리 ──

interface AgentProcess {
  pid: number;
  process: ChildProcess;
  project: string;
  role: string;
  worktreePath: string;
  startedAt: string;
  logBuffer: string[];
}

const agentProcesses: Map<string, AgentProcess> = new Map();

function getProjectPath(project: string): string | null {
  return PROJECT_PATHS[project] ?? null;
}

async function setupWorktree(
  projectPath: string,
  agentId: string,
  opts?: { role?: string; persona?: string; project?: string; rules?: string }
): Promise<string> {
  const agentsDir = join(projectPath, "agents");
  const worktreePath = join(agentsDir, agentId);

  if (!existsSync(agentsDir)) {
    mkdirSync(agentsDir, { recursive: true });
  }

  if (!existsSync(worktreePath)) {
    const WORKTREE_TIMEOUT_MS = 30_000;

    // git worktree 생성 (타임아웃 30초)
    await new Promise<void>((resolve, reject) => {
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          proc.kill("SIGTERM");
          reject(new Error(`worktree setup timed out after ${WORKTREE_TIMEOUT_MS / 1000}s`));
        }
      }, WORKTREE_TIMEOUT_MS);

      const proc = spawn(
        "git",
        ["worktree", "add", `agents/${agentId}`, "-b", `agent/${agentId}`, "main"],
        { cwd: projectPath }
      );
      proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
      proc.on("error", (err) => {
        if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`worktree spawn error: ${err.message}`)); }
      });
      proc.on("close", (code) => {
        if (settled) return;
        if (code === 0) { settled = true; clearTimeout(timer); resolve(); return; }

        // 브랜치가 이미 있으면 -b 없이 재시도
        let retryStderr = "";
        const retry = spawn(
          "git",
          ["worktree", "add", `agents/${agentId}`, `agent/${agentId}`],
          { cwd: projectPath }
        );
        retry.stderr?.on("data", (d: Buffer) => { retryStderr += d.toString(); });
        retry.on("error", (err) => {
          if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`worktree retry spawn error: ${err.message}`)); }
        });
        retry.on("close", (c) => {
          if (settled) return;
          settled = true; clearTimeout(timer);
          c === 0 ? resolve() : reject(new Error(`worktree failed (code ${c}): ${retryStderr || stderr}`));
        });
      });
    });
  }

  // .mcp.json 생성 (항상 최신 설정으로 덮어쓰기)
  const mcpJsonPath = join(worktreePath, ".mcp.json");
  const mcpConfig = {
    mcpServers: {
      "team-hub": {
        command: "bun",
        args: ["run", join(import.meta.dir, "mcp-server.ts")],
        env: {
          AGENT_ID: agentId,
          AGENT_ROLE: opts?.role ?? agentId,
          AGENT_PERSONA: opts?.persona ?? "",
          PROJECT: opts?.project ?? "",
          PROJECT_RULES: opts?.rules ?? "",
          TEAM_HUB_URL: `http://127.0.0.1:${PORT}`,
        },
      },
    },
  };
  writeFileSync(mcpJsonPath, JSON.stringify(mcpConfig, null, 2), "utf-8");

  return worktreePath;
}

function spawnAgent(
  agentId: string,
  role: string,
  project: string,
  worktreePath: string,
  initialPrompt: string,
  opts?: { model?: string; persona?: string; rules?: string }
): AgentProcess {
  // claude 실행 인자 구성
  const claudeArgs = [
    "--permission-mode", "bypassPermissions",
    "--channels", "server:team-hub",
  ];
  if (opts?.model) {
    claudeArgs.push("--model", opts.model);
  }
  claudeArgs.push("-p", initialPrompt);

  // .bat 래퍼 생성 — 새 터미널 창에서 실행 + 종료 시 Hub 알림
  const batPath = join(worktreePath, `_run-${agentId}.bat`);
  const envLines = [
    `set AGENT_ID=${agentId}`,
    `set AGENT_ROLE=${role}`,
    `set AGENT_PERSONA=${opts?.persona ?? ""}`,
    `set PROJECT=${project}`,
    `set PROJECT_RULES=${opts?.rules ?? ""}`,
    `set TEAM_HUB_URL=http://127.0.0.1:${PORT}`,
  ];
  const batContent = [
    "@echo off",
    `title [${role}] ${agentId}`,
    `cd /d "${worktreePath.replace(/\//g, "\\")}"`,
    ...envLines,
    `claude ${claudeArgs.join(" ")}`,
    `echo.`,
    `echo === Agent ${agentId} exited ===`,
    `curl -s -X POST http://127.0.0.1:${PORT}/api/agents/offline -H "Content-Type: application/json" -d "{\\"id\\":\\"${agentId}\\"}" >nul 2>&1`,
  ].join("\r\n") + "\r\n";
  writeFileSync(batPath, batContent, "utf-8");

  // 새 터미널 창으로 실행
  const proc = spawn("cmd", ["/c", "start", `[${role}] ${agentId}`, "cmd", "/c", batPath], {
    cwd: worktreePath,
    stdio: "ignore",
    detached: true,
    env: process.env,
  });

  // detached 프로세스는 부모와 분리
  proc.unref();

  const agentProc: AgentProcess = {
    pid: proc.pid ?? 0,
    process: proc,
    project,
    role,
    worktreePath,
    startedAt: new Date().toISOString(),
    logBuffer: [`[${new Date().toISOString()}] Agent spawned in new terminal window`],
  };

  agentProcesses.set(agentId, agentProc);
  return agentProc;
}

function stopAgent(agentId: string): boolean {
  const agent = agentProcesses.get(agentId);
  if (!agent) return false;

  try {
    // 터미널 창의 claude 프로세스를 찾아서 종료
    // 윈도우 타이틀 기반 + taskkill
    const role = agent.role;
    const title = `[${role}] ${agentId}`;
    spawn("cmd", ["/c", `taskkill /F /FI "WINDOWTITLE eq ${title}"`], {
      stdio: "ignore",
      detached: true,
    }).unref();
  } catch {}

  agentProcesses.delete(agentId);
  setAgentOffline(agentId);
  return true;
}

// 자동 스폰: 역할에 맞는 online 에이전트가 없으면 스폰
async function ensureAgentForRole(
  project: string,
  role: string,
  task: Task
): Promise<void> {
  const agents = listAgents();
  const onlineAgent = agents.find(
    (a) => a.role === role && a.online && a.project === project
  );

  if (onlineAgent) {
    // online이면 알림만
    const msg = addMessage({
      from: "system",
      to: onlineAgent.id,
      content: `📋 새 태스크 할당: [${task.id}] ${task.title} (stage: ${task.stage})`,
      project,
    });
    pushToAgent(onlineAgent.id, msg);
    // assignee 업데이트
    updateTask(task.id, { assignee: onlineAgent.id });
    return;
  }

  // online 에이전트 없으면 자동 스폰
  const projectPath = getProjectPath(project);
  if (!projectPath) return;

  const agentId = `${role}-${project}`;
  try {
    const worktreePath = await setupWorktree(projectPath, agentId, { role, project });
    const initialPrompt = `CLAUDE.md를 읽고 task_my_tasks 도구로 할당된 태스크를 확인해. 태스크 [${task.id}] ${task.title}이(가) 할당되었으니 작업을 시작해.`;

    spawnAgent(agentId, role, project, worktreePath, initialPrompt, {});
    registerAgent(agentId, role, project, {});
    updateTask(task.id, { assignee: agentId });

    broadcastSSE("agent-spawned", { id: agentId, role, project });
    addMessage({
      from: "system",
      to: "all",
      content: `🤖 ${role} 에이전트 자동 스폰: ${agentId} (태스크: ${task.title})`,
      project,
    });
  } catch (e: any) {
    console.error(`Failed to auto-spawn agent ${agentId}:`, e.message);
    broadcastSSE("agent-spawn-failed", { id: agentId, role, project, error: e.message });
    addMessage({
      from: "system",
      to: "all",
      content: `❌ ${role} 에이전트 자동 스폰 실패: ${agentId} — ${e.message}`,
      project,
    });
  }
}

// ── 연결된 MCP 세션 추적 (메시지 푸시용) ──

const sseClients: Set<ReadableStreamDefaultController> = new Set();

function broadcastSSE(event: string, data: unknown) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const controller of sseClients) {
    try {
      controller.enqueue(new TextEncoder().encode(msg));
    } catch {
      sseClients.delete(controller);
    }
  }
}

// ── 메시지 큐 (MCP 세션이 폴링) ──

const messageQueues: Map<string, Message[]> = new Map();

export function pushToAgent(agentId: string, msg: Message) {
  const queue = messageQueues.get(agentId) ?? [];
  queue.push(msg);
  messageQueues.set(agentId, queue);
}

export function pollMessages(agentId: string): Message[] {
  const queue = messageQueues.get(agentId) ?? [];
  messageQueues.set(agentId, []);
  return queue;
}

// ── HTTP 서버 ──

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // CORS
    const headers = {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (method === "OPTIONS") return new Response(null, { headers });

    try {
      // ── SSE (대시보드 실시간) ──
      if (path === "/events") {
        const stream = new ReadableStream({
          start(controller) {
            sseClients.add(controller);
            // 연결 종료 시 정리는 broadcastSSE에서 에러 캐치로
          },
        });
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
            "Access-Control-Allow-Origin": "*",
          },
        });
      }

      // ── 에이전트 ──
      if (path === "/api/agents" && method === "GET") {
        return Response.json(listAgents(), { headers });
      }

      if (path === "/api/agents/register" && method === "POST") {
        const { id, role, project, harnessVersion, persona } = await req.json();
        const agent = registerAgent(id, role, project ?? null, {
          harnessVersion: harnessVersion ?? undefined,
          persona: persona ?? undefined,
        });
        broadcastSSE("agent-join", agent);
        return Response.json(agent, { headers });
      }

      if (path === "/api/agents/offline" && method === "POST") {
        const { id } = await req.json();
        setAgentOffline(id);
        broadcastSSE("agent-leave", { id });
        return Response.json({ ok: true }, { headers });
      }

      if (path.startsWith("/api/agents/") && path.endsWith("/memory") && method === "GET") {
        const id = path.split("/")[3];
        return Response.json(listMemory(id), { headers });
      }

      // GET /api/agents/:id/scorecard — 에이전트 스코어카드
      if (path.match(/^\/api\/agents\/[^/]+\/scorecard$/) && method === "GET") {
        const id = path.split("/")[3];
        const scorecard = getAgentScorecard(id);
        if (!scorecard) return Response.json({ error: "Agent not found" }, { status: 404, headers });
        return Response.json(scorecard, { headers });
      }

      // GET /api/events — 이벤트 로그 조회
      if (path === "/api/events" && method === "GET") {
        const days = parseInt(url.searchParams.get("days") ?? "7");
        const type = url.searchParams.get("type") ?? undefined;
        let events = getEvents(days);
        if (type) {
          events = events.filter((e) => e.type === type);
        }
        return Response.json(events, { headers });
      }

      // PUT /api/agents/:id/memory — 메모리 저장
      if (path.startsWith("/api/agents/") && path.endsWith("/memory") && method === "PUT") {
        const id = path.split("/")[3];
        const { key, value } = await req.json();
        if (!key) {
          return Response.json({ error: "key is required" }, { status: 400, headers });
        }
        storeMemory(id, key, value);
        return Response.json({ ok: true, key }, { headers });
      }

      // ── 메시지 ──
      if (path === "/api/messages" && method === "GET") {
        const project = url.searchParams.get("project") ?? undefined;
        const limit = parseInt(url.searchParams.get("limit") ?? "50");
        return Response.json(getMessages(limit, project), { headers });
      }

      if (path === "/api/messages/send" && method === "POST") {
        const { from, to, content, project } = await req.json();
        const msg = addMessage({ from, to: to ?? "all", content, project: project ?? null });

        // 특정 에이전트에게 푸시
        if (to && to !== "all") {
          pushToAgent(to, msg);
        } else {
          // 브로드캐스트
          for (const agent of listAgents()) {
            if (agent.id !== from && agent.online) {
              pushToAgent(agent.id, msg);
            }
          }
        }

        broadcastSSE("message", msg);
        return Response.json(msg, { headers });
      }

      // MCP 세션이 자기 메시지 폴링
      if (path.startsWith("/api/messages/poll/") && method === "GET") {
        const agentId = path.split("/")[4];
        return Response.json(pollMessages(agentId), { headers });
      }

      // ── 태스크 ──
      if (path === "/api/tasks" && method === "GET") {
        const project = url.searchParams.get("project") ?? undefined;
        return Response.json(getTasks(project), { headers });
      }

      if (path === "/api/tasks" && method === "POST") {
        const { title, description, createdBy, project } = await req.json();
        const task = createTask(title, description, createdBy, project ?? null);
        broadcastSSE("task-created", task);
        return Response.json(task, { headers });
      }

      // PUT /api/tasks/:id/advance — 스테이지 전환
      {
        const advanceMatch = path.match(/^\/api\/tasks\/([^/]+)\/advance$/);
        if (advanceMatch && method === "PUT") {
          const taskId = advanceMatch[1];
          const body = await req.json().catch(() => ({}));
          const by = (body as any).by ?? "system";

          const result = advanceTaskStage(taskId, by);
          if (!result.success) {
            const statusMap = {
              not_found: 404,
              already_done: 409,
              invalid_stage: 422,
            } as const;
            const messageMap = {
              not_found: "Task not found",
              already_done: "Task is already done",
              invalid_stage: "현재 스테이지에서는 advance할 수 없습니다",
            } as const;
            return Response.json(
              { error: messageMap[result.error] },
              { status: statusMap[result.error], headers }
            );
          }

          const { task, nextRole } = result;

          broadcastSSE("task-stage-changed", {
            task,
            nextRole,
          });

          if (task.project && task.stage !== "done") {
            await ensureAgentForRole(task.project, nextRole, task);
          }

          return Response.json({ task, nextRole }, { headers });
        }
      }

      // PUT /api/tasks/:id/revision — revision 전환
      {
        const revisionMatch = path.match(/^\/api\/tasks\/([^/]+)\/revision$/);
        if (revisionMatch && method === "PUT") {
          const taskId = revisionMatch[1];
          const { by, reason, category } = await req.json();

          if (!reason) {
            return Response.json(
              { error: "reason is required" },
              { status: 400, headers }
            );
          }

          const result = revisionTask(taskId, by ?? "system", reason, category);
          if (!result.success) {
            const statusMap = {
              not_found: 404,
              invalid_stage: 422,
            } as const;
            const messageMap = {
              not_found: "Task not found",
              invalid_stage: "revision은 review 스테이지에서만 가능합니다",
            } as const;
            return Response.json(
              { error: messageMap[result.error] },
              { status: statusMap[result.error], headers }
            );
          }

          const { task, nextRole } = result;

          broadcastSSE("task-stage-changed", {
            task,
            nextRole,
            revision: true,
            reason,
          });

          if (task.project) {
            await ensureAgentForRole(task.project, nextRole, task);
          }

          return Response.json({ task, nextRole }, { headers });
        }
      }

      // PUT /api/tasks/:id — 기존 태스크 업데이트 (하위 호환)
      if (path.match(/^\/api\/tasks\/[^/]+$/) && method === "PUT") {
        const id = path.split("/")[3];
        const updates = await req.json();
        const task = updateTask(id, updates);
        if (!task) return Response.json({ error: "Task not found" }, { status: 404, headers });
        broadcastSSE("task-updated", task);
        return Response.json(task, { headers });
      }

      // ── 빌드 잠금 ──
      if (path === "/api/build" && method === "GET") {
        return Response.json(getBuildLock(), { headers });
      }

      if (path === "/api/build/lock" && method === "POST") {
        const { agentId, reason } = await req.json();
        const result = acquireBuildLock(agentId, reason);

        if (result.success) {
          // 전체 에이전트에게 알림
          const lockMsg = addMessage({
            from: "system",
            to: "all",
            content: `🔒 ${agentId}이(가) 빌드를 시작합니다: ${reason}`,
            project: null,
          });
          for (const agent of listAgents()) {
            if (agent.id !== agentId && agent.online) {
              pushToAgent(agent.id, lockMsg);
            }
          }
          broadcastSSE("build-locked", result.lock);
        }

        return Response.json(result, { headers });
      }

      if (path === "/api/build/unlock" && method === "POST") {
        const result = releaseBuildLock();

        const unlockMsg = addMessage({
          from: "system",
          to: "all",
          content: `🔓 빌드 잠금 해제됨.${result.nextInQueue ? ` 다음: ${result.nextInQueue}` : ""}`,
          project: null,
        });

        for (const agent of listAgents()) {
          if (agent.online) pushToAgent(agent.id, unlockMsg);
        }

        // 대기열 다음 에이전트에게 특별 알림
        if (result.nextInQueue) {
          const nextMsg = addMessage({
            from: "system",
            to: result.nextInQueue,
            content: "🟢 빌드 잠금이 해제되었습니다. 이제 빌드를 시작할 수 있습니다.",
            project: null,
          });
          pushToAgent(result.nextInQueue, nextMsg);
        }

        broadcastSSE("build-unlocked", result);
        return Response.json(result, { headers });
      }

      // ── Agent Lifecycle ──

      // POST /api/teams/:project/agents/spawn
      {
        const spawnMatch = path.match(/^\/api\/teams\/([^/]+)\/agents\/spawn$/);
        if (spawnMatch && method === "POST") {
          const project = spawnMatch[1];
          const projectPath = getProjectPath(project);
          if (!projectPath) {
            return Response.json(
              { error: `Unknown project: ${project}` },
              { status: 400, headers }
            );
          }

          const { agentId, role, model, persona, rules, initialPrompt } = await req.json();
          if (!agentId || !role) {
            return Response.json(
              { error: "agentId and role are required" },
              { status: 400, headers }
            );
          }

          if (!ID_PATTERN.test(agentId) || !ID_PATTERN.test(role) || !ID_PATTERN.test(project)) {
            return Response.json(
              { error: "agentId, role, project must match /^[a-zA-Z0-9_-]+$/" },
              { status: 400, headers }
            );
          }

          // 이미 실행 중이면 에러
          if (agentProcesses.has(agentId)) {
            return Response.json(
              { error: `Agent ${agentId} is already running` },
              { status: 409, headers }
            );
          }

          const worktreePath = await setupWorktree(projectPath, agentId, { role, persona, project, rules });
          const prompt =
            initialPrompt ??
            "CLAUDE.md를 읽고 task_list로 태스크를 확인해. 할당된 태스크가 있으면 작업 시작해.";

          const agentProc = spawnAgent(agentId, role, project, worktreePath, prompt, { model, persona, rules });
          const agent = registerAgent(agentId, role, project, {
            harnessVersion: undefined,  // mcp-server가 등록 시 자동 설정
            persona: persona ?? undefined,
          });

          logEvent("agent-spawned", agentId, project, { role, pid: agentProc.pid, worktreePath });
          broadcastSSE("agent-spawned", { ...agent, pid: agentProc.pid, worktreePath });

          addMessage({
            from: "system",
            to: "all",
            content: `🤖 ${role} 에이전트 스폰: ${agentId} (PID: ${agentProc.pid})`,
            project,
          });

          return Response.json(
            {
              ok: true,
              agent,
              pid: agentProc.pid,
              worktreePath,
            },
            { headers }
          );
        }
      }

      // POST /api/teams/:project/agents/:id/stop
      {
        const stopMatch = path.match(/^\/api\/teams\/([^/]+)\/agents\/([^/]+)\/stop$/);
        if (stopMatch && method === "POST") {
          const [, project, agentId] = stopMatch;

    const stopped = stopAgent(agentId);
          logEvent("agent-stopped", agentId, project, {});
          if (!stopped) {
            return Response.json(
              { error: `Agent ${agentId} is not running` },
              { status: 404, headers }
            );
          }

          broadcastSSE("agent-stopped", { id: agentId, project });

          addMessage({
            from: "system",
            to: "all",
            content: `🛑 에이전트 중지: ${agentId}`,
            project,
          });

          return Response.json({ ok: true, id: agentId }, { headers });
        }
      }

      // GET /api/teams/:project/agents
      {
        const listMatch = path.match(/^\/api\/teams\/([^/]+)\/agents$/);
        if (listMatch && method === "GET") {
          const project = listMatch[1];
          const agents = listAgents().filter((a) => a.project === project);
          const enriched = agents.map((a) => {
            const proc = agentProcesses.get(a.id);
            return {
              ...a,
              pid: proc?.pid ?? null,
              worktreePath: proc?.worktreePath ?? null,
              startedAt: proc?.startedAt ?? null,
            };
          });
          return Response.json(enriched, { headers });
        }
      }

      // GET /api/teams/:project/agents/:id/logs
      {
        const logsMatch = path.match(/^\/api\/teams\/([^/]+)\/agents\/([^/]+)\/logs$/);
        if (logsMatch && method === "GET") {
          const [, , agentId] = logsMatch;
          const proc = agentProcesses.get(agentId);
          if (!proc) {
            return Response.json({ error: "Agent not running" }, { status: 404, headers });
          }
          return Response.json({ logs: proc.logBuffer }, { headers });
        }
      }

      // ── 대시보드 ──
      if (path === "/" && method === "GET") {
        return new Response(DASHBOARD_HTML, {
          headers: { "Content-Type": "text/html", "Access-Control-Allow-Origin": "*" },
        });
      }

      return Response.json({ error: "Not found" }, { status: 404, headers });
    } catch (e: any) {
      return Response.json({ error: e.message }, { status: 500, headers });
    }
  },
});

console.log(`🌐 Team Hub running on http://127.0.0.1:${PORT}`);

// ── Graceful Shutdown ──

function shutdown() {
  console.log("\n🛑 Team Hub 종료 중...");
  for (const [id, proc] of agentProcesses) {
    console.log(`  stopping ${id} (PID: ${proc.pid})`);
    try { proc.process.kill("SIGTERM"); } catch {}
    setAgentOffline(id);
  }
  agentProcesses.clear();
  console.log("👋 Team Hub 종료 완료");
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ── 대시보드 HTML ──

const DASHBOARD_HTML = readFileSync(join(import.meta.dir, "dashboard.html"), "utf-8");

// Old inline HTML removed — now loaded from dashboard.html
const _OLD_INLINE_HTML = `<!DOCTYPE html>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f1117;color:#e1e4e8;min-height:100vh}
.header{background:#161b22;border-bottom:1px solid #30363d;padding:16px 24px;display:flex;justify-content:space-between;align-items:center}
.header h1{font-size:20px}
.container{max-width:1200px;margin:0 auto;padding:24px;display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(max-width:768px){.container{grid-template-columns:1fr}}
.panel{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:16px}
.panel h2{font-size:14px;color:#8b949e;margin-bottom:12px;text-transform:uppercase;letter-spacing:1px}
.agent-card{display:flex;align-items:center;gap:8px;padding:8px;border-radius:8px;margin-bottom:6px;background:#0d1117}
.agent-dot{width:8px;height:8px;border-radius:50%}
.agent-dot.online{background:#3fb950}
.agent-dot.offline{background:#6e7681}
.agent-role{font-size:12px;color:#8b949e;background:#21262d;padding:2px 6px;border-radius:4px}
.agent-project{font-size:11px;color:#58a6ff}
.msg{padding:8px;border-radius:8px;margin-bottom:6px;background:#0d1117;font-size:13px}
.msg .from{color:#58a6ff;font-weight:600}
.msg .time{color:#6e7681;font-size:11px;float:right}
.msg .content{margin-top:4px;line-height:1.4}
.msg.system{border-left:3px solid #e3b341}
.task{padding:8px;border-radius:8px;margin-bottom:6px;background:#0d1117}
.task .title{font-size:14px;font-weight:600}
.task .meta{font-size:12px;color:#8b949e;margin-top:4px}
.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600}
.badge.todo{background:#3d2e00;color:#e3b341}
.badge.in-progress{background:#0c2d6b;color:#58a6ff}
.badge.done{background:#0d3117;color:#3fb950}
.build-status{padding:12px;border-radius:8px;text-align:center;font-size:14px}
.build-status.locked{background:#3d1114;color:#f85149;border:1px solid #f8514966}
.build-status.free{background:#0d3117;color:#3fb950;border:1px solid #3fb95066}
.empty{color:#6e7681;font-size:13px;text-align:center;padding:20px}
</style>
</head>
<body>
<div class="header">
<h1>🤝 Team Hub</h1>
<span style="color:#8b949e;font-size:13px" id="status">연결 중...</span>
</div>
<div class="container">
<div class="panel" style="grid-column:1/-1">
<h2>🔨 빌드 상태</h2>
<div id="build"></div>
</div>
<div class="panel">
<h2>👥 팀원</h2>
<div id="agents"></div>
</div>
<div class="panel">
<h2>📋 태스크</h2>
<div id="tasks"></div>
</div>
<div class="panel" style="grid-column:1/-1">
<h2>💬 메시지</h2>
<div id="messages" style="max-height:400px;overflow-y:auto"></div>
</div>
</div>
<script>
// base URL 자동 감지 — /hub 경로에서도 동작하도록
var B=(function(){var p=location.pathname;if(p.endsWith('/'))p=p.slice(0,-1);return p})();
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}

async function load(){
  try{
    const[agents,messages,tasks,build]=await Promise.all([
      fetch(B+'/api/agents').then(r=>r.json()),
      fetch(B+'/api/messages?limit=30').then(r=>r.json()),
      fetch(B+'/api/tasks').then(r=>r.json()),
      fetch(B+'/api/build').then(r=>r.json())
    ]);
    renderAgents(agents);
    renderMessages(messages);
    renderTasks(tasks);
    renderBuild(build);
    document.getElementById('status').textContent='실시간';
  }catch(e){document.getElementById('status').textContent='오프라인'}
}

function renderAgents(agents){
  const el=document.getElementById('agents');
  if(!agents.length){el.innerHTML='<div class="empty">접속 중인 팀원 없음</div>';return}
  el.innerHTML=agents.map(a=>
    '<div class="agent-card">'+
    '<span class="agent-dot '+(a.online?'online':'offline')+'"></span>'+
    '<strong>'+esc(a.id)+'</strong>'+
    '<span class="agent-role">'+esc(a.role)+'</span>'+
    (a.project?'<span class="agent-project">'+esc(a.project)+'</span>':'')+
    '</div>'
  ).join('');
}

function renderMessages(msgs){
  const el=document.getElementById('messages');
  if(!msgs.length){el.innerHTML='<div class="empty">메시지 없음</div>';return}
  el.innerHTML=msgs.map(m=>{
    const cls=m.from==='system'?'msg system':'msg';
    const time=new Date(m.timestamp).toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'});
    return '<div class="'+cls+'">'+
      '<span class="from">'+esc(m.from)+'</span>'+
      (m.to!=='all'?' → <span style="color:#3fb950">'+esc(m.to)+'</span>':'')+
      '<span class="time">'+time+'</span>'+
      '<div class="content">'+esc(m.content)+'</div></div>';
  }).join('');
  el.scrollTop=el.scrollHeight;
}

function renderTasks(tasks){
  const el=document.getElementById('tasks');
  if(!tasks.length){el.innerHTML='<div class="empty">태스크 없음</div>';return}
  el.innerHTML=tasks.map(t=>{
    var display=t.stage||t.status;
    return '<div class="task">'+
    '<span class="badge '+esc(t.status)+'">'+esc(display)+'</span> '+
    '<span class="title">'+esc(t.title)+'</span>'+
    '<div class="meta">'+esc(t.assignee||'미할당')+' · '+esc(t.createdBy)+'</div></div>';
  }).join('');
}

function renderBuild(b){
  const el=document.getElementById('build');
  if(b.locked){
    const mins=Math.round((Date.now()-new Date(b.lockedAt).getTime())/60000);
    el.innerHTML='<div class="build-status locked">🔒 '+esc(b.lockedBy)+' 빌드 중 ('+mins+'분 경과) — '+esc(b.reason)+
      (b.queue.length?' · 대기: '+esc(b.queue.join(', ')):'')+
    '</div>';
  }else{
    el.innerHTML='<div class="build-status free">🟢 빌드 가능</div>';
  }
}

// SSE 실시간
const es=new EventSource(B+'/events');
es.onmessage=()=>load();
es.addEventListener('message',()=>load());
es.addEventListener('agent-join',()=>load());
es.addEventListener('build-locked',()=>load());
es.addEventListener('build-unlocked',()=>load());
es.addEventListener('task-created',()=>load());
es.addEventListener('task-updated',()=>load());
es.addEventListener('task-stage-changed',()=>load());
es.addEventListener('agent-spawned',()=>load());
es.addEventListener('agent-stopped',()=>load());
es.addEventListener('agent-spawn-failed',()=>load());

load();
setInterval(load,10000);
</script>
</body>
</html>`;
