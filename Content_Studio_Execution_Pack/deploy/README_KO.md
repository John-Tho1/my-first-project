# Content Studio 운영 배포 절차(초안, T21-P2 · FIX1)

> **운영 로그인(OIDC)은 코드가 생겼지만(T21-P1b) 실제 IdP 와 연결해 본 적이 없다(not_run).** 운영 빌드에서는 `AUTH_MODE=dev` 가 거부되고(T21-P1a), `AUTH_MODE=oidc` 는 아래 "4.1 OIDC 로그인 설정"의 값이 모두 준비됐을 때만 로그인할 수 있다. IdP 선택·IdP 콘솔에서 클라이언트 만들기·실제 로그인 확인은 **사용자 단계이며 별도 승인 범위**다(외부 계정·외부 연결). 그 전에는 이 폴더의 파일로 서버를 띄워도 생존 확인(`/api/health`)만 되고 아무도 로그인할 수 없다.
>
> 이 폴더는 **파일만** 있다. 실제 서버·도메인·인증서·systemd·Caddy 에서 실행해 본 적이 없다(not_run). 스크립트는 `bash -n`(문법)과 인수 검사만 로컬에서 확인했다. 공급자 가입·결제·DNS·외부 연결은 사용자 승인 범위(docs/handoffs/T21_DEPLOY_REVIEW.md §4.2)를 받은 뒤에만 한다.

## 1. 구성
- VPS 1대(권장 1 vCPU / 2 GB 이상 — 경험칙, 실측 아님), Linux + systemd. 아래 명령은 Debian/Ubuntu 계열을 가정한다.
- Caddy(:80·:443, 자동 HTTPS) → web(Next, `127.0.0.1:3000`) 한 프로세스. 작업 처리기는 web 안(inline)에서 돈다.
- 주기 처리: `WORKER_INLINE_INTERVAL_SECONDS=30`(web 안 타이머, 직전 처리가 끝난 뒤 30초 쉬고 다음 처리 — 겹치지 않음). 별도 cron·systemd timer 는 없다.
- DB 는 PGlite(영속 디스크의 폴더 하나). **한 데이터 폴더는 한 프로세스만 연다** — web 이 도는 동안 `pnpm worker`·`pnpm export`·`pnpm db:migrate` 를 같은 폴더로 돌리지 않는다.

### 경로(저장소 루트와 앱 루트를 구분한다)
git 저장소의 루트에는 이 앱 말고 다른 파일도 있고, **앱은 저장소 안의 `Content_Studio_Execution_Pack/` 폴더**다(`pnpm-workspace.yaml`·`package.json`·`apps/`·`deploy/` 가 여기 있다).

| 이름 | 경로 | 내용 | 소유·권한 |
| --- | --- | --- | --- |
| 저장소 루트 `REPO_ROOT` | `/srv/content-studio/repo` | `git clone` 한 곳(`.git`) | `content-studio`, 755 |
| 앱 루트 `APP_ROOT` | `/srv/content-studio/repo/Content_Studio_Execution_Pack` | install·build·실행 위치(systemd `WorkingDirectory`), `node_modules` | `content-studio` |
| 빌드 결과 | `$APP_ROOT/apps/web/.next` | `next build` 출력(Next 는 `apps/web` 에서 실행된다). systemd `ReadWritePaths` 에 이 경로 | `content-studio` |
| 데이터 | `/srv/content-studio/data` | `pglite/`·`assets/`·`exports/`·`restores/`·`imports/` — **영속 디스크** | `content-studio`, 700 |
| 정지 상태 사본 | `/srv/content-studio-backup` | `deploy/scripts/backup-data.sh` 가 만든 tar.gz | `root:root`, 폴더 700·파일 600 |
| 환경 파일 | `/etc/content-studio/env` | 설정·비밀(EnvironmentFile) | `root:root`, **600** |
| Caddy 도메인 파일 | `/etc/caddy/content-studio.env` | `APP_DOMAIN=<도메인>` 한 줄(Caddy 서비스·검증이 같은 파일을 읽음) | `root:root`, 644 |
| systemd unit | `/etc/systemd/system/content-studio.service` | `$APP_ROOT/deploy/content-studio.service` | root, 644 |
| Caddyfile | `/etc/caddy/Caddyfile` | `$APP_ROOT/deploy/Caddyfile` | root, 644 |

