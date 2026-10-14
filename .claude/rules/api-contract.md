---
paths:
  - '**/dto/**'
  - '**/services/**'
  - 'src/**'
  - 'contracts/**'
  - 'prisma/**'
---

공개 API 계약 정본은 woori_server/contracts/openapi.json이다. 저장소 간 소스 직접 import는 하지 않는다.
필드 optional/null, 오류 코드, 인증 요구사항, 페이지네이션 변화와 클라이언트 영향을 확인한다.
파괴적 변경은 소비자 전환 순서를 확인한다. 형식 검사는 실제 API 동작/권한 테스트를 대신하지 않는다.
변경 실행 순서는 woori-api-change 스킬을 읽는다.
