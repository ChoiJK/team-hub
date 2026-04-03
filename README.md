# Team Hub

Claude Code 세션 간 통신 허브. Channel MCP 기반.

## 구조

```
Team Hub Server (localhost:4000)  ← 대시보드 + REST API
  ↕ MCP (Channel)
Claude Code 세션 A (Architect)  ← 서로 메시지
Claude Code 세션 B (Coder)      ← 빌드 잠금
Claude Code 세션 C (Reviewer)   ← 태스크 공유
```

## 빠른 시작

```bash
# 1. 허브 서버 시작
bun run start
# → http://127.0.0.1:4000 에서 대시보드

# 2. Claude Code 세션 시작 (각 터미널에서)
AGENT_ID=architect AGENT_ROLE=architect \
  claude --channels server:team-hub \
  --dangerously-load-development-channels

# 3. 다른 터미널에서
AGENT_ID=coder AGENT_ROLE=coder \
  claude --channels server:team-hub \
  --dangerously-load-development-channels
```

## 환경변수

| 변수 | 설명 | 기본값 |
|------|------|--------|
| `AGENT_ID` | 에이전트 ID (프로젝트 독립) | `agent-{random}` |
| `AGENT_ROLE` | 역할 | `general` |
| `PROJECT` | 현재 프로젝트 | (없음) |
| `TEAM_HUB_URL` | 허브 서버 URL | `http://127.0.0.1:4000` |

## MCP 도구

### 커뮤니케이션
- `team_send` — 특정 팀원에게 메시지
- `team_broadcast` — 전체 메시지
- `team_members` — 팀원 목록
- `team_history` — 대화 히스토리

### 빌드 잠금
- `build_lock` — 빌드 잠금 획득
- `build_unlock` — 잠금 해제
- `build_status` — 현재 상태

### 태스크
- `task_create` — 태스크 생성
- `task_list` — 목록
- `task_update` — 상태 변경

### 메모리 (에이전트별, 프로젝트 독립)
- `memory_store` — 저장
- `memory_retrieve` — 조회
- `memory_list` — 전체 보기

## 에이전트 이동

같은 AGENT_ID로 다른 프로젝트에서 접속하면 메모리가 그대로 유지됨:

```bash
# ELT 프로젝트
AGENT_ID=designer AGENT_ROLE=designer PROJECT=elt \
  claude --channels server:team-hub ...

# 나중에 렌더링 프로젝트
AGENT_ID=designer AGENT_ROLE=designer PROJECT=rendering \
  claude --channels server:team-hub ...
# → 이전에 저장한 메모리(디자인 원칙 등) 그대로!
```

## 대시보드

http://127.0.0.1:4000 에서:
- 👥 팀원 현황 (온라인/오프라인)
- 💬 메시지 타임라인 (실시간)
- 📋 태스크 보드
- 🔨 빌드 잠금 상태