- Next `output: 'standalone'` 은 **쓰지 않는다.** 서버에서 저장소 그대로 `install` + `build` 하고 `next start` 로 실행한다. 이유: (1) PGlite 는 WASM·데이터 파일을 런타임에 `node_modules` 에서 읽는다(`serverExternalPackages`) — standalone 추적 결과에 빠지는지 확인하지 않았다. (2) DB·export CLI(`pnpm export`·`pnpm db:migrate`)가 같은 checkout 의 소스(tsx)를 쓴다. (3) dev·build 설정을 바꾸지 않아도 된다.

## 2. 준비(서버에서, 한 번)
버전: Node 24.x(저장소 `engines` `>=22.12`, 로컬 검증 v24.21.0), pnpm 12.6.0(corepack — `package.json` `packageManager`), Caddy 2.x. 설치 방법·버전은 실제 설치 때 기록한다. 아래 명령은 한 줄씩 실행하고, 실패하면 다음 줄로 넘어가지 않는다.

```sh
set -eu
sudo useradd --system --home-dir /srv/content-studio --shell /usr/sbin/nologin content-studio
sudo install -d -o content-studio -g content-studio -m 755 /srv/content-studio /srv/content-studio/repo
sudo install -d -o content-studio -g content-studio -m 700 /srv/content-studio/data
sudo install -d -o root -g root -m 700 /srv/content-studio-backup
sudo install -d -o root -g root -m 755 /etc/content-studio
sudo install -o content-studio -g content-studio -m 644 /dev/null /srv/content-studio/deploy.lock   # 배포 스크립트 동시 실행 금지용 잠금 파일(flock)
sudo -u content-studio -H git clone <저장소 URL> /srv/content-studio/repo
test -f /srv/content-studio/repo/Content_Studio_Execution_Pack/pnpm-workspace.yaml   # 앱 루트 확인
```
- `/srv/content-studio/data` 는 재시작·재배포·서버 재생성 뒤에도 남는 디스크여야 한다(공급자 볼륨을 쓰면 여기에 마운트).
- FIX4: 데이터를 **볼륨 마운트**로 둘 때는 `sudo touch /srv/content-studio/.data-must-be-mount` 로 표시한다 — 백업·복원 스크립트가 데이터 폴더가 지금 마운트가 아니면(볼륨이 빠진 채 빈 폴더) 거부한다. 데이터 폴더 **아래**에 또 다른 마운트(bind 포함)를 두지 않는다 — 두면 백업·복원이 거부한다.
- 데이터 폴더 안에는 일반 파일·폴더만 둔다(심볼릭 링크·하드링크·소켓·FIFO·장치, 이름에 줄바꿈·제어 문자·역슬래시·UTF-8 아닌 바이트가 있으면 백업이 거부한다). 백업과 복원은 같은 검사 함수(`lib/common.sh` `validate_tree`·`validate_archive`)를 쓰고, 백업은 쓴 사본이 복원 검사를 통과해야 성공한다(아니면 그 사본을 지운다).
- 배포 스크립트(`build-release.sh`·`backup-data.sh`·`restore-data.sh`)는 `/srv/content-studio/deploy.lock` 에 `flock` 을 잡는다 — 둘을 동시에 돌리면 뒤의 것이 거부된다. `flock`·`mountpoint` 는 util-linux 에 있다.
- 방화벽: 22 = 사용자 IP 만, 80·443 공개. **3000 은 열지 않는다**(web 은 127.0.0.1 에서만 듣는다).

## 3. 빌드(지정 SHA)
`deploy/scripts/build-release.sh` 를 쓴다. `set -euo pipefail` 로 어느 단계든 실패하면 바로 멈추고, 아래를 순서대로 확인한다: 인수가 40자리 SHA → 서비스 사용자로 실행 → **systemd 가 조회에 성공하고 `inactive`/`failed` 라고 답함**(조회 실패·systemctl 없음·`active`·`activating`·`deactivating`·`reloading` 이면 중단, FIX2) → 추적 파일 변경 없음 → `git fetch` → 커밋 존재 → `git checkout --detach <SHA>` → **`git rev-parse HEAD` 가 요청 SHA 와 같음** → 앱 루트에 `.env`·`.env.local` 없음 → `pnpm install --frozen-lockfile` → `pnpm build` → `apps/web/.next/BUILD_ID` 존재.

