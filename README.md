# MySQL Backup Manager

Rocky Linux 9에서 동작하는 MySQL 백업 관리 도구입니다. Fastify 웹 UI로 백업 대상 DB를 관리하고, systemd timer가 1시간마다 Node.js CLI를 실행해 `mysqldump` 후 rclone으로 Google Drive에 동기화합니다.

## 실행 환경

- Rocky Linux 9 x86_64
- Node.js 24.14.1 / npm 11.11.0
- Redis 6.2.20 (`localhost:6379`)
- MySQL 8.0.46
- rclone v1.74.0
- Docker, Kubernetes 없음

## 설치

systemd와 SELinux Enforcing 환경에서는 프로젝트를 `/opt/mysql-backup-manager` 아래에 두는 것을 권장합니다. 홈 디렉터리 등 다른 디렉터리에서 실행하면 `.env`, 실행 파일, 작업 디렉터리 접근이 SELinux에 의해 차단될 수 있습니다.

```bash
cd /opt
sudo git clone https://github.com/syrup2525/mysql-backup-manager.git
sudo chown -R {user_name}:{user_name} /opt/mysql-backup-manager
sudo restorecon -Rv /opt/mysql-backup-manager
cd /opt/mysql-backup-manager
```

```bash
npm install
npm run build
```

환경 파일을 준비합니다.

```bash
cp .env.example .env
```

`.env.example` 기본값:

```dotenv
MODE=dev
WEB_HOST=0.0.0.0
WEB_PORT=3000
REDIS_URL=redis://127.0.0.1:6379
BACKUP_ROOT=/home/{user_name}/bak
BACKUP_KEEP_COUNT=72
RCLONE_REMOTE=gdrive
AUTH_COOKIE_NAME=session_name
AUTH_COOKIE_SECURE=false
AUTH_SESSION_TTL_SECONDS=28800
```

백업 디렉터리를 준비합니다.

```bash
sudo mkdir -p /home/{user_name}/bak
sudo chown -R {user_name}:{user_name} /home/{user_name}/bak
chmod 700 /home/{user_name}/bak
```

## 웹 UI

개발 실행:

```bash
npm run dev
```

빌드 후 실행:

```bash
npm run build
npm start
```

브라우저에서 `http://서버주소:3000`으로 접속합니다. 웹 UI에서 백업 대상 추가, 수정, 삭제, DB별 백업 파일 목록 조회를 할 수 있습니다.

Redis에는 `mysql-backup-manager:targets` hash로 백업 대상 정보가 저장됩니다.

## 웹 UI 로그인 계정

웹 UI는 로그인 후 사용할 수 있습니다. 최초 관리자 계정은 서버의 localhost Redis에 `redis-cli`로 직접 생성합니다.

아래 예시는 계정 `admin`을 생성합니다. 비밀번호는 프롬프트에서 입력받습니다.

```bash
ADMIN_USER='admin'
read -rsp 'Initial admin password: ' ADMIN_PASSWORD
echo
AUTH_SALT="$(openssl rand -hex 16)"
AUTH_HASH="$(ADMIN_PASSWORD="$ADMIN_PASSWORD" AUTH_SALT="$AUTH_SALT" node -e "const { pbkdf2Sync } = require('node:crypto'); console.log(pbkdf2Sync(process.env.ADMIN_PASSWORD, process.env.AUTH_SALT, 310000, 32, 'sha256').toString('hex'));")"
SESSION_VERSION="$(openssl rand -hex 16)"

redis-cli -h 127.0.0.1 -p 6379 HSET mysql-backup-manager:auth:user \
  username "$ADMIN_USER" \
  passwordHash "$AUTH_HASH" \
  passwordSalt "$AUTH_SALT" \
  passwordIterations "310000" \
  passwordDigest "sha256" \
  sessionVersion "$SESSION_VERSION" \
  updatedAt "$(date -Is)"
```

계정 확인:

```bash
redis-cli -h 127.0.0.1 -p 6379 HGET mysql-backup-manager:auth:user username
```

로그인 후 상단의 `비밀번호 변경` 메뉴에서 비밀번호를 변경할 수 있습니다. 비밀번호 변경 시 현재 비밀번호, 변경할 비밀번호, 변경할 비밀번호 확인을 입력해야 하며, 기존 로그인 세션은 무효화됩니다.

웹 UI 세션은 Redis에 `mysql-backup-manager:auth:sessions:*` 키로 저장되고, 기본 만료 시간은 `AUTH_SESSION_TTL_SECONDS=28800`입니다. HTTPS 뒤에서 운영할 때는 `.env`의 `AUTH_COOKIE_SECURE=true`를 사용하세요.

## rclone Google Drive 초기 설정

