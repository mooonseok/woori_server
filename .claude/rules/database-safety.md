---
paths:
  - 'prisma/**'
  - 'scripts/**'
  - 'src/**'
  - 'integration/**'
---

런타임 DB 역할과 migration 역할을 분리한다. 적용한 migration 수정 대신 후속 migration을 추가한다.
DB 변경 전 대상 환경·영향·복구 계획을 확인한다. 사용자 요청 범위에 포함된 로컬 검증을 반복 승인 요청으로 방해하지 않는다.
초대 횟수·멤버십 갱신은 트랜잭션과 경쟁 조건으로 검증한다. 조회 제한·N+1·인덱스를 점검한다.
통합 테스트는 scripts/run-integration.mjs의 127.0.0.1:55439/woori_dev 부모 주소 제한과 임시 DB 생명주기를 유지한다.
테스트 실패를 피하려고 이 제한을 삭제하지 않는다. 운영/공유 DB에는 테스트·seed·reset을 실행하지 않는다.