```sh
# 처음 설치(아직 content-studio.service 를 등록하지 않음): unit 이 없음이 확인될 때만 진행
sudo -u content-studio -H bash /srv/content-studio/repo/Content_Studio_Execution_Pack/deploy/scripts/build-release.sh --first-install <40자리 SHA>

# 그 뒤(업그레이드·되돌리기): 먼저 멈추고 빌드
sudo systemctl stop content-studio
sudo -u content-studio -H bash /srv/content-studio/repo/Content_Studio_Execution_Pack/deploy/scripts/build-release.sh <40자리 SHA>
echo "exit=$?"                                              # 0 이 아니면 멈춘다(이전 빌드를 그대로 시작하지 않는다)
```
- `--first-install` 은 `systemctl show` 가 unit 을 `not-found` 로 답하고 `systemctl list-unit-files` 가 **성공**했으며 목록에 `content-studio.service` 가 **없을** 때만 통한다. 이미 등록된 뒤에는 쓰면 중단된다.
- 스크립트는 checkout 한 SHA 의 저장소 안에 있으므로, 처음에는 위 §2 의 clone 결과(기본 브랜치)에 있는 스크립트가 돈다. 스크립트 자체를 바꾼 SHA 로 올릴 때는 그 SHA 를 먼저 checkout 한 뒤 다시 실행한다.
- 빌드에는 비밀이 필요 없다. 출력 마지막 줄 `BUILD_OK sha=…` 와 종료 코드를 기록한다.

## 4. 환경 파일
```sh
set -eu
APP_ROOT=/srv/content-studio/repo/Content_Studio_Execution_Pack
sudo install -o root -g root -m 600 "$APP_ROOT/deploy/content-studio.env.example" /etc/content-studio/env
sudo -e /etc/content-studio/env     # APP_BASE_URL=https://<도메인>, SECRETS_MASTER_KEY(운영 전용 새 키) 등을 사용자가 직접 넣는다
sudo bash "$APP_ROOT/deploy/scripts/check-env.sh"           # 파일 존재·root:root 600·고정 설정·데이터 경로·비어 있어야 할 키 확인(값은 출력 안 함)
```
- 예시 파일은 placeholder 뿐이다. 실제 도메인·키는 이 파일에만 둔다(저장소·대화·로그 금지).
- 고정 설정(게시·수집·OAuth live·LLM live 끔, `AUTH_MODE=oidc`)은 승인 없이 바꾸지 않는다. `check-env.sh` 가 어긋나면 종료 코드 1 이다.
- 환경 파일 문법은 좁게 제한한다(FIX2 — 검사기와 systemd 가 다르게 읽지 않게): 빈 줄, `#` 로 시작하는 주석 줄, `KEY=값`(대문자 KEY, 줄 맨 앞, `=` 주변 공백 없음, 값에 따옴표·역슬래시·`$`·앞뒤 공백 없음) 뿐이고 같은 KEY 는 한 번만. `export`·앞 공백·연속 행(줄 끝 ``)·CRLF 는 `check-env.sh` 가 거부한다. 데이터 경로는 `..`·심볼릭 링크를 해석한 실제 위치가 `/srv/content-studio/data` 아래여야 하고, 데이터 루트 자체가 심볼릭 링크면 거부한다(FIX3 — 백업 tar 가 링크만 담게 되므로).
- 환경 파일이 없으면 systemd 가 서비스를 시작하지 않는다(`EnvironmentFile=` 에 `-` 를 붙이지 않았다).
- `WORKER_INLINE_INTERVAL_SECONDS`: 0(끔) 또는 5~600 초. 0 이면 예약 작업·업로드 24시간 만료 정리·`RETENTION_SWEEP_MODE=auto`·주기 수집이 로그인한 요청이 있을 때만 진행되고, 서버 시작 로그에 경고가 남는다.