현재 rclone이 설치만 되어 있다면 최초 1회 remote를 생성합니다. `.env`의 `RCLONE_REMOTE=gdrive`와 같은 이름을 사용하세요.

```bash
rclone config
```

권장 흐름:

1. `n` 선택으로 새 remote 생성
2. `name>`에 `gdrive` 입력
3. Storage에서 Google Drive 선택
4. client id/secret은 별도 Google Cloud OAuth 앱이 없으면 비워둠
5. scope는 운영 정책에 맞게 선택
6. 서버에 브라우저가 없으면 auto config를 `n`으로 선택하고, 안내되는 authorize 명령을 브라우저가 있는 PC에서 실행한 뒤 token을 서버에 붙여넣음
7. 설정 완료 후 확인

```bash
rclone lsd gdrive:
rclone mkdir gdrive:/bak/dev
```

`MODE=prod`로 바꾸면 동기화 대상은 `gdrive:/bak/prod`가 됩니다.

## systemd 설정

예시 파일은 `systemd/` 디렉터리에 있습니다. 실제 설치 경로와 실행 사용자를 맞춘 뒤 복사합니다.

```bash
sudo cp systemd/mysql-backup-manager-web.service.example /etc/systemd/system/mysql-backup-manager-web.service
sudo cp systemd/mysql-backup-manager-backup.service.example /etc/systemd/system/mysql-backup-manager-backup.service
sudo cp systemd/mysql-backup-manager-backup.timer.example /etc/systemd/system/mysql-backup-manager-backup.timer
sudo systemctl daemon-reload
sudo systemctl enable --now mysql-backup-manager-web.service
sudo systemctl enable --now mysql-backup-manager-backup.timer
```

> `sudo systemctl enable --now mysql-backup-manager-web.service` 명령어 대신 아래 `PM2 설정` 으로도 가능합니다.

`mysql-backup-manager-backup.service`는 timer가 호출하는 `oneshot` 서비스입니다. 직접 `enable`하지 않고, 위처럼 `mysql-backup-manager-backup.timer`만 활성화하면 됩니다. 백업을 즉시 한 번 시험 실행하려면 아래 명령을 사용합니다.

```bash
sudo systemctl start mysql-backup-manager-backup.service
```

상태와 로그 확인:

```bash
systemctl status mysql-backup-manager-web.service
systemctl list-timers mysql-backup-manager-backup.timer
journalctl -u mysql-backup-manager-backup.service -n 100 --no-pager
```

타이머는 부팅 5분 후 처음 실행하고, 이후 마지막 실행 시점 기준 1시간마다 CLI를 실행합니다.

## PM2 설정

systemd service 대신 PM2로 웹 UI를 실행할 수도 있습니다. PM2는 웹 UI 실행에만 사용하고, `backup-runner` CLI는 위의 systemd timer로만 실행하세요.

PM2 설치:

```bash
sudo npm install -g pm2
```

웹 UI 실행:

```bash
cd /opt/mysql-backup-manager
npm install --omit=dev
npm run build
pm2 start npm \
  --name mysql-backup-manager-web \
  --cwd /opt/mysql-backup-manager \
  --time \
  -- start
pm2 save
```

상태와 로그 확인:

```bash
pm2 status
pm2 logs mysql-backup-manager-web
```

서버 재부팅 후 자동 실행되도록 systemd startup을 등록합니다. 아래 명령의 `{user_name}`와 `/home/{user_name}`는 실제 실행 계정에 맞게 바꿉니다.

```bash
pm2 startup systemd -u {user_name} --hp /home/{user_name}
```

명령 실행 후 PM2가 출력하는 `sudo env ... pm2 startup ...` 명령을 그대로 한 번 더 실행하고, 마지막으로 저장합니다.

```bash
pm2 save
```

웹 UI를 PM2로 실행하는 경우 `/etc/systemd/system/mysql-backup-manager-web.service`는 활성화하지 마세요. 같은 포트에서 두 프로세스가 동시에 실행될 수 있습니다. 백업 CLI는 PM2로 등록하지 말고 `mysql-backup-manager-backup.timer`만 사용하세요.

## 운영 메모

- `.env`의 `MODE` 값은 rclone 동기화 경로에 포함되므로 `dev`, `stage`, `prod`처럼 `/`가 없는 값으로 둡니다.
- 웹 서버와 backup-runner는 같은 `.env`와 같은 Redis를 사용해야 합니다.
- `dist/`는 빌드 산출물입니다. systemd 또는 PM2 실행 전 `npm run build`를 실행하세요.
- Redis에 DB 비밀번호가 평문 저장되므로 서버 계정, Redis 바인딩, 방화벽 접근을 제한하세요.
