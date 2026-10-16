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
server: `pnpm build` 후 `pnpm start:worker` → 푸시/사진 처리·삭제/메일 재시도 큐. API만 켜면 큐 발송이 진행되지 않는다.
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

## 웹 배포: Cloudflare Pages (W07-4)

회원 웹과 관리자 웹은 같은 `woori_client` 저장소로 Pages 프로젝트 2개를 만든다. 정적 export다.

| 항목          | 회원 웹                    | 관리자 웹                    |
| ------------- | -------------------------- | ---------------------------- |
| 빌드 명령     | `pnpm pages:web`           | `pnpm pages:admin`           |
| 출력 디렉터리 | `apps/web/out`             | `apps/admin/out`             |
| 루트 디렉터리 | 저장소 루트                | 저장소 루트                  |
| 커스텀 도메인 | `woori.stream`             | `admin.woori.stream`         |
| 헤더 원본     | `apps/web/public/_headers` | `apps/admin/public/_headers` |

Production 환경변수(Pages 설정에 입력, 저장소·NEXT_PUBLIC에 서버 비밀값 금지):

- 공통: `NODE_VERSION=24.12.0`, `PNPM_VERSION=10.27.0`, `NEXT_PUBLIC_API_BASE_URL=https://api.woori.stream`,
  `WOORI_R2_ORIGIN=https://<운영 R2 계정 ID>.r2.cloudflarestorage.com`
  (presigned PUT 업로드·동영상 서명 재생 호스트, 서버 `R2_ACCOUNT_ID`와 같은 계정. 키·버킷 비밀값은 넣지 않는다)
- 회원 웹만: `NEXT_PUBLIC_APP_MODE=live`

`scripts/pages-build.mjs`가 빌드 후 HTML마다 inline script 해시 CSP meta를 넣고 `_headers`의 origin을 채운다.
API origin이 `woori.stream`·하위 도메인이 아닌 https 값이거나, localhost·사설 IP·`.local`/`.internal` 등 내부 주소·mock URL,
채우지 못한 자리표시자가 있으면 빌드를 실패시킨다. 실패를 우회하지 않는다.

Cloudflare 대시보드에서 `woori.stream` 존의 Rocket Loader, Email Address Obfuscation(Scrape Shield),
Web Analytics 자동 삽입(JS 스니펫 자동 설치), Bot Fight Mode(JavaScript 탐지)를 끈다. 이 기능들은 응답 HTML에
스크립트를 넣거나 inline script를 바꾸므로 빌드 때 계산한 script 해시 CSP와 맞지 않아 페이지 스크립트가 차단된다.
Web Analytics가 필요하면 자동 삽입이 아니라 수동 설치로 하고 CSP를 함께 고친다. 배포 후
`curl -s https://woori.stream/album | grep -E "cdn-cgi|cloudflareinsights|rocketscript"`가 아무것도 출력하지 않는지 확인한다.

연결 순서:

1. 프로젝트 생성 → Git 연결 → 운영 브랜치 지정 → 위 빌드 명령·출력·환경변수 입력.
2. Custom domains에 도메인 추가(같은 Cloudflare 계정 zone이면 DNS·인증서 자동).
3. 미리보기(`*.pages.dev`, 브랜치 배포)는 운영 API의 CORS·쿠키 대상이 아니라 동작하지 않는다.
   운영 브랜치만 빌드하고, 관리자 프로젝트의 `*.pages.dev`는 Cloudflare Access 등으로 막는다.
4. 선행 조건(서버·운영): API `WEB_ORIGIN=https://woori.stream`, `CORS_ALLOWED_ORIGINS`에 두 웹 origin,
   운영 R2 버킷 CORS에 `https://woori.stream`의 `PUT`(Content-Type 헤더) 허용.
   동영상은 `<video src>`로 R2에서 직접 재생하므로 CORS 없이 동작한다(Range 응답은 R2가 처리).
   HSTS `includeSubDomains`는 woori.stream 하위 전체에 적용되므로 HTTP 전용 하위 도메인이 없어야 한다.

