# 집 컴퓨터 준비와 운영 이행

## 저장소·도구

두 저장소를 원하는 위치에 나란히 둔다. 특정 사용자명이나 `/Users/...` 경로는 필요 없다.
각 저장소에서 `.nvmrc` 기준 Node 24.12.0과 packageManager 기준 pnpm 10.27.0을 사용한다.

```sh
nvm install
nvm use
pnpm install --frozen-lockfile
pnpm policy:install
pnpm policy:check
```

Docker 실행, Python 3.11 이상(tomllib)이 필요하다. Git 훅이 실패하면 원인을 해결하고 우회하지 않는다.
GitHub는 mooonseok의 repo 권한으로 인증한다. 이 컴퓨터의 로컬 credential helper는 clone으로 전달되지 않는다.
집의 업무 계정 설정을 전역으로 덮어쓰지 말고 저장소별 인증 또는 별도 SSH 호스트를 사용한다.
키·token을 명령 인자/채팅/문서에 적지 않는다. `git remote -v`로 대상만 확인한다.

## 비공개 설정 이전

Git에 `.env`는 포함되지 않는다. 비밀번호 관리자/암호화 전달 수단으로 직접 복원한다.
운영/개발 자격증명 분리, 파일 권한 0600. `.env.example`을 복사할 때 기존 파일을 덮어쓰지 않는다.

server 필요 항목:

- DATABASE_URL: 로컬 `woori_api`, MIGRATION_DATABASE_URL: 로컬 `postgres`.
- `.env.local-db`의 WOORI_LOCAL_POSTGRES_PASSWORD: migration URL의 비밀번호와 일치.
- WEB_ORIGIN=http://localhost:3210, CORS_ALLOWED_ORIGINS에 사용 웹 origin 포함.
- 실제 메일은 MAIL_MODE=resend, RESEND_API_KEY, MAIL_FROM. 처음 검증한 주소 외 수신자는
  공급자의 도메인/수신 제한을 확인한다. API key만 있다고 모든 주소 수신이 검증된 것은 아니다.
- file 모드는 MAIL_MODE=file, DEV_MAIL_DIR 비워 두면 현재 사용자 `~/.woori/dev-mail`.
- R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET: 개발 버킷만 사용.
- WEB_PUSH_VAPID_PUBLIC_KEY/PRIVATE_KEY/SUBJECT, PUSH_ENCRYPTION_KEY: API/worker 동일 값.
  같은 DB의 구독을 이어 쓰면 기존 키를 유지한다. 새 격리 DB/환경에서는 별도 키 생성 가능.
  `pnpm push:keys mailto:운영자주소`는 새 비공개 파일을 만들 뿐 .env에 자동 반영하지 않는다.

client: apps/web/.env.local에 apps/web/.env.example의 공개 API 주소/live 모드만 설정.
서버 자격증명을 NEXT_PUBLIC 변수로 복사하지 않는다.

## 새 로컬 DB

다른 컴퓨터의 localhost DB/계정/사진 목록은 자동 복사되지 않는다.
기존 R2 버킷만 연결해도 새 DB에 이전 사진이 나타나지 않는다. 새 테스트 계정/앨범으로 검증한다.
기존 DB를 옮겨야 하면 별도 비공개 dump/restore와 범위 확인이 필요하다.
다른 DB와 같은 버킷을 쓰면서 고아 정리를 실행하면 유효 객체를 지울 수 있으므로 격리 버킷을 권장한다.

대상은 `127.0.0.1:55439/woori_dev`의 **새 로컬 DB**. Docker volume 존재/내용부터 확인한다.
`pnpm dev:db:prepare`는 migrations 적용과 woori_api 역할/권한을 변경한다.
기존 DB일 경우 백업/변경 범위/복구를 확인하고 승인 후 실행한다. 자동 startup에 넣지 않는다.

```sh
pnpm dev:db
# 새 로컬 대상·영향 확인 후 실행
pnpm dev:db:prepare
```

실패 시 로그의 비밀값을 공유하지 않는다. 초기화 실패를 해결하려고 기존 Docker volume을 삭제하지 않는다.
새 전용 volume의 폐기도 확인 후 수행한다. 적용한 migration은 수정하지 않고 후속 migration을 만든다.

## 실행 (터미널 분리)

server: `pnpm dev` → API localhost:3001.
server: `pnpm build` 후 `pnpm start:worker` → 푸시/사진 삭제 큐. API만 켜면 큐 발송이 진행되지 않는다.
client: `pnpm dev` → localhost:3210. 관리자 뼈대: `pnpm dev:admin` → localhost:3002.
웹 production build는 같은 checkout의 dev와 동시에 실행하지 않는다.

브라우저 알림 권한·PushSubscription은 기기/브라우저마다 다시 등록한다.
집에서 가입/이메일 확인 → 그룹 생성·두 계정 초대 → 사진/댓글 → 양방향 알림 수신을 확인한다.
OS 표시·브라우저 표시·provider 접수 결과를 구분한다. 휴대폰 접근에는 별도 HTTPS 환경이 필요하다.

## 검증과 배포 경계

`pnpm policy:quality`는 전체 검증. server는 격리된 임시 PostgreSQL DB를 생성·정리한다.
pre-push는 전송 커밋을 임시 checkout에서 설치·전체 검사한다. 오래 걸려도 훅을 끄지 않는다.
server pre-push에는 위의 로컬 DB 연결 설정과 실행 중인 PostgreSQL이 필요하다.
검사 스크립트의 localhost 보호 제한을 원격 DB에 맞춰 제거하지 않는다.

운영 단계에서 준비할 항목: Railway API/worker, Supabase Pro 연결·TLS·migration 계정,
웹 정적 호스팅과 HTTPS 도메인, 실제 발신 도메인, 개발/운영 R2 분리,
복원 가능한 DB/객체 백업, 모니터링 수신처, 네이티브 개발자 계정/서명.
가격/요금제/OS 지원은 이 문서에 고정하지 않는다. 생성·결제·배포 직전 확인한다.
