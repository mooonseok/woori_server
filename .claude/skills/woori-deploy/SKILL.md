---
name: woori-deploy
description: 사용자가 요청한 배포의 사전 검사·호환 순서·상태 확인과 복구 절차를 수행한다.
disable-model-invocation: true
---

1. AWS Lightsail 서울 API/워커, Supabase Pro 서울 DB, 비공개 R2 중 실제 준비된 리소스와 요청된 변경 범위를 확인한다.
2. pnpm policy:quality를 통과하고 운영 비밀값은 저장소 밖 접근 제한 파일 또는 승인된 secret 저장소에 등록한다. DB runtime/migration 역할과 TLS, 정확한 HTTPS origin을 확인한다.
3. 스키마 변경은 백업·복구 경로와 구 API 호환성을 확인한 뒤 확장 migration부터 적용한다. 파괴적 변경을 자동 실행하지 않는다.
4. 승인된 운영 migration → 같은 커밋의 API·워커 배포 → readiness/오류율/메일·워커 상태 확인 → 클라이언트 전환 순서를 따른다.
   자동 경로는 main push의 .github/workflows/deploy.yml이며 DB 변경은 API 호스트가 계산한 계획(plan hash)을 production-migrations에서 승인한 뒤에만, 허용목록 밖 문장은 수동 절차로 넘긴다. 절차·일회성 설정은 deploy/lightsail/woori-deploy.sh·deploy-release.sh 머리 주석이 정본이다.
5. R2/워커/푸시는 현재 구현·권한·실행 경로가 준비된 범위만 배포한다. R2 공개 버킷을 만들지 않는다.
6. 실패 시 API/워커 이전 버전으로 복구한다. DB 역 migration을 자동 수행하지 않고 별도 검증한 복구 계획을 따른다.
7. 정상 로그인·그룹 권한·초대와 readiness를 확인하고 배포 revision 및 미검증 외부 기능을 보고한다.

출처: woori approved deployment architecture. 원본 절차를 프로젝트에 맞게 재작성했으며 프레임워크 구조/명명 규칙은 가져오지 않았다.