배포 후 확인: `curl -sI https://woori.stream/album`으로 CSP·HSTS 헤더를 본다.
`/없는경로`가 404, `/album.html`이 `/album`으로 이동하는지 확인한다.
브라우저 콘솔에 CSP 위반이 없어야 하고, 사진 1장 업로드로 R2 PUT을 확인한다.
관리자 웹은 `X-Robots-Tag`, HTML `Cache-Control: no-store`, `/_next/static` immutable을 확인한다.

## 서버 배포: Railway API·워커 (W07-4)

같은 `woori_server` 저장소로 Railway 서비스 2개를 Singapore 리전에 만든다(리전은 서비스 설정에서 고른다).
각 서비스의 Config-as-code 경로에 아래 파일을 지정한다. 파일에는 비밀값이 없다.

| 항목          | API                       | 워커                                                 |
| ------------- | ------------------------- | ---------------------------------------------------- |
| 설정 파일     | `deploy/railway.api.json` | `deploy/railway.worker.json`                         |
| 빌드          | Railpack, `pnpm build`    | `deploy/worker.Dockerfile`(Debian ffmpeg, `--check`) |
| 시작          | `pnpm start:api`          | 이미지 CMD `node dist/src/worker/main.js`            |
| 헬스체크      | `/readyz`(DB·메일 설정)   | 없음(HTTP 없음). 관리자 지표 `workers`로 확인        |
| 커스텀 도메인 | `api.woori.stream`        | 없음                                                 |

`api.woori.stream`의 Cloudflare DNS 레코드는 **DNS only(회색 구름)** 로 둔다. 프록시(주황 구름)를 켜면
Railway 앞에 Cloudflare 한 단이 더 생겨 `TRUST_PROXY_HOPS=1` 기준의 `req.ip`가 Cloudflare 엣지 주소가 되고,
IP 기준 rate limit이 모든 회원을 한 묶음으로 세거나 우회된다. 웹·관리자 Pages 도메인만 프록시를 쓴다.

운영 환경변수(서비스 Variables에만 입력, 저장소·로그·채팅 금지):

- 공통: `NODE_ENV=production`, `DATABASE_URL`(Supabase의 `woori_api` 런타임 역할, TLS),
  `WEB_ORIGIN=https://woori.stream`, `MAIL_MODE=resend`, `RESEND_API_KEY`,
  `MAIL_FROM=우리 <no-reply@mail.woori.stream>`, `MAIL_OUTBOX_KEY`,
  `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`(운영 버킷),
  `WEB_PUSH_VAPID_PUBLIC_KEY`, `WEB_PUSH_VAPID_PRIVATE_KEY`, `WEB_PUSH_VAPID_SUBJECT`, `PUSH_ENCRYPTION_KEY`.
  `MAIL_OUTBOX_KEY`와 푸시 키는 API·워커가 반드시 같은 값이다.
- API만: `ADMIN_WEB_ORIGIN=https://admin.woori.stream`,
  `CORS_ALLOWED_ORIGINS=https://woori.stream,https://admin.woori.stream`(정확히 이 두 개, 다른 origin 금지), `TRUST_PROXY_HOPS=1`,
  `ADMIN_TOTP_ENCRYPTION_KEY`.
- `MIGRATION_DATABASE_URL`은 어떤 Railway 서비스에도 넣지 않는다.

`NODE_ENV=production`이면 API·워커가 시작할 때 https origin, CORS 목록, `TRUST_PROXY_HOPS=1`,
Resend 발신 주소가 웹 도메인(하위 도메인 포함)인지, `MAIL_OUTBOX_KEY`, R2 설정, localhost가 아닌 DB 주소를 검사한다.
CORS 목록은 `WEB_ORIGIN`·`ADMIN_WEB_ORIGIN` 두 개와 정확히 같아야 한다.
빠진 항목은 이름만 출력하고 시작하지 않는다(값은 출력하지 않는다). 회원 쿠키는 `__Host-woori_session`,
관리자 쿠키는 `__Host-woori_admin_session`(SameSite=Strict)이며, 시작 검사가 실제 쿠키 옵션
(Secure, Path=/, Domain 없음)까지 확인한다. 워커는 `VIDEO_X264_PRESET`(비우면 veryfast)이 허용 목록 밖이면 시작하지 않는다.

