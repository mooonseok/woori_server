# 우리 — 남은 작업 인계

기준일: 2026-10-14. 인계 브랜치: `chore/remaining-work-handoff` (두 저장소 동일).
사용자가 이번 인계에 한해 레포 안의 임시 계획 문서와 커밋·push를 승인했다.
다른 계획 문서는 기존대로 레포 밖에 둔다. 이 자료는 현재 코드와 함께 버전 관리되는 임시 실행안이다.

## 현재 진행 상태

2026-10-15: W01 계정 복구·이름 수정은 머지 완료. W02 그룹 수명 관리 구현·검증 완료이며 현재 작업 브랜치는 `feature/group-management`다. W02 구현과 검증 자료는 이번 커밋에 포함하며 push는 별도 요청 전까지 하지 않는다. 다음 작업은 W03 촬영일·추억 홈이며, 구현 전 날짜/타임존·백필·숨김 정책을 확정한다. 검증 상세는 `status.json`을 따른다. 아래 초기 인계 순서는 최초 전달 시점의 참고 자료다.

## 집에서 시작

1. 두 저장소를 나란히 clone하거나 기존 저장소에서 `git fetch origin` 실행.
2. 처음 받는 브랜치: `git switch --track origin/chore/remaining-work-handoff`.
   이미 로컬에 있으면 `git switch chore/remaining-work-handoff` 후 `git pull --ff-only`.
   로컬 변경이 있으면 먼저 확인하며 reset/강제 checkout하지 않는다.
3. 각 저장소 `AGENTS.md` → 이 파일 → `SETUP.md` → `DESIGN.md` → `PLAN.md` → `REPOSITORY.md` 순서로 읽는다.
4. `node .handoff/remaining-work/lifecycle.mjs status`로 남은 작업 확인.
5. 새 기능은 인계 브랜치에서 `feature/account-recovery` 같은 별도 작업 브랜치로 분기한다.
   인계 브랜치가 develop에 머지된 이후에는 최신 develop에서 분기한다.
   인계 브랜치가 아직 머지되지 않았다면 기능 PR에 인계 커밋도 포함될 수 있으므로 PR 범위를 확인한다.
6. 시작 범위는 W01. 문서 전체가 모든 작업의 일괄 실행·배포·DB 변경 승인인 것은 아니다.
   현재 요청은 인계 자료의 커밋·push까지다. 향후 구현 커밋·push는 해당 작업의 사용자 요청을 따른다.

## 새 Codex / Claude에 붙여 넣기

> 두 저장소의 AGENTS.md와 .handoff/remaining-work/README.md를 읽고 남은 작업을 이어가자.
> 먼저 status.json과 실제 코드·Git 상태를 대조해서 W01의 현재 구현 여부를 확인해줘.
> REPOSITORY.md의 경계와 DESIGN.md의 제안/확정 구분을 지키고, 필요한 결정은 구현 전에 짚어줘.
> 이번 작업은 W01 범위로 진행하고 DB 적용은 대상·영향·복구 방법을 확인해줘.
> 검증 결과와 미확인 사항을 status.json에 갱신하고 커밋·push는 별도 요청 전까지 하지마.
> 일부 기능 완료만으로 전체 인계 자료를 삭제하지 말고 CLEANUP.md의 완료 트리거를 따라줘.

## 문서 역할

- `DESIGN.md`: 공통 제품·보안 설계 및 아직 결정해야 할 내용.
- `PLAN.md`: W01–W08 순서, 의존성, 완료 기준과 검증.
- `REPOSITORY.md`: 해당 저장소의 파일 경로, 구현 책임과 실행 명령.
- `SETUP.md`: 집 컴퓨터에서 환경 복구, 비밀값 전달, 실행·배포 준비.
- `status.json`: 해당 저장소 진행 상태와 완료 근거. 초기 상태는 전부 pending.
- `CLEANUP.md`: 전체 완료 시 임시 자료만 제거하는 트리거와 복원 방법.

## 기준선과 주의

- client develop `0f1c847`, server develop `678bf6c`: 웹 푸시 PR #7 머지.
- 가입/로그인/이메일 인증, 그룹 생성/초대, 앨범·R2 사진 관리, 댓글/위치 댓글/반응,
  알림함/설정, 웹 푸시 구현 완료. 실제 R2·Chrome 두 계정 푸시·Resend 인증 검증 완료.
- 이전 검사 결과는 이 컴퓨터의 기준선이다. 집에서 검사를 재실행해야 한다.
- 기존 외부 기획의 ‘구현 전’, ‘메일 미가입’, ‘API가 Next.js’ 등의 문구는 오래된 내용이다.
  현재 API는 NestJS이며 Resend 인증 검증이 끝났다. 실제 코드와 OpenAPI가 우선이다.
- 기존 `project.json`의 절대 문서 경로는 이 컴퓨터 전용이다. 집에서 그 경로를 만들 필요 없다.
  이 인계 자료는 상대 경로만으로 재개할 수 있게 작성했다.
- 이 브랜치는 인계 자료·정리 도구만 추가한다. 아래 제안 API·DB 모델은 아직 구현된 계약이 아니다.
