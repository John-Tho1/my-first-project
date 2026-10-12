# Content Studio 운영 배포 절차(초안, T21-P2)

> **지금은 배포할 수 없다.** 운영 로그인(OIDC, T21-P1b)이 아직 구현되지 않았다. 운영 빌드에서는 `AUTH_MODE=dev` 가 거부되고(T21-P1a), `AUTH_MODE=oidc` 는 모든 로그인을 거부한다. 이 폴더의 파일로 서버를 띄우면 생존 확인(`/api/health`)만 되고 아무도 로그인할 수 없다.
>
> 이 폴더는 **파일만** 있다. 실제 서버·도메인·인증서·systemd·Caddy 에서 실행해 본 적이 없다(not_run). 공급자 가입·결제·DNS·외부 연결은 사용자 승인 범위(docs/handoffs/T21_DEPLOY_REVIEW.md §4.2)를 받은 뒤에만 한다.

## 1. 구성
- VPS 1대(권장 1 vCPU / 2 GB 이상 — 경험칙, 실측 아님), Linux + systemd. 아래 명령은 Debian/Ubuntu 계열을 가정한다.
- Caddy(:80·:443, 자동 HTTPS) → web(Next, `127.0.0.1:3000`) 한 프로세스. 작업 처리기는 web 안(inline)에서 돈다.
- 주기 처리: `WORKER_INLINE_INTERVAL_SECONDS=30`(web 안 타이머, 직전 처리가 끝난 뒤 30초 쉬고 다음 처리 — 겹치지 않음). 별도 cron·systemd timer 는 없다.
- DB 는 PGlite(영속 디스크의 폴더 하나). **한 데이터 폴더는 한 프로세스만 연다** — web 이 도는 동안 `pnpm worker`·`pnpm export`·`pnpm db:migrate` 를 같은 폴더로 돌리지 않는다.
- 배치

| 경로 | 내용 | 소유·권한 |
| --- | --- | --- |
| `/srv/content-studio/app` | 저장소 checkout + `node_modules` + `.next`(빌드 결과) | `content-studio`, 755 |
| `/srv/content-studio/data` | `pglite/`·`assets/`·`exports/`·`restores/`·`imports/` — **영속 디스크** | `content-studio`, 700 |
| `/etc/content-studio/env` | 설정·비밀(EnvironmentFile) | `root:root`, **600** |
| `/etc/systemd/system/content-studio.service` | `deploy/content-studio.service` | root, 644 |
| `/etc/caddy/Caddyfile` | `deploy/Caddyfile` | root, 644 |

- Next `output: 'standalone'` 은 **쓰지 않는다.** 서버에서 저장소 그대로 `install` + `build` 하고 `next start` 로 실행한다. 이유: (1) PGlite 는 WASM·데이터 파일을 런타임에 `node_modules` 에서 읽는다(`serverExternalPackages`) — standalone 추적 결과에 빠지는지 확인하지 않았다. (2) DB·export CLI(`pnpm export`·`pnpm db:migrate`)가 같은 checkout 의 소스(tsx)를 쓴다. (3) dev·build 설정을 바꾸지 않아도 된다.

## 2. 준비(서버에서, 한 번)
버전: Node 24.x(저장소 `engines` `>=22.12`, 로컬 검증 v24.21.0), pnpm 12.6.0(corepack — `package.json` `packageManager`), Caddy 2.x. 설치 방법·버전은 실제 설치 때 기록한다.

```sh
# 서비스 사용자(로그인 셸 없음)와 폴더
sudo useradd --system --home-dir /srv/content-studio --shell /usr/sbin/nologin content-studio
sudo install -d -o content-studio -g content-studio -m 755 /srv/content-studio /srv/content-studio/app
sudo install -d -o content-studio -g content-studio -m 700 /srv/content-studio/data
sudo install -d -o root -g root -m 755 /etc/content-studio
```
- `/srv/content-studio/data` 는 재시작·재배포·서버 재생성 뒤에도 남는 디스크여야 한다(공급자 볼륨을 쓰면 여기에 마운트).
- 방화벽: 22 = 사용자 IP 만, 80·443 공개. **3000 은 열지 않는다**(web 은 127.0.0.1 에서만 듣는다).