배포 순서: 운영 migration → API·워커(같은 커밋) → 웹. 파괴적 migration은 별도 절차로 한다.

## 운영 migration 절차

앱 시작에 migration을 넣지 않는다. 운영 DB에 `pnpm dev:db:prepare`·통합 테스트·seed를 실행하지 않는다.

1. Supabase 대시보드에서 마지막 일일 백업 시각을 확인한다. 큰 변경 전에는 수동 백업도 남긴다.
2. 신뢰할 수 있는 컴퓨터에서 배포할 커밋을 checkout하고 `pnpm install --frozen-lockfile`.
3. 저장소 밖 비공개 파일(0600)에 `MIGRATION_DATABASE_URL`(Supabase 소유자 역할, direct 또는 session 연결, TLS)만 둔다.
4. `node --env-file=<그 파일> node_modules/prisma/build/index.js migrate status`로 적용 대상을 확인한 뒤
   같은 방식으로 `migrate deploy`를 실행한다.
5. 처음 한 번 `woori_api` 로그인 역할을 만들고(비밀번호는 비밀번호 관리자에서 생성), 매 배포마다
   `psql "<MIGRATION_DATABASE_URL>" -v ON_ERROR_STOP=1 -f prisma/runtime-grants.sql`로 최소 권한을 다시 적용한다.
6. `20261030010000_one_waiting_delivery` 적용 전 확인(대기 배송 중복, 결과 0행이 정상):
   `SELECT "notificationId","installationId",count(*) FROM woori.notification_deliveries WHERE status IN ('PENDING','RUNNING') GROUP BY 1,2 HAVING count(*)>1;`
   중복이 있으면 migration이 오래된 바인딩 쪽을 `DONE/superseded`로 닫고 인덱스를 만든다.
7. 되돌릴 때는 Railway에서 이전 배포로 돌린다. 추가된 테이블·컬럼은 남겨 둔다(이전 코드와 호환).

## 운영 R2