### 4.1 OIDC 로그인 설정(T21-P1b — 사용자 단계, 별도 승인 필요)
앱은 IdP 를 정하지 않는다(일반 OpenID Connect, 라이브러리 `openid-client` 6.8.8). 아래는 **사용자가 승인한 뒤** 사용자가 직접 한다 — IdP 계정·콘솔 작업과 실제 로그인은 외부 연결이다.
1. IdP 를 고른다(예: Google). IdP 콘솔에서 "웹 애플리케이션" OAuth/OIDC 클라이언트를 만들고 **승인된 redirect URI** 에 `https://<도메인>/api/auth/oidc/callback` 을 글자 그대로 넣는다(끝의 `/`·대소문자·포트까지 같아야 한다).
2. `/etc/content-studio/env` 에 넣는다(값은 이 파일에만): `OIDC_ISSUER_URL`(IdP 의 issuer, https — 예: Google 은 `https://accounts.google.com`), `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, `OIDC_REDIRECT_URI=https://<도메인>/api/auth/oidc/callback`(= `APP_BASE_URL` + 이 경로), `OIDC_SCOPES=openid email`(기본값), 허용 신원 `AUTH_ALLOWED_IDENTITY=<본인 이메일>`(ID token 의 email 이 같고 IdP 가 `email_verified=true` 로 보내야 함) — 선택으로 `AUTH_ALLOWED_SUBJECT=<IdP 의 sub>`(이메일 재할당에 강함, 둘 다 넣으면 둘 다 맞아야 함). `SECRETS_MASTER_KEY`·`SECRETS_KEY_VERSION` 도 필요하다(로그인 요청의 PKCE verifier·nonce 를 10분 봉인).
3. 서비스를 다시 시작하고 `/login` 의 **OIDC로 로그인** 을 누른다. 설정이 빠졌으면 화면에는 "설정이 준비되지 않았습니다"만 나오고, 빠진 **이름**은 `journalctl -u content-studio` 의 `[auth] oidc_not_configured: …` 한 줄에 있다(값 없음). 로그인 후에는 설정 화면 "로그인(인증)"·`/api/health/details` 의 `auth` 에서도 본다.
- `check-env.sh` 는 OIDC_* 값을 아직 검사하지 않는다(앱이 시작·로그인 때 이름만 알려 준다).
- 로그인 실패(state 오류·검증 실패·허용 신원 불일치)는 식별자 로그인과 같은 전역 15분·10회 창에서 센다. 막히면 15분 동안 주인도 새로 로그인할 수 없다(이미 있는 세션은 그대로) — 프록시 수준 요청 제한은 여전히 없다.

## 5. 서비스 시작·확인
```sh
set -eu
APP_ROOT=/srv/content-studio/repo/Content_Studio_Execution_Pack
sudo install -o root -g root -m 644 "$APP_ROOT/deploy/content-studio.service" /etc/systemd/system/content-studio.service
sudo systemd-analyze verify /etc/systemd/system/content-studio.service
sudo systemctl daemon-reload
sudo systemctl enable --now content-studio
systemctl is-active content-studio
journalctl -u content-studio -n 50 --no-pager
curl -fsS http://127.0.0.1:3000/api/health
```
기대 결과
- 로그에 `[inline-worker] 주기 처리 시작: 30초 간격(...)` 한 줄. 설정 오류면 `[startup] 서버를 시작하지 않습니다`(dev 로그인) 또는 `[inline-worker] ... config_invalid` 이 남는다(값은 로그에 없음).
- health 응답 키는 정확히 `{ status, app, time_utc, db_ok }`, `status: "ok"`, `db_ok: true`.
- `/srv/content-studio/data/pglite` 가 생기고 소유자가 `content-studio` 다. `apps/web/.next` 밖에 쓰려다 실패한 기록(`EROFS`·`EACCES`)이 로그에 없어야 한다 — 있으면 `ReadWritePaths` 를 다시 본다(실서버 미검증).

