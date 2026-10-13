# 정책 실행 절차

- 담당: 저장소 유지관리자 박문석. 검사 정본: scripts/policy. 새 위반 예산/영구 예외 없음.
- 설치: nvm use; pnpm policy:install. 로컬 core.hooksPath=.githooks가 설정된다.
- Codex는 프로젝트 루트에서 열고 /hooks에서 신규 훅 정의를 검토·신뢰한다. 전역 훅은 변경하지 않는다.
- Claude Code는 프로젝트를 신뢰한 세션에서 /hooks로 등록을 확인한다. 설정 변경 후 세션을 재시작한다.
- 도구 훅은 Bash/exec_command/shell_command의 명확한 git 우회·강제 push·보호 ref·Prisma reset·volume 삭제 패턴을 차단한다.
- 임의 스크립트, 간접 API, 동적 셸 표현식 전체를 해석하지 않는다. 파서 오류는 차단하지만 프로세스 자체 장애/시간초과 시 도구 동작은 호스트에 따른다.
- Git 훅은 파일 경로와 인식 가능한 비밀키 패턴만 검사한다. 모든 비밀값 탐지를 보장하지 않는다. 값은 로그에 출력하지 않는다.
- pre-commit은 staged 전체, pre-push는 전송 커밋들의 비밀값/서명 및 끝 커밋의 전체 품질을 검사한다.
- pre-push의 임시 checkout에 pnpm frozen install을 수행하므로 시간과 네트워크가 필요하다. 작업 폴더의 dev 서버와 .next를 공유하지 않는다.
- 서버 pre-push는 .env의 격리 로컬 DB 연결 두 개만 임시 0600 파일로 전달하고 종료 시 삭제한다. 기존 DB의 데이터는 통합 테스트 대상으로 쓰지 않는다.
- pnpm policy:test는 임시 저장소에서 fixture 커밋과 git hook run을 수행한다. 원격 push/운영 DB 조작은 하지 않는다.
- CI는 pull_request와 develop/main push에서 Quality 작업을 실행한다. 서버 CI DB는 runner 전용이다.
- GitHub 필수 검사 이름은 Quality. 먼저 PR에서 성공 실행을 확인한 뒤 기존 develop ruleset에 필수 검사로 등록한다.
- 로컬 훅은 --no-verify/설정 변경으로 우회 가능하다. 원격 merge 강제는 관리 계정의 ruleset 등록과 권한 설정에 달려 있다.
- 배포/커밋 스킬의 명시 호출은 권한 확인을 대체하지 않는다.
- 수정 검증: 허용 fixture·차단 fixture·실제 등록 명령 테스트·기존 정적 검사. 정책 완화를 일반 기능 수정에 섞지 않는다.
- 문제 시 자동 우회하지 말고 원인·영향을 보고한다. 유지관리자가 해제를 요청했을 때만 등록 항목/로컬 hooksPath를 되돌린다.
- 사용자 작업 카드 요청/완료 규칙: 독립 작업 완료 시 제목·프로젝트·중요도·담당자·상태·주차와 목표/완료기준/범위, 2~3개 하위 체크리스트로 요약하고 등록을 안내한다.
