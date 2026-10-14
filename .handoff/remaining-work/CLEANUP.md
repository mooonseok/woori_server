# 완료 트리거와 임시 자료 파기

## 트리거

Codex/Claude는 각 W 작업 완료 후 status.json을 갱신하고 아래 상태 명령을 실행한다.
단일 W01 완료로 나머지 계획을 삭제하지 않는다. 해당 저장소 W01–W08이 모두 done이고
검증·상대 저장소 근거·유지할 결정 이관이 완료된 때에만 전체 정리를 수행할 수 있다.

```sh
node .handoff/remaining-work/lifecycle.mjs status
node .handoff/remaining-work/lifecycle.mjs cleanup
# 위 명령의 삭제 예정 목록을 확인한 뒤 명시적으로 적용
node .handoff/remaining-work/lifecycle.mjs cleanup --apply
```

기본 cleanup은 dry-run이다. 백그라운드 훅/타이머/단순한 ‘완료’ 문구로 삭제하지 않는다.
AGENTS.md의 임시 블록을 CLAUDE.md가 import하므로 두 도구에 같은 절차가 적용된다.
스크립트는 완료 기록 형식과 범위를 검증할 뿐 구현의 정확성을 자동으로 증명하지 않는다.
검사 통과/commit만으로 기능 완료를 자동 판정하지 않는다.

## 상태 작성

각 작업: status=done, evidence=[검사 명령·환경·날짜·결과],
implementationRefs=[해당 구현 commit/PR], peerEvidence=[상대 저장소 통합 결과].
모든 evidence는 실제 확인한 내용이며 비밀값을 포함하지 않는다.
전체 완료 후 permanentRefs에 유지할 실제 레포 경로를 기록한다(예: project.json, contracts/openapi.json, 관련 테스트).
pendingDecisions를 모두 해결하고 durableDecisionsMoved=true로 바꾼다.
최종 계약은 OpenAPI, 구현 범위·비공개 값이 없는 설정 안내는 project.json,
불변식과 회귀 방지는 코드·테스트·기존 지침에 남긴다. 새 장기 계획 MD는 기존 레포 밖 규칙을 따른다.

완료 근거를 먼저 커밋하여 Git에 보존하고 작업 트리를 깨끗하게 만든 뒤 정리한다.
커밋·push 권한은 해당 시점 요청을 따른다. 자동으로 커밋·push하지 않는다.
main/develop에서는 정리 명령이 차단되므로 전용 cleanup 브랜치를 만든다.

## 실제 삭제 범위

- `.handoff/remaining-work/` 안에 생성한 9개 파일(이 문서, 상태, 실행 도구/테스트 포함).
- AGENTS.md의 `WOORI_TEMP_HANDOFF_START/END` 사이 임시 안내만 제거.
- 이 폴더의 알 수 없는 파일/하위 폴더/심볼릭 링크, 미커밋 변경, 완료 누락이면 차단.
- 앱 소스, 영구 규칙, package.json, .env, DB, R2, 다른 폴더/브랜치는 수정하지 않음.
- 두 저장소 각각 실행한다. 한쪽 정리가 다른 저장소 파일을 자동 삭제하지 않는다.

정리 후 `git diff --check`, `pnpm policy:check`, diff 범위 확인 → 요청받은 경우 정리 커밋/PR.
이미 완료하고 정리한 작업을 새 미구현 작업으로 되돌리지 않는다.
Git 이력에는 문서가 남는다. ‘파기’는 현재 checkout에서 제거한다는 뜻이며 이력 삭제나 보안 소거가 아니다.
복원이 필요하면 삭제 직전 commit을 확인하고 해당 폴더 및 AGENTS 안내 블록만 복원한다.
환경/기능 변경을 함께 되돌리는 전체 reset은 사용하지 않는다.