- 버킷 2개: 운영(사진·동영상)과 백업. 둘 다 비공개, r2.dev·공개 도메인 금지.
- 운영 버킷 CORS: `deploy/r2-cors.production.json`(https://woori.stream의 `PUT`, `content-type` 헤더).
  재생은 `<video src>`(crossorigin 없음), 다운로드는 링크 이동이라 `GET` CORS가 필요 없다.
  웹 CSP의 `connect-src`(업로드 PUT)·`media-src`(동영상 재생)에 R2 호스트(`WOORI_R2_ORIGIN`)가 들어간다(웹 담당, `pnpm pages:web`·`pages:admin`이 채움). 사진·포스터는 API를 거쳐 blob으로 표시하므로 `img-src`에는 필요 없다.
- 운영 버킷 lifecycle: `staging/` 접두사만 1일 후 삭제.
- API 토큰 2개: 앱용(운영 버킷 Object Read & Write만), 백업용(운영 버킷 Read + 백업 버킷 Read & Write).

## 메일: Resend와 메일 outbox

- Resend에 `mail.woori.stream` 도메인을 추가하고 Cloudflare DNS에 SPF·DKIM 레코드를 넣는다.
  DMARC(`_dmarc.woori.stream`)는 `p=none`으로 시작해 발송 확인 후 `quarantine`으로 올린다.
- `pnpm mail:keys`로 `.env.mail.local`을 만들고 `MAIL_OUTBOX_KEY`를 API·워커(로컬 개발 `.env`도)에 넣는다.
  키를 바꾸면 아직 보내지 않은 메일은 `payload-unreadable`로 실패하고 회원이 다시 요청해야 한다.
- 인증·복구·이메일 변경 메일은 토큰과 같은 트랜잭션에서 암호화해 기록하고 API가 바로 1회 보낸다.
  실패는 워커가 30초→15분 간격으로 최대 6회 재시도한다(같은 Idempotency-Key). 워커가 꺼져 있으면 재시도가 멈춘다.

## 모니터링과 비용 알림

- API: Railway 헬스체크 `/readyz`. 외부 가동 확인(선택)도 `https://api.woori.stream/readyz`를 본다.
- 워커: 관리자 지표 `workers.healthy`(120초 안의 heartbeat와 성공한 회차), `queues.*.oldestDueSeconds`,
  `mail.failed24h`를 본다. heartbeat는 15초 타이머로 따로 기록하므로 긴 동영상 변환 중에도 갱신되고,
  진행 중 작업은 `instances[].busyJob`(`video-transcode`/`photo-processing`)·`busySeconds`로 보인다.
  사진·동영상 처리는 정리·푸시·그룹·메일 큐와 별도 루프로 돌고 회차당 동영상은 1건이다.
  `videoReady=false`인 워커는 동영상 작업을 가져가지 않는다(사진은 처리).
  재배포(SIGTERM) 시 진행 중 변환을 멈추고 작업을 시도 횟수 차감 없이 바로 대기열로 돌린 뒤 종료한다.
  강제 종료돼도 15분 리스가 끝나면 다른 회차가 다시 잡는다. 워커 로그의 실패 줄은 `{"service":"woori-worker","job":...,"status":"failed"}` 형식이며 값은 담지 않는다.
- Railway 사용량 알림 $45, 하드 한도 $60(월). Supabase·Cloudflare·Resend 요금 알림도 각 콘솔에서 켠다.

## 백업과 복원 훈련 (RPO 24시간, RTO 반나절)

- DB: Supabase Pro 일일 백업 7일 보관(PITR 없음). 최대 24시간 데이터 손실을 감수한다.
- R2: 매주 신뢰할 수 있는 컴퓨터에서 `pnpm build` 후 `pnpm r2:backup`(dry-run, 개수만 출력)으로 확인하고
  `pnpm r2:backup --apply`로 운영→백업 버킷 증분 복사(키·크기·ETag 비교, 서버 내부 복사)를 한다.
  필요한 값: `R2_ACCOUNT_ID`, `R2_BUCKET`, `R2_BACKUP_BUCKET`, `R2_BACKUP_ACCESS_KEY_ID`, `R2_BACKUP_SECRET_ACCESS_KEY`.
  백업 버킷의 `_woori-backup/manifest.json`에 원본 버킷 이름과 "운영에서 사라진 것을 백업 실행이 처음 본 시각"을 기록한다(`--apply` 때만 갱신).
  백업에서 지우는 일은 `--apply --prune-older-than <7일 이상>`을 명시할 때만, 그 처음 본 시각에서 기간이 지난 객체만 한다
  (백업 사본의 수정 시각은 쓰지 않는다. 주 1회 실행이므로 실제로는 최대 1주 더 늦게 지워진다).
  안전 정지: 운영 목록이 0개, 두 버킷이 같음, manifest의 원본 버킷이 다름, manifest 손상이면 아무것도 바꾸지 않고
  `{"status":"aborted","reason":...}`로 끝난다. 지울 대상이 백업 객체의 5%를 넘으면 삭제만 건너뛰고(복사는 진행) 종료 코드 1을 낸다.
  원인을 확인한 뒤에만 `--force-large-prune`을 붙인다.
- 월 1회 복원 훈련:
  1. Supabase에서 최신 일일 백업을 새 프로젝트(Singapore)로 복원한다. 운영 프로젝트를 덮어쓰지 않는다.
  2. 새 프로젝트에 `woori_api` 역할을 만들고 `prisma/runtime-grants.sql`을 적용한다.
  3. 신뢰할 수 있는 컴퓨터에서 API만 실행한다. `DATABASE_URL`은 복원 프로젝트, `R2_BUCKET`은 백업 버킷,
     R2 토큰은 백업 버킷 **읽기 전용**으로 둔다. 워커는 실행하지 않는다(정리 큐가 객체를 지울 수 있다).
  4. 시험 계정으로 로그인, 앨범 목록, 사진 썸네일·원본, 동영상 재생 URL, 알림 목록을 확인하고
     사용자·그룹·사진 수를 운영 관리자 지표와 비교한다.
  5. 날짜, 복원한 백업 시각, 걸린 시간, 문제를 기록하고 복원 프로젝트를 삭제한다.