## 3. 코드 받기·빌드
```sh
sudo -u content-studio -H bash -lc '
  cd /srv/content-studio/app
  git clone <저장소 URL> .            # 처음 한 번
  git fetch && git checkout <리뷰 통과한 HEAD SHA>
  test ! -e .env && test ! -e .env.local   # 서버 checkout 에는 .env 파일을 두지 않는다(next.config 가 읽는다) — 설정은 /etc/content-studio/env 만
  corepack pnpm install --frozen-lockfile
  corepack pnpm build
'
```
- `build` 는 서비스를 멈춘 상태에서 한다(실행 중인 서버가 읽는 `.next` 를 덮어쓰지 않게).
- 빌드에는 비밀이 필요 없다. 종료 코드와 SHA 를 기록한다.

## 4. 환경 파일
```sh
sudo install -o root -g root -m 600 /srv/content-studio/app/deploy/content-studio.env.example /etc/content-studio/env
sudo -e /etc/content-studio/env     # APP_BASE_URL=https://<도메인>, SECRETS_MASTER_KEY(운영 전용 새 키) 등을 사용자가 직접 넣는다
```
- 예시 파일은 placeholder 뿐이다. 실제 도메인·키는 이 파일에만 둔다(저장소·대화·로그 금지).
- 고정 설정(게시·수집·OAuth live·LLM live 끔, `AUTH_MODE=oidc`)은 승인 없이 바꾸지 않는다.
- `WORKER_INLINE_INTERVAL_SECONDS`: 0(끔) 또는 5~600 초. 0 이면 예약 작업·업로드 24시간 만료 정리·`RETENTION_SWEEP_MODE=auto`·주기 수집이 로그인한 요청이 있을 때만 진행되고, 서버 시작 로그에 경고가 남는다.

## 5. 서비스 시작·확인
```sh
sudo install -o root -g root -m 644 /srv/content-studio/app/deploy/content-studio.service /etc/systemd/system/content-studio.service
sudo systemctl daemon-reload
sudo systemctl enable --now content-studio
systemctl status content-studio --no-pager
journalctl -u content-studio -n 50 --no-pager
curl -s http://127.0.0.1:3000/api/health
```
기대 결과
- 로그에 `[inline-worker] 주기 처리 시작: 30초 간격(...)` 한 줄. 설정 오류면 `[startup] 서버를 시작하지 않습니다`(dev 로그인) 또는 `[inline-worker] ... config_invalid` 이 남는다(값은 로그에 없음).
- health 응답 키는 정확히 `{ status, app, time_utc, db_ok }`, `status: "ok"`, `db_ok: true`.
- `/srv/content-studio/data/pglite` 가 생기고 소유자가 `content-studio` 다.

## 6. Caddy(HTTPS)
```sh
sudo install -o root -g root -m 644 /srv/content-studio/app/deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl edit caddy           # [Service] 아래 Environment=APP_DOMAIN=<도메인> 추가
caddy validate --config /etc/caddy/Caddyfile
sudo systemctl restart caddy
```
- DNS A 레코드가 서버 IP 를 가리킨 뒤에 인증서가 발급된다.
- 확인: `curl -sI https://<도메인>/api/health`(200, `strict-transport-security`·`x-content-type-options` 헤더, `server`·`x-powered-by` 없음), `curl -sI http://<도메인>/` 가 https 로 넘어감, 외부에서 `:3000` 접속 불가.
- 로그인: P1b 전에는 거부되는 것이 정상이다.

