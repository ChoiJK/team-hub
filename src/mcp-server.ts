#!/usr/bin/env bun
/**
 * Team Hub MCP Channel Server
 * 각 Claude Code 세션에서 --channels로 연결하는 MCP 서버
 *
 * 기능:
 * - 에이전트 등록 (역할 + 프로젝트 독립 메모리)
 * - 팀원 간 메시지 전달
 * - 빌드 잠금/해제
 * - 태스크 관리
 * - 메모리 저장/조회
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { readFileSync } from "fs";
import { join } from "path";

const HUB_URL = process.env.TEAM_HUB_URL ?? "http://127.0.0.1:4000";
const AGENT_ID = process.env.AGENT_ID ?? `agent-${Date.now().toString(36)}`;
const AGENT_ROLE = process.env.AGENT_ROLE ?? "general";
const AGENT_PERSONA = process.env.AGENT_PERSONA ?? "";
const PROJECT = process.env.PROJECT ?? null;
const PROJECT_RULES = process.env.PROJECT_RULES ?? "";

// ── 프로필 3슬롯 로드 ──

function loadFile(path: string): string {
  try { return readFileSync(path, "utf-8"); } catch { return ""; }
}

function loadProfile(): string {
  const profilesDir = join(import.meta.dir, "..", "profiles");

  // Slot 1: Persona (성격, 말투, 가치관)
  const persona = AGENT_PERSONA
    ? loadFile(join(profilesDir, "personas", `${AGENT_PERSONA}.md`))
    : "";

  // Slot 2: Role (직무, 책임, 워크플로우)
  const role = loadFile(join(profilesDir, "roles", `${AGENT_ROLE}.md`));

  // Slot 3: Rules (프로젝트/환경별 규칙)
  const defaultRules = loadFile(join(profilesDir, "rules", "default.md"));
  const projectRules = PROJECT_RULES
    ? loadFile(join(profilesDir, "rules", `${PROJECT_RULES}.md`))
    : "";

  // 조합
  const sections = [
    `# Agent Profile: ${AGENT_ID}`,
    `역할: ${AGENT_ROLE} | 프로젝트: ${PROJECT ?? "(없음)"}`,
    "",
    persona ? `---\n${persona}` : "",
    role ? `---\n${role}` : "",
    defaultRules ? `---\n${defaultRules}` : "",
    projectRules ? `---\n${projectRules}` : "",
    "",
    "---",
    "",
    "# Team Hub 도구",
    "- team_send / team_broadcast / team_members / team_history",
    "- build_lock / build_unlock / build_status",
    "- task_create / task_list / task_update",
    "- memory_store / memory_retrieve / memory_list",
    "",
    "팀원 메시지: <channel source=\"team-hub\" from=\"...\" type=\"message\">",
    "시스템 알림: <channel source=\"team-hub\" from=\"system\">",
  ].filter(Boolean).join("\n");

  return sections;
}

// ── 역할별 도구 접근 제어 ──

const ROLE_TOOLS: Record<string, string[]> = {
  coder: [
    "team_send", "team_broadcast", "team_members", "team_history",
    "build_lock", "build_unlock", "build_status",
    "task_list", "task_update", "task_advance", "task_my_tasks",
    "memory_store", "memory_retrieve", "memory_list",
  ],
  reviewer: [
    "team_send", "team_broadcast", "team_members", "team_history",
    "build_status",
    "task_list", "task_update", "task_advance", "task_revision", "task_my_tasks",
    "memory_store", "memory_retrieve", "memory_list",
  ],
  researcher: [
    "team_send", "team_broadcast", "team_members", "team_history",
    "task_list", "task_update", "task_advance", "task_my_tasks",
    "memory_store", "memory_retrieve", "memory_list",
  ],
  pm: [
    "team_send", "team_broadcast", "team_members", "team_history",
    "build_status",
    "task_create", "task_list", "task_update", "task_advance", "task_my_tasks",
    "memory_store", "memory_retrieve", "memory_list",
  ],
  architect: [
    "team_send", "team_broadcast", "team_members", "team_history",
    "build_status",
    "task_list", "task_update", "task_advance", "task_my_tasks",
    "memory_store", "memory_retrieve", "memory_list",
  ],
  designer: [
    "team_send", "team_broadcast", "team_members", "team_history",
    "task_list", "task_update", "task_advance", "task_my_tasks",
    "memory_store", "memory_retrieve", "memory_list",
  ],
  prototyper: [
    "team_send", "team_broadcast", "team_members", "team_history",
    "build_lock", "build_unlock", "build_status",
    "task_list", "task_update", "task_advance", "task_my_tasks",
    "memory_store", "memory_retrieve", "memory_list",
  ],
  auditor: [
    "team_send", "team_broadcast", "team_members", "team_history",
    "build_status",
    "task_create", "task_list", "task_update", "task_advance", "task_my_tasks",
    "memory_store", "memory_retrieve", "memory_list",
  ],
  qa: [
    "team_send", "team_broadcast", "team_members", "team_history",
    "build_lock", "build_unlock", "build_status",
    "task_list", "task_update", "task_advance", "task_revision", "task_my_tasks",
    "memory_store", "memory_retrieve", "memory_list",
  ],
  "ux-researcher": [
    "team_send", "team_broadcast", "team_members", "team_history",
    "task_list", "task_update", "task_advance", "task_my_tasks",
    "memory_store", "memory_retrieve", "memory_list",
  ],
  "ux-strategist": [
    "team_send", "team_broadcast", "team_members", "team_history",
    "task_create", "task_list", "task_update", "task_advance", "task_my_tasks",
    "memory_store", "memory_retrieve", "memory_list",
  ],
};

// 허용된 도구인지 체크 (역할 미등록이면 전부 허용)
function isToolAllowed(toolName: string): boolean {
  const allowed = ROLE_TOOLS[AGENT_ROLE];
  if (!allowed) return true;  // 정의 안 된 역할은 전부 허용
  return allowed.includes(toolName);
}

// ── 하니스 버전 추출 ──

function extractHarnessVersion(): string | null {
  const profilesDir = join(import.meta.dir, "..", "profiles");
  const rolePath = join(profilesDir, "roles", `${AGENT_ROLE}.md`);
  try {
    const content = readFileSync(rolePath, "utf-8");
    const match = content.match(/^version:\s*(\S+)/m);
    return match ? `${AGENT_ROLE}:${match[1]}` : null;
  } catch { return null; }
}

const HARNESS_VERSION = extractHarnessVersion();

// ── HTTP 헬퍼 ──

async function hubFetch(path: string, options?: RequestInit) {
  const res = await fetch(`${HUB_URL}${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  return res.json();
}

// ── MCP 서버 ──

const mcp = new Server(
  { name: "team-hub", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions: loadProfile(),
  }
);

// ── 도구 정의 ──

mcp.setRequestHandler(ListToolsRequestSchema, async () => {
  const allTools = [
    // 커뮤니케이션
    {
      name: "team_send",
      description: "특정 팀원에게 메시지 보내기",
      inputSchema: {
        type: "object" as const,
        properties: {
          to: { type: "string", description: "받는 사람 에이전트 ID" },
          content: { type: "string", description: "메시지 내용" },
        },
        required: ["to", "content"],
      },
    },
    {
      name: "team_broadcast",
      description: "모든 팀원에게 메시지 보내기",
      inputSchema: {
        type: "object" as const,
        properties: {
          content: { type: "string", description: "메시지 내용" },
        },
        required: ["content"],
      },
    },
    {
      name: "team_members",
      description: "현재 팀원 목록 보기",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "team_history",
      description: "최근 대화 히스토리",
      inputSchema: {
        type: "object" as const,
        properties: {
          limit: { type: "number", description: "가져올 메시지 수 (기본 20)" },
        },
      },
    },
    // 빌드 잠금
    {
      name: "build_lock",
      description: "빌드 잠금 획득 (다른 에이전트는 빌드 불가)",
      inputSchema: {
        type: "object" as const,
        properties: {
          reason: { type: "string", description: "빌드 사유" },
        },
        required: ["reason"],
      },
    },
    {
      name: "build_unlock",
      description: "빌드 잠금 해제",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "build_status",
      description: "현재 빌드 잠금 상태 확인",
      inputSchema: { type: "object" as const, properties: {} },
    },
    // 태스크
    {
      name: "task_create",
      description: "새 태스크 생성",
      inputSchema: {
        type: "object" as const,
        properties: {
          title: { type: "string", description: "태스크 제목" },
          description: { type: "string", description: "태스크 설명" },
        },
        required: ["title"],
      },
    },
    {
      name: "task_list",
      description: "태스크 목록 보기",
      inputSchema: { type: "object" as const, properties: {} },
    },
    {
      name: "task_update",
      description: "태스크 상태 변경",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "태스크 ID" },
          status: {
            type: "string",
            enum: ["todo", "in-progress", "done", "blocked"],
            description: "새 상태",
          },
          assignee: { type: "string", description: "담당자 변경 (선택)" },
        },
        required: ["id", "status"],
      },
    },
    // 스테이지 머신
    {
      name: "task_advance",
      description: "태스크를 다음 스테이지로 전환 (backlog→research→spec→implement→review→done). 다음 역할 에이전트에게 자동 알림/스폰.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "태스크 ID" },
        },
        required: ["id"],
      },
    },
    {
      name: "task_revision",
      description: "태스크를 revision 스테이지로 전환 (리뷰 반려). coder에게 자동 재할당.",
      inputSchema: {
        type: "object" as const,
        properties: {
          id: { type: "string", description: "태스크 ID" },
          reason: { type: "string", description: "반려 사유" },
          category: {
            type: "string",
            enum: ["bug", "style", "architecture", "missing-test", "performance", "spec-mismatch", "other"],
            description: "반려 분류 (bug/style/architecture/missing-test/performance/spec-mismatch/other)",
          },
        },
        required: ["id", "reason"],
      },
    },
    {
      name: "task_my_tasks",
      description: "현재 에이전트에게 할당된 태스크 목록",
      inputSchema: { type: "object" as const, properties: {} },
    },
    // 메모리
    {
      name: "memory_store",
      description: "메모리에 정보 저장 (프로젝트가 바뀌어도 유지됨)",
      inputSchema: {
        type: "object" as const,
        properties: {
          key: { type: "string", description: "키" },
          value: { type: "string", description: "값" },
        },
        required: ["key", "value"],
      },
    },
    {
      name: "memory_retrieve",
      description: "메모리에서 정보 조회",
      inputSchema: {
        type: "object" as const,
        properties: {
          key: { type: "string", description: "키" },
        },
        required: ["key"],
      },
    },
    {
      name: "memory_list",
      description: "저장된 메모리 전체 보기",
      inputSchema: { type: "object" as const, properties: {} },
    },
  ];

  return { tools: allTools.filter((t) => isToolAllowed(t.name)) };
});

// ── 도구 실행 ──

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  const a = args ?? {};

  // 역할별 접근 제어
  if (!isToolAllowed(name)) {
    return {
      content: [{
        type: "text",
        text: `⛔ ${AGENT_ROLE} 역할은 ${name} 도구를 사용할 수 없습니다.`,
      }],
    };
  }

  switch (name) {
    case "team_send": {
      if (!a.to || !a.content) {
        return { content: [{ type: "text", text: "❌ to, content 필수" }] };
      }
      await hubFetch("/api/messages/send", {
        method: "POST",
        body: JSON.stringify({
          from: AGENT_ID,
          to: a.to,
          content: a.content,
          project: PROJECT,
        }),
      });
      return { content: [{ type: "text", text: `✉️ ${a.to}에게 전송: ${a.content}` }] };
    }

    case "team_broadcast": {
      if (!a.content) {
        return { content: [{ type: "text", text: "❌ content 필수" }] };
      }
      await hubFetch("/api/messages/send", {
        method: "POST",
        body: JSON.stringify({
          from: AGENT_ID,
          to: "all",
          content: a.content,
          project: PROJECT,
        }),
      });
      return { content: [{ type: "text", text: `📢 전체 전송: ${a.content}` }] };
    }

    case "team_members": {
      const agents = await hubFetch("/api/agents");
      const list = agents
        .map((ag: any) => `${ag.online ? "🟢" : "⚫"} ${ag.id} (${ag.role})${ag.project ? ` [${ag.project}]` : ""}`)
        .join("\n");
      return { content: [{ type: "text", text: list || "팀원 없음" }] };
    }

    case "team_history": {
      const limit = a.limit ?? 20;
      const msgs = await hubFetch(`/api/messages?limit=${limit}`);
      const list = msgs
        .map((m: any) => `[${new Date(m.timestamp).toLocaleTimeString("ko-KR")}] ${m.from}→${m.to}: ${m.content}`)
        .join("\n");
      return { content: [{ type: "text", text: list || "메시지 없음" }] };
    }

    case "build_lock": {
      if (!a.reason) {
        return { content: [{ type: "text", text: "❌ reason 필수" }] };
      }
      const result = await hubFetch("/api/build/lock", {
        method: "POST",
        body: JSON.stringify({ agentId: AGENT_ID, reason: a.reason }),
      });
      if (result.success) {
        return { content: [{ type: "text", text: `🔒 빌드 잠금 획득 완료: ${a.reason}` }] };
      } else {
        const pos = result.lock.queue.indexOf(AGENT_ID) + 1;
        return {
          content: [{
            type: "text",
            text: `⏳ ${result.lock.lockedBy}이(가) 빌드 중 (${result.lock.reason}). 대기열 ${pos}번째.`,
          }],
        };
      }
    }

    case "build_unlock": {
      const result = await hubFetch("/api/build/unlock", { method: "POST" });
      return {
        content: [{
          type: "text",
          text: `🔓 빌드 잠금 해제.${result.nextInQueue ? ` 다음: ${result.nextInQueue}` : ""}`,
        }],
      };
    }

    case "build_status": {
      const lock = await hubFetch("/api/build");
      if (lock.locked) {
        const mins = Math.round((Date.now() - new Date(lock.lockedAt).getTime()) / 60000);
        return {
          content: [{
            type: "text",
            text: `🔒 빌드 중: ${lock.lockedBy} (${mins}분 경과, 사유: ${lock.reason})${lock.queue.length ? `\n대기열: ${lock.queue.join(", ")}` : ""}`,
          }],
        };
      }
      return { content: [{ type: "text", text: "🟢 빌드 가능 (잠금 없음)" }] };
    }

    case "task_create": {
      if (!a.title) {
        return { content: [{ type: "text", text: "❌ title 필수" }] };
      }
      const task = await hubFetch("/api/tasks", {
        method: "POST",
        body: JSON.stringify({
          title: a.title,
          description: a.description ?? "",
          createdBy: AGENT_ID,
          project: PROJECT,
        }),
      });
      return { content: [{ type: "text", text: `📋 태스크 생성: ${task.title} (${task.id})` }] };
    }

    case "task_list": {
      const tasks = await hubFetch("/api/tasks");
      const list = tasks
        .map((t: any) => `[${t.stage ?? t.status}] ${t.title} (${t.id}) — ${t.assignee ?? "미할당"}`)
        .join("\n");
      return { content: [{ type: "text", text: list || "태스크 없음" }] };
    }

    case "task_update": {
      if (!a.id || !a.status) {
        return { content: [{ type: "text", text: "❌ id, status 필수" }] };
      }
      const task = await hubFetch(`/api/tasks/${a.id}`, {
        method: "PUT",
        body: JSON.stringify({
          status: a.status,
          ...(a.assignee && { assignee: a.assignee }),
        }),
      });
      return { content: [{ type: "text", text: `📋 태스크 업데이트: ${task.title} → ${task.status}` }] };
    }

    case "task_advance": {
      if (!a.id) {
        return { content: [{ type: "text", text: "❌ id 필수" }] };
      }
      const result = await hubFetch(`/api/tasks/${a.id}/advance`, {
        method: "PUT",
        body: JSON.stringify({ by: AGENT_ID }),
      });
      if (result.error) {
        return { content: [{ type: "text", text: `❌ ${result.error}` }] };
      }
      return {
        content: [{
          type: "text",
          text: `⏭️ 태스크 "${result.task.title}" 스테이지 전환: ${result.task.stage} (다음 역할: ${result.nextRole})`,
        }],
      };
    }

    case "task_revision": {
      if (!a.id || !a.reason) {
        return { content: [{ type: "text", text: "❌ id, reason 필수" }] };
      }
      const result = await hubFetch(`/api/tasks/${a.id}/revision`, {
        method: "PUT",
        body: JSON.stringify({ by: AGENT_ID, reason: a.reason, category: a.category ?? "other" }),
      });
      if (result.error) {
        return { content: [{ type: "text", text: `❌ ${result.error}` }] };
      }
      return {
        content: [{
          type: "text",
          text: `🔄 태스크 "${result.task.title}" revision으로 전환 (사유: ${a.reason})`,
        }],
      };
    }

    case "task_my_tasks": {
      const tasks = await hubFetch(`/api/tasks`);
      const myTasks = tasks.filter((t: any) => t.assignee === AGENT_ID);
      if (!myTasks.length) {
        return { content: [{ type: "text", text: "📋 할당된 태스크 없음" }] };
      }
      const list = myTasks
        .map((t: any) => `[${t.stage ?? t.status}] ${t.title} (${t.id})`)
        .join("\n");
      return { content: [{ type: "text", text: `📋 내 태스크 (${myTasks.length}개):\n${list}` }] };
    }

    case "memory_store": {
      if (!a.key) {
        return { content: [{ type: "text", text: "❌ key 필수" }] };
      }
      await hubFetch(`/api/agents/${AGENT_ID}/memory`, {
        method: "PUT",
        body: JSON.stringify({ key: a.key, value: a.value }),
      });
      return { content: [{ type: "text", text: `💾 메모리 저장: ${a.key}` }] };
    }

    case "memory_retrieve": {
      if (!a.key) {
        return { content: [{ type: "text", text: "❌ key 필수" }] };
      }
      const memory = await hubFetch(`/api/agents/${AGENT_ID}/memory`);
      const value = memory[a.key as string];
      return { content: [{ type: "text", text: value ? `📖 ${a.key}: ${JSON.stringify(value)}` : `❌ "${a.key}" 없음` }] };
    }

    case "memory_list": {
      const memory = await hubFetch(`/api/agents/${AGENT_ID}/memory`);
      const entries = Object.entries(memory);
      const list = entries.map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`).join("\n");
      return { content: [{ type: "text", text: entries.length ? `💾 메모리 (${entries.length}개):\n${list}` : "메모리 비어있음" }] };
    }

    default:
      return { content: [{ type: "text", text: `알 수 없는 도구: ${name}` }] };
  }
});

// ── 에이전트 등록 + 메시지 폴링 루프 ──

async function init() {
  // Hub에 등록 (하니스 버전 + 페르소나 포함)
  await hubFetch("/api/agents/register", {
    method: "POST",
    body: JSON.stringify({
      id: AGENT_ID,
      role: AGENT_ROLE,
      project: PROJECT,
      harnessVersion: HARNESS_VERSION,
      persona: AGENT_PERSONA || null,
    }),
  });

  // 5초마다 메시지 폴링 → Claude Code 세션에 푸시
  setInterval(async () => {
    try {
      const msgs = await hubFetch(`/api/messages/poll/${AGENT_ID}`);
      for (const msg of msgs) {
        await mcp.notification({
          method: "notifications/claude/channel",
          params: {
            content: msg.content,
            meta: {
              from: msg.from,
              to: msg.to,
              type: "message",
              timestamp: msg.timestamp,
            },
          },
        });
      }
    } catch {
      // Hub 연결 실패 시 무시
    }
  }, 5000);
}

// ── 종료 처리 ──

async function cleanup() {
  try {
    await hubFetch("/api/agents/offline", {
      method: "POST",
      body: JSON.stringify({ id: AGENT_ID }),
    });
  } catch {}
  process.exit(0);
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
process.on("SIGHUP", cleanup);
// stdin 닫힘 = Claude Code 세션 종료
process.stdin.on("end", cleanup);
process.stdin.on("close", cleanup);

// ── 시작 ──

await mcp.connect(new StdioServerTransport());
await init();
