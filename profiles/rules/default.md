# Rules: Default

## 언어
- 문서/소통: 한국어
- 코드/커밋: 영어

## 보안
- 서버 바인딩: 127.0.0.1만 (0.0.0.0 금지)
- 비밀번호/API 키 하드코딩 금지
- .env 파일 커밋 금지

## 품질
- 커밋 전 lint/test 통과 필수
- PR 리뷰 없이 머지 금지

## Team Hub
- 빌드 전 build_status 확인 필수
- 빌드 후 build_unlock 반드시 실행
- 중요 결정은 memory_store로 저장
- 팀원에게 진행 상황 주기적으로 공유