## 6. Caddy(HTTPS)
도메인은 `/etc/caddy/content-studio.env` 한 곳에 두고, Caddy 서비스와 검증 명령이 **같은 파일**을 읽게 한다.
```sh
set -eu
APP_ROOT=/srv/content-studio/repo/Content_Studio_Execution_Pack
echo 'APP_DOMAIN=<도메인>' | sudo tee /etc/caddy/content-studio.env >/dev/null
sudo chmod 644 /etc/caddy/content-studio.env
sudo install -o root -g root -m 644 "$APP_ROOT/deploy/Caddyfile" /etc/caddy/Caddyfile
sudo systemctl edit caddy           # [Service] 아래에 EnvironmentFile=/etc/caddy/content-studio.env 추가
# 검증: 서비스와 같은 APP_DOMAIN 으로(현재 셸에는 없으므로 파일을 읽어 넘긴다)
sudo sh -c 'set -a; . /etc/caddy/content-studio.env; set +a; test -n "$APP_DOMAIN" && exec caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile'
sudo systemctl restart caddy
```
- DNS A 레코드가 서버 IP 를 가리킨 뒤에 인증서가 발급된다.
- 확인: `curl -fsSI https://<도메인>/api/health`(200, `strict-transport-security`·`x-content-type-options` 헤더, `server`·`x-powered-by` 없음), `curl -sI http://<도메인>/` 가 https 로 넘어감, 외부에서 `:3000` 접속 불가.
- 로그인: 4.1 의 OIDC 설정(사용자 단계·별도 승인)을 마치기 전에는 거부되는 것이 정상이다.

## 7. 업그레이드(새 SHA)
migration 은 **앞으로만** 적용된다(G8 — 첫 DB 연결 때 자동 적용, down migration 없음). 그래서 업그레이드 전에 반드시 백업한다. 각 단계는 앞 단계가 성공했을 때만 한다.
1. **앱 export ZIP(정본 백업)** — 화면 `/ops` 또는 `POST /api/exports`(로그인 필요 — 4.1 OIDC 설정 이후). 만든 ZIP 을 서버 밖(사용자 PC 등, T21-P4 에서 정한 위치)으로 옮긴다.
   - 로그인할 수 없으면 CLI(서비스를 멈춘 뒤 — PGlite 잠금):
     ```sh
     set -eu
     sudo systemctl stop content-studio
     sudo systemd-run --wait --pipe --collect --uid=content-studio --gid=content-studio \
       -p WorkingDirectory=/srv/content-studio/repo/Content_Studio_Execution_Pack -p EnvironmentFile=/etc/content-studio/env \
       -E NODE_ENV=production -E TZ=UTC /usr/bin/corepack pnpm export
     ```
     (미검증. 환경 파일을 명령줄에 펼치지 않는다 — 비밀이 프로세스 목록·셸 기록에 남지 않게)
2. **데이터 폴더 정지 상태 사본**(되돌리기용):
   ```sh
   sudo systemctl stop content-studio
   sudo bash /srv/content-studio/repo/Content_Studio_Execution_Pack/deploy/scripts/backup-data.sh "$(sudo -u content-studio git -C /srv/content-studio/repo rev-parse HEAD)"
   ```
   스크립트는 root 확인 → 서비스 정지 확인 → `/srv/content-studio-backup`(root 700) 생성 → `data-<UTC 시각>-<SHA>.<고유>.tar.gz`(600, mktemp 로 배타적 생성 — 덮어쓰지 않음, 데이터 폴더가 심볼릭 링크면 거부) → 다시 읽기 확인. 이 사본도 서버 밖으로 옮겨야 디스크 고장에 대비된다(G5·T21-P4).
3. 코드 갱신·빌드: §3 `build-release.sh <새 SHA>`(서비스 정지 상태). 종료 코드가 0 이 아니면 4 로 가지 않는다 — §8 로 되돌린다.
4. `sudo bash $APP_ROOT/deploy/scripts/check-env.sh` → `sudo systemctl start content-studio` → §5 확인(health·로그). 첫 연결에서 migration 이 적용된다.
5. 결과(이전·새 SHA, 명령, pass/fail)를 기록한다.

## 8. 되돌리기
- **코드만 되돌리지 않는다.** 새 migration 이 이미 적용된 DB 를 이전 코드로 열면 안 된다(지원하지 않음).
- 순서: 서비스 정지 → `build-release.sh <이전 SHA>` → 데이터를 §7-2 사본으로 되돌림 → `check-env.sh` → 시작 → §5 확인.
- 데이터 되돌리기는 `deploy/scripts/restore-data.sh` 로 한다(FIX3 — 임시 폴더에 먼저 풀고 검증한 뒤 교체, 실패하면 되돌림).

  ```sh
  set -eu
  sudo systemctl stop content-studio
  sudo bash /srv/content-studio/repo/Content_Studio_Execution_Pack/deploy/scripts/restore-data.sh /srv/content-studio-backup/<사본 파일 이름>.tar.gz
  ```

