# Happy CLI

모델 관리, 토큰 모니터링, 실시간 세션 제어 등 강력한 기능을 제공하는 Claude Code용 모바일 및 Web 클라이언트.

무료. 오픈소스. 어디서나 코딩하세요.

## 설치

```bash
npm install -g happy-coder
```

## 빠른 시작

```bash
happy
```

이 명령은 다음을 수행합니다:
1. 모바일 제어가 활성화된 Claude Code 세션 시작
2. 모바일 기기에서 연결할 수 있는 QR 코드 표시
3. Claude Code와 모바일 앱 간 실시간 세션 공유 허용
4. 모델 전환 및 토큰 모니터링 등 고급 기능 활성화

## 주요 명령

### 세션 제어
- `happy` - 모바일 제어와 함께 새 Claude 세션 시작
- `happy --resume` - 이전 세션 계속 진행
- `happy --yolo` - 권한 바이패스로 세션 시작 (자동화용)
- `happy --to <model>` - 특정 모델로 전환 (예: claude-3-5-haiku)
- `happy --yolo --to <model>` - 모델 전환 후 세션 시작 (예: GLM)

### 모델 관리
- `happy --seeall` - 사용 가능한 모든 모델 목록 표시
- `happy --toadd <name>` - 새 모델 프로필 추가
- `happy --del <name>` - 모델 프로필 제거
- `happy --upd <name>` - 모델 프로필 업데이트
- `happy --auto <pattern>` - 자동 모델 전환 (expensive|cheap|balanced)
- `happy --exp <file>` - 모델 설정 내보내기
- `happy --imp <file>` - 모델 설정 가져오기

### 토큰 모니터링
- `happy --stats` - 일일 토큰 사용량 보기
- `happy --watch` - 실시간 토큰 모니터링
- `happy --f compact` - 간결한 출력 형식
- `happy --f table` - 표 형식 출력
- `happy --f json` - JSON 출력 형식
- `happy daily` - 일별 통계 그룹화
- `happy weekly` - 주별 통계 그룹화
- `happy monthly` - 월별 통계 그룹화
- `happy --since 20240101` - 날짜 기준 필터 (시작일)
- `happy --until 20241231` - 날짜 기준 필터 (종료일)

### 대시보드
- `happy --dashboard` - 실시간 모니터링 대시보드 열기

### 유틸리티 명령
- `happy auth` – 인증 및 머신 설정 관리
- `happy auth login` – 서비스에 인증
- `happy auth logout` – 인증 정보 제거
- `happy connect` – AI 벤더 API 키를 Happy 클라우드에 연결
- `happy notify -p "message"` – 디바이스에 푸시 알림 보내기
- `happy codex` – Codex 모드 시작 (MCP 브리지)
- `happy daemon` – 백그라운드 서비스 관리
- `happy doctor` – 시스템 진단 및 문제 해결
- `happy doctor clean` –失控한 프로세스 정리

### 데몬 관리
- `happy daemon start` – 백그라운드 데몬 시작
- `happy daemon stop` – 데몬 중지 (세션은 계속 유지)
- `happy daemon status` – 데몬 상태 표시
- `happy daemon list` – 활성 세션 목록 표시
- `happy daemon stop-session <id>` – 특정 세션 중지
- `happy daemon logs` – 데몬 로그 파일 경로 표시
- `happy daemon install` – 데몬 서비스 설치
- `happy daemon uninstall` – 데몬 서비스 제거

## 옵션

### 일반 옵션
- `-h, --help` - 도움말 표시
- `-v, --version` - 버전 표시
- `--started-by <mode>` - 시작 방식 (daemon|terminal)
- `--happy-starting-mode <mode>` - 시작 모드 (local|remote)

### 모델 및 권한 옵션
- `-m, --model <model>` - 사용할 Claude 모델 (기본값: sonnet)
- `-p, --permission-mode <mode>` - 권한 모드: auto, default, plan
- `--yolo` - 모든 권한 바이패스 (위험)
- `--dangerously-skip-permissions` - 권한 검사 건너뛰기 (--yolo와 동일)

