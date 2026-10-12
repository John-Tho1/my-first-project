# Content Studio 운영 배포 절차(초안, T21-P2 · FIX1)

> **지금은 배포할 수 없다.** 운영 로그인(OIDC, T21-P1b)이 아직 구현되지 않았다. 운영 빌드에서는 `AUTH_MODE=dev` 가 거부되고(T21-P1a), `AUTH_MODE=oidc` 는 모든 로그인을 거부한다. 이 폴더의 파일로 서버를 띄우면 생존 확인(`/api/health`)만 되고 아무도 로그인할 수 없다.
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
sudo -u content-studio -H git clone <저장소 URL> /srv/content-studio/repo
test -f /srv/content-studio/repo/Content_Studio_Execution_Pack/pnpm-workspace.yaml   # 앱 루트 확인
```
- `/srv/content-studio/data` 는 재시작·재배포·서버 재생성 뒤에도 남는 디스크여야 한다(공급자 볼륨을 쓰면 여기에 마운트).
- 방화벽: 22 = 사용자 IP 만, 80·443 공개. **3000 은 열지 않는다**(web 은 127.0.0.1 에서만 듣는다).

## 3. 빌드(지정 SHA)
`deploy/scripts/build-release.sh` 를 쓴다. `set -euo pipefail` 로 어느 단계든 실패하면 바로 멈추고, 아래를 순서대로 확인한다: 인수가 40자리 SHA → 서비스 사용자로 실행 → 서비스가 멈춰 있음 → 추적 파일 변경 없음 → `git fetch` → 커밋 존재 → `git checkout --detach <SHA>` → **`git rev-parse HEAD` 가 요청 SHA 와 같음** → 앱 루트에 `.env`·`.env.local` 없음 → `pnpm install --frozen-lockfile` → `pnpm build` → `apps/web/.next/BUILD_ID` 존재.

```sh
sudo systemctl stop content-studio 2>/dev/null || true     # 처음 설치 때는 서비스가 없다
sudo -u content-studio -H bash /srv/content-studio/repo/Content_Studio_Execution_Pack/deploy/scripts/build-release.sh <40자리 SHA>
echo "exit=$?"                                              # 0 이 아니면 멈춘다(이전 빌드를 그대로 시작하지 않는다)
```
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
- 환경 파일이 없으면 systemd 가 서비스를 시작하지 않는다(`EnvironmentFile=` 에 `-` 를 붙이지 않았다).
- `WORKER_INLINE_INTERVAL_SECONDS`: 0(끔) 또는 5~600 초. 0 이면 예약 작업·업로드 24시간 만료 정리·`RETENTION_SWEEP_MODE=auto`·주기 수집이 로그인한 요청이 있을 때만 진행되고, 서버 시작 로그에 경고가 남는다.

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
- 로그인: P1b 전에는 거부되는 것이 정상이다.

## 7. 업그레이드(새 SHA)
migration 은 **앞으로만** 적용된다(G8 — 첫 DB 연결 때 자동 적용, down migration 없음). 그래서 업그레이드 전에 반드시 백업한다. 각 단계는 앞 단계가 성공했을 때만 한다.
1. **앱 export ZIP(정본 백업)** — 화면 `/ops` 또는 `POST /api/exports`(로그인 필요 — P1b 이후). 만든 ZIP 을 서버 밖(사용자 PC 등, T21-P4 에서 정한 위치)으로 옮긴다.
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
   스크립트는 root 확인 → 서비스 정지 확인 → `/srv/content-studio-backup`(root 700) 생성 → `data-<UTC 시각>-<SHA>.tar.gz`(600) → 다시 읽기 확인. 이 사본도 서버 밖으로 옮겨야 디스크 고장에 대비된다(G5·T21-P4).
3. 코드 갱신·빌드: §3 `build-release.sh <새 SHA>`(서비스 정지 상태). 종료 코드가 0 이 아니면 4 로 가지 않는다 — §8 로 되돌린다.
4. `sudo bash $APP_ROOT/deploy/scripts/check-env.sh` → `sudo systemctl start content-studio` → §5 확인(health·로그). 첫 연결에서 migration 이 적용된다.
5. 결과(이전·새 SHA, 명령, pass/fail)를 기록한다.

## 8. 되돌리기
- **코드만 되돌리지 않는다.** 새 migration 이 이미 적용된 DB 를 이전 코드로 열면 안 된다(지원하지 않음).
- 순서: 서비스 정지 → `build-release.sh <이전 SHA>` → 데이터 폴더를 §7-2 사본으로 교체 → 시작 → §5 확인.
  ```sh
  set -eu
  sudo systemctl stop content-studio
  sudo mv /srv/content-studio/data "/srv/content-studio/data.failed-$(date -u +%Y%m%dT%H%M%SZ)"
  sudo tar -C /srv/content-studio -xzf /srv/content-studio-backup/<사본 파일 이름>.tar.gz
  sudo chown -R content-studio:content-studio /srv/content-studio/data
  sudo chmod 700 /srv/content-studio/data
  ```
- 정지 상태 사본이 없으면: 이전 SHA + 빈 데이터 폴더로 시작 → export ZIP 을 복원(`/ops` 복원 미리보기 → `empty_only` 확정). 원격 SNS 게시물은 없다(게시 disabled).

## 9. 운영 중 확인
- `journalctl -u content-studio` 의 `[inline-worker] 주기 처리 실패: <오류 이름(코드)>` — 이름·코드는 허용 목록에 있는 것만 남고 나머지는 `UnknownError`/`NonErrorThrown`. 메시지·값은 남기지 않는다. 실패해도 서버는 계속 돌고 다음 주기에 다시 시도한다.
- 서버가 오래 멈췄다 돌아오면 예약 시각이 60분 넘게 지난 **첫 전송**은 보내지 않고 "보류(BLOCKED) — 예약 시각이 오래 지나 자동으로 보내지 않음"으로 남는다(docs/07). 화면에서 확인한 뒤 그 항목의 "재시도"를 누르면 확인이 기록되고 그때 보낸다(지금은 모의 전송만). 확인 뒤 승인·내용·예약이 바뀌면 그 확인은 효력이 없다.
- 백업 나이(24시간)는 `/ops` 에 표시된다. 자동 일별 export 는 없다.

## 10. 하지 않은 것·남은 위험
- 실제 서버·Caddy·systemd·인증서·방화벽에서 한 번도 실행하지 않았다. unit 의 보호 설정(`ProtectSystem=strict`·`ReadWritePaths`)이 PGlite·Next 와 맞는지 실측하지 않았다 — 처음 시작 때 `journalctl` 로 확인한다. `SystemCallFilter` 는 넣지 않았다. shellcheck 는 이 PC 에 없어 돌리지 않았다(bash -n 만).
- CSP 헤더 없음(Next 인라인 스크립트 nonce 필요). 프록시 수준 요청 제한(rate limit) 없음 — 로그인 횟수 제한은 앱(T21-P1a/b)에 있다.
- 주기 처리는 웹 요청과 같은 프로세스에서 돈다. 부하에서의 응답 지연은 측정하지 않았다(T21_DEPLOY_REVIEW §5-5).
- 서버 밖 백업 위치는 아직 정하지 않았다(T21-P4).
