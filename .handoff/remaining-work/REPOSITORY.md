# 서버 구현 책임

## 현재 경로

- src/domain/auth: controller/service/repository, password, auth-rate-limit, mail.service.
- src/common/configurations/development-mail.ts: DEV_MAIL_DIR 기본값과 readiness 공통 검증.
- src/domain/groups, invitations: 그룹 생성/조회, 초대. 명단·탈퇴·이전 등 후속 필요.
- src/domain/photos, albums, notifications: 현재 그룹 권한·소유권·알림 원자성.
- src/common/push, src/domain/push, src/worker/push: 암호화 구독/발송/표시 재검증.
- src/worker/media-cleanup: 삭제 작업 재시도. 새 처리 큐도 worker 생명주기와 충돌하지 않게 통합.
- prisma/schema.prisma, prisma/migrations, prisma/runtime-grants.sql: DB 정본.
- contracts/openapi.json: 공개 계약. src/admin은 별도 관리자 구현 대상.

## 작업별 책임

W01: 복구 DTO/API·rate limit·token 용도 분리·메일·원자적 비밀번호/세션/푸시 폐기·이름 수정.
W02: membership/owner 트랜잭션과 마지막 소유자 제약, 삭제/업로드/푸시 경합, 그룹 R2 정리 큐.
W03: 날짜 출처 모델·그룹 범위 memories 조회/숨김·인덱스·백필 도구의 명시 실행.
W04: HEIC 디코더 검증·처리 job/lease/retry·quota 일관성·고아 대조 report-only.
W05: 이메일 변경 재확인·현재 비밀번호 검증·탈퇴 단계/콘텐츠 수명·공지/신고/차단 정책 API.
W06: 별도 admin audience/MFA/RBAC·재인증·감사로그·사유 기반 열람·관리 조치.
W07: 암호화 mail outbox·재시도/중복·관측·배포·migration/역할·DB/R2 백업 복원.
W08: 네이티브 인증/refresh rotation·FCM/APNs 구독·로그아웃/계정 전환·딥링크 계약.

## migration/메일 주의

스키마 파일과 migration 작성이 실제 적용을 의미하지 않는다. 적용한 migration은 수정하지 않는다.
API runtime 역할에 필요한 테이블/연산만 추가하고 negative test로 불필요한 접근을 확인한다.
새 복구 token을 기존 verify-email confirm에 넘겨도 소비되지 않아야 한다.
Resend는 기존 REST 어댑터를 확장한다. outbox 도입 전/후 전송 실패 의미를 명확히 하고
복구 요청 성공 UI가 실제 메일 도착을 보장한다고 표시하지 않는다.

## 검증

```sh
pnpm prisma:validate
pnpm typecheck
pnpm test
pnpm test:integration
pnpm format:check
node --test .handoff/remaining-work/lifecycle.test.mjs
```

기준선: 정책 18개, 단위 49개, 격리 DB 통합 37개 통과. 실제 메일/두 계정 Chrome 수신도 확인.
이는 직전 컴퓨터에서의 결과이며 새 환경에서는 재검증한다.
통합 runner는 로컬 parent를 확인 후 임시 woori_test_* DB만 생성·삭제한다.
실제 개발 DB·운영 DB에 reset/seed로 테스트하지 않는다.