| 단계 | 내용 |
| --- | --- |
| 실행 조건 | 잠금(flock — 다른 배포 스크립트 실행 중이면 거부), root, 서비스 정지 확인(조회 실패면 중단), 데이터 폴더 **아래 하위 마운트(bind 포함)가 있으면 거부**(`/proc/self/mountinfo` — 못 읽으면 거부), `.data-must-be-mount` 표시가 있으면 지금 마운트여야 함, 데이터 폴더·부모 폴더가 심볼릭 링크가 아님, `mountpoint` 로 마운트 여부 확인(명령이 없거나 오류면 중단 — 일반 폴더로 가정하지 않음) |
| 1. 사본 검사(아무것도 바꾸기 전) | 항목 이름에 줄바꿈·제어 문자·역슬래시·UTF-8 이 아닌 바이트가 있으면 거부(PAX 긴 이름은 허용). `tar -tv` 로 항목 형식을 본다 — **일반 파일·폴더만** 허용(심볼릭 링크·하드링크·장치·FIFO 거부), 경로는 모두 `data/` 아래(절대 경로·`.`·`..`·빈 칸 거부), 최상위 `data` 는 폴더 |
| 2. 지금 데이터·직전 사본 | FIX5: 먼저 **지금 데이터**도 사본과 같은 검사(특수 항목·하드링크·이름 규칙·하위 마운트)를 통과해야 한다 — 통과하지 못하면 아무것도 바꾸지 않고 거부. 그다음 지금 데이터를 `/srv/content-studio-backup/data-before-restore-<UTC 시각>.<고유>.tar.gz`(600)로 남긴다 — `mktemp` 로 **배타적으로 만든 고유 이름**이라 같은 초에 두 번 실행해도, 직전 사본을 입력으로 다시 실행해도 덮어쓰지 않는다(입력과 같은 파일이면 중단). 만든 직전 사본도 **들어오는 사본과 같은 검사**를 통과해야 교체를 시작한다(아니면 그 사본을 지우고 거부) |
| 3. 임시 폴더에 풀기 | `--no-same-owner --no-same-permissions --no-overwrite-dir` 로, 같은 파일 시스템의 새 임시 폴더(`mktemp -d`) — 일반 폴더면 `/srv/content-studio/.restore-stage.*`, 마운트 지점이면 마운트 안 `data/.restore-stage.*`. 풀고 나서 다시 확인(일반 파일·폴더 밖 항목 0, 최상위는 실제 폴더 `data` 하나). 소유자 `content-studio`·700 은 이 확인 뒤에만(링크를 따라가지 않음) |
| 4a. 일반 폴더 | 지금 `data` 를 `data.replaced-<시각>.<고유>/data` 로 옮긴 뒤 임시 `data` 를 제자리로. 둘째 단계가 실패하면 **옮겨 둔 폴더를 되돌리고 서비스 사용자 소유·폴더 700·파일 600 을 다시 적용·확인한 뒤** 실패로 끝낸다 |
| 4b. 마운트 지점 | 폴더(마운트)는 그대로(mv 하지 않음). 안의 내용(임시 폴더 제외)을 지우고 임시 `data` 의 내용을 옮긴다. 실패하면 2 의 직전 사본을 (임시 폴더에 풀기·확인·소유자 적용까지 정상 복원과 같은 절차로) 같은 방식(임시 폴더에 풀고 검증 → 채우기)으로 **자동 복구**하고 실패로 끝낸다 |
| 5. 정리 | 임시 폴더는 성공·실패와 관계없이 지운다. 일반 폴더의 `data.replaced-*` 와 직전 사본은 남긴다(확인 뒤 사용자가 정리) |

- **복원이 실패로 끝났을 때**: 서비스는 정지 상태 그대로 둔다. 위 4a·4b 의 되돌림이 성공했으면 데이터는 복원 직전 상태다 — 원인(공간·권한)을 해결하고 같은 명령을 다시 실행한다.
- **되돌림까지 실패해 데이터 폴더가 없는 상태**(일반 폴더 4a 에서 이전 폴더를 되돌리지도 못한 경우 — 메시지가 `data.replaced-*/data` 위치와 직전 사본을 알려 준다): 원인을 해결한 뒤 `--data-missing-ok` 로 직전 사본(또는 원하는 사본)을 복원한다. 이 표시는 데이터 폴더가 **없을 때만** 받아들인다(있으면 중단).
  ```sh
  sudo bash /srv/content-studio/repo/Content_Studio_Execution_Pack/deploy/scripts/restore-data.sh --data-missing-ok /srv/content-studio-backup/data-before-restore-<시각>.<고유>.tar.gz
  ```
  (또는 `data.replaced-*/data` 를 직접 `/srv/content-studio/data` 로 되돌려도 된다 — 같은 파일 시스템 안의 이름 바꾸기)
