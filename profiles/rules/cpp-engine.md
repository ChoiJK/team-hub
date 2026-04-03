# Rules: C++ Engine (회사)

## 스택
- C++ / CMake / Vulkan / NVRHI
- 빌드 시간: 15~20분

## 빌드
- build_lock 반드시 사용 (동시 빌드 금지!)
- cmake initialize + 빌드 중에는 다른 에이전트 빌드 불가
- 빌드 실패해도 build_unlock 반드시 실행

## 코드 스타일
- 프로젝트 기존 스타일 따르기
- modern C++ (C++17+)
- RAII 패턴 준수

## 주의
- 빌드 중 테스트 불가 (15~20분 먹통)
- 빌드 대기 중에는 코드 분석/문서화 작업