## 7. 업그레이드(새 SHA)
migration 은 **앞으로만** 적용된다(G8 — 첫 DB 연결 때 자동 적용, down migration 없음). 그래서 업그레이드 전에 반드시 백업한다.
1. **앱 export ZIP(정본 백업)** — 화면 `/ops` 또는 `POST /api/exports`(로그인 필요 — P1b 이후). 만든 ZIP 을 서버 밖(사용자 PC 등, T21-P4 에서 정한 위치)으로 옮긴다.
   - 로그인할 수 없으면 CLI(서비스를 멈춘 뒤 — PGlite 잠금):
     ```sh
     sudo systemctl stop content-studio
     sudo systemd-run --wait --pipe --collect --uid=content-studio --gid=content-studio \
       -p WorkingDirectory=/srv/content-studio/app -p EnvironmentFile=/etc/content-studio/env \
       -E NODE_ENV=production -E TZ=UTC /usr/bin/corepack pnpm export
     ```
     (미검증. 환경 파일을 명령줄에 펼치지 않는다 — 비밀이 프로세스 목록·셸 기록에 남지 않게)
2. **데이터 폴더 정지 상태 복사**(되돌리기용): 서비스를 멈춘 상태에서만 일관성이 있다.
   ```sh
   sudo systemctl stop content-studio
   sudo tar -C /srv/content-studio -czf /srv/content-studio-backup/data-$(date -u +%Y%m%dT%H%M%SZ)-<이전 SHA>.tar.gz data
   ```
   (`/srv/content-studio-backup` 은 root 700. 이 사본도 서버 밖으로 옮겨야 디스크 고장에 대비된다 — G5·T21-P4)
3. 코드 갱신·빌드: §3 의 `git checkout <새 SHA>` → `install --frozen-lockfile` → `build`(서비스 정지 상태).
4. `sudo systemctl start content-studio` → §5 확인(health·로그). 첫 연결에서 migration 이 적용된다.
5. 결과(이전·새 SHA, 명령, pass/fail)를 기록한다.

## 8. 되돌리기
- **코드만 되돌리지 않는다.** 새 migration 이 이미 적용된 DB 를 이전 코드로 열면 안 된다(지원하지 않음).
- 순서: 서비스 정지 → `git checkout <이전 SHA>` → `install --frozen-lockfile` → `build` → 데이터 폴더를 §7-2 사본으로 교체(`data` 를 옆으로 옮기고 tar 를 풀기, 소유자 `content-studio`) → 시작 → §5 확인.
- 정지 상태 사본이 없으면: 이전 SHA + 빈 데이터 폴더로 시작 → export ZIP 을 복원(`/ops` 복원 미리보기 → `empty_only` 확정). 원격 SNS 게시물은 없다(게시 disabled).

## 9. 운영 중 확인
- `journalctl -u content-studio` 의 `[inline-worker] 주기 처리 실패: <오류 이름(코드)>` — 메시지·값은 남기지 않는다. 실패해도 서버는 계속 돌고 다음 주기에 다시 시도한다.
- 서버가 오래 멈췄다 돌아오면 예약 시각이 60분 넘게 지난 **첫 전송**은 보내지 않고 "보류(BLOCKED) — 예약 시각이 오래 지나 자동으로 보내지 않음"으로 남는다(docs/07). 화면에서 확인한 뒤 "재시도"하면 그때 보낸다(지금은 모의 전송만).
- 백업 나이(24시간)는 `/ops` 에 표시된다. 자동 일별 export 는 없다.

## 10. 하지 않은 것·남은 위험
- 실제 서버·Caddy·systemd·인증서·방화벽에서 한 번도 실행하지 않았다. unit 의 보호 설정(`ProtectSystem=strict` 등)이 PGlite·Next 와 맞는지 실측하지 않았다 — 처음 시작 때 `journalctl` 로 확인한다. `SystemCallFilter` 는 넣지 않았다.
- CSP 헤더 없음(Next 인라인 스크립트 nonce 필요). 프록시 수준 요청 제한(rate limit) 없음 — 로그인 횟수 제한은 앱(T21-P1a/b)에 있다.
- 주기 처리는 웹 요청과 같은 프로세스에서 돈다. 부하에서의 응답 지연은 측정하지 않았다(T21_DEPLOY_REVIEW §5-5).
- 서버 밖 백업 위치는 아직 정하지 않았다(T21-P4).