- 마운트 지점에서 자동 복구까지 실패하면 데이터 폴더(마운트)는 남아 있지만 내용이 불완전하다. 원인을 해결한 뒤 직전 사본으로 같은 명령(표시 없이)을 다시 실행한다.
- **공급자 볼륨 스냅숏**으로 되돌릴 때(마운트 구성에서 선택): 서비스 정지 → 공급자 화면·CLI 로 데이터 볼륨을 업그레이드 전 스냅숏으로 복구(볼륨 분리·재연결이 필요하면 그 절차대로, 마운트 경로는 `/srv/content-studio/data` 유지) → `findmnt /srv/content-studio/data` 로 마운트 확인 → 시작. 스냅숏은 서비스가 멈춘 상태에서 만든 것만 쓴다(실행 중 스냅숏은 PGlite 일관성 미보장). 공급자 절차는 공급자를 정한 뒤 기록한다(미정).
- 정지 상태 사본이 없으면: 이전 SHA + 빈 데이터 폴더로 시작 → export ZIP 을 복원(`/ops` 복원 미리보기 → `empty_only` 확정). 원격 SNS 게시물은 없다(게시 disabled).
- 스크립트의 `CS_*` 환경변수(경로·systemctl 바꿔치기 등)는 시험 실행기(`deploy/scripts/tests/`)용이며, 시험 표식이 없거나 root 로 실행하면 무시된다 — 운영에서는 설정하지 않는다.

## 9. 운영 중 확인
- `journalctl -u content-studio` 의 `[inline-worker] 주기 처리 실패: <오류 이름(코드)>` — 이름·코드는 허용 목록에 있는 것만 남고 나머지는 `UnknownError`/`NonErrorThrown`. 메시지·값은 남기지 않는다. 실패해도 서버는 계속 돌고 다음 주기에 다시 시도한다.
- 서버가 오래 멈췄다 돌아오면 예약 시각이 60분 넘게 지난 **첫 전송**은 보내지 않고 "보류(BLOCKED) — 예약 시각이 오래 지나 자동으로 보내지 않음"으로 남는다(docs/07). 화면에서 확인한 뒤 그 항목의 "재시도"를 누르면 확인이 기록되고 그때 보낸다(지금은 모의 전송만). 확인 뒤 승인·내용·예약이 바뀌면 그 확인은 효력이 없다.
- 백업 나이(24시간)는 `/ops` 에 표시된다. 자동 일별 export 는 없다.

## 10. 하지 않은 것·남은 위험
- 실제 서버·Caddy·systemd·인증서·방화벽에서 한 번도 실행하지 않았다. 스크립트는 `deploy/scripts/tests/run-all.sh`(가짜 systemctl·mountpoint·id 로 동작 확인, pnpm 불필요)로만 시험했다. unit 의 보호 설정(`ProtectSystem=strict`·`ReadWritePaths`)이 PGlite·Next 와 맞는지 실측하지 않았다 — 처음 시작 때 `journalctl` 로 확인한다. `SystemCallFilter` 는 넣지 않았다. shellcheck 는 이 PC 에 없어 돌리지 않았다(bash -n 만).
- OIDC 로그인은 프로세스 안 가짜 IdP 로만 시험했다 — 실제 IdP(discovery 문서·키 교체·시계 오차·email_verified 표기)와의 동작은 확인하지 않았다(not_run).
- CSP 헤더 없음(Next 인라인 스크립트 nonce 필요). 프록시 수준 요청 제한(rate limit) 없음 — 로그인 횟수 제한은 앱(T21-P1a/b)에 있다.
- 주기 처리는 웹 요청과 같은 프로세스에서 돈다. 부하에서의 응답 지연은 측정하지 않았다(T21_DEPLOY_REVIEW §5-5).
- 서버 밖 백업 위치는 아직 정하지 않았다(T21-P4).
