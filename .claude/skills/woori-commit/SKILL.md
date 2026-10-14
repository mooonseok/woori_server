---
name: woori-commit
description: 사용자가 커밋을 요청했을 때 portfolio 방식의 메시지와 staged 검증으로 커밋한다.
disable-model-invocation: true
---

1. 사용자가 요청한 커밋 범위와 현재 변경을 확인하고 의미 있는 단위로 나눈다. 관련 없는 파일을 포함하지 않는다.
2. 한국어 짧은 목적형 제목과 명사형 bullet 본문을 작성한다. Co-authored-by·도구 서명을 넣지 않는다.
3. 관련 검증, staged diff, git diff --cached --check를 확인하고 훅을 정상 실행해 커밋한다.
4. 커밋 후 SHA·남은 변경을 보고한다. 커밋 요청을 push/PR/merge 요청으로 확대하지 않는다.
   main/develop 직접 커밋, --no-verify, core.hooksPath 우회를 사용하지 않는다.

출처: woori user-approved workflow. 원본 절차를 프로젝트에 맞게 재작성했으며 프레임워크 구조/명명 규칙은 가져오지 않았다.