### Claude 통합
- `--claude-env KEY=VALUE` - Claude Code 환경 변수 설정
- `--claude-arg ARG` - Claude CLI에 추가 인수 전달
- `--resume` - 이전 세션 계속 진행
- **Happy는 모든 Claude 옵션을 지원합니다!** - claude와 함께 사용하는 모든 플래그를 happy와 함께 사용할 수 있습니다

## 환경 변수

### 서버 구성
- `HAPPY_SERVER_URL` - 사용자 정의 서버 URL (기본값: https://api.happy-servers.com)
- `HAPPY_WEBAPP_URL` - 사용자 정의 웹 앱 URL (기본값: https://app.happy.engineering)
- `HAPPY_HOME_DIR` - Happy 데이터용 사용자 정의 홈 디렉토리 (기본값: ~/.happy)

### 시스템
- `HAPPY_DISABLE_CAFFEINATE` - macOS 수면 방지 비활성화 (`true`, `1`, 또는 `yes`로 설정)
- `HAPPY_EXPERIMENTAL` - 실험적 기능 활성화 (`true`, `1`, 또는 `yes`로 설정)

### Claude 통합
- `ANTHROPIC_DEFAULT_SONNET_MODEL` - 기본 Sonnet 모델 덮어쓰기
- `ANTHROPIC_MODEL` - 기본 Claude 모델 설정
- `ANTHROPIC_BASE_URL` - 사용자 정의 Anthropic API 베이스 URL
- `ANTHROPIC_AUTH_TOKEN` - Anthropic API 인증 토큰

## 예제

### 세션 시작
```bash
happy                          # 새 세션 시작
happy --resume                 # 이전 세션 계속 진행
happy --yolo                   # 권한 바이패스로 시작
```

### 모델 관리
```bash
happy --to claude-3-5-haiku    # Haiku 모델로 전환
happy --yolo --to GLM          # GLM으로 전환 후 시작
happy --seeall                 # 사용 가능한 모든 모델 표시
happy --toadd my-model         # 사용자 정의 모델 추가
```

### 토큰 모니터링
```bash
happy --stats                  # 일일 토큰 사용량 보기
happy --watch                  # 실시간 모니터링
happy --stats -f compact       # 간결한 형식
happy --stats weekly           # 주별 그룹화
happy --stats --since 20240101 --until 20241231  # 날짜 범위
```

### 고급 사용
```bash
happy --dashboard              # 실시간 대시보드 열기
happy auth login --force       # 재인증
happy notify -p "Test"         # 알림 보내기
happy daemon status            # 데몬 상태 확인
happy doctor                   # 진단 실행
```

## 요구사항

- **Node.js >= 20.0.0**
  - `eventsource-parser@3.0.5`에 필요
  - `@modelcontextprotocol/sdk`에 필요 (권한 전달에 사용)
- **Claude CLI 설치 및 로그인됨** (PATH에서 `claude` 명령 사용 가능)

## 아키텍처

Happy CLI는 3개 구성 요소 시스템의 일부입니다:

1. **Happy CLI** (이 프로젝트) - Claude Code을 래핑하는 명령줄 인터페이스
2. **Happy** - React Native 모바일 클라이언트
3. **Happy Server** - Prisma가 포함된 Node.js 서버 (https://api.happy-servers.com/에서 호스팅)

### 주요 기능

- **듀얼 모드 작동**: 인터랙티브(터미널) 및 원격(모바일 제어)
- **엔드투엔드 암호화**: 모든 통신이 TweetNaCl으로 암호화
- **세션 지속성**: 재시작 후 세션 계속 진행
- **모델 관리**: 프로필을 통해 서로 다른 Claude 모델 간 전환
- **토큰 모니터링**: 실시간 추적 및 과거 통계
- **데몬 아키텍처**: 백그라운드 서비스가 세션 관리
- **권한 전달**: 모바일 앱이 Claude 권한 승인/거부

## 라이센스

MIT
