# TeamAI

[English](README.md) · **한국어** · [日本語](README.ja.md) · [中文](README.zh-CN.md) · [Español](README.es.md)

TeamAI는 **Claude Code**와 공식 **Codex CLI**를 위한 로컬 다중 계정 릴레이입니다. 제공자별로 별도의 계정 풀을 유지하며, 선택된 구독 계정을 쓸 수 없거나 할당량이 소진되면 다른 계정으로 요청을 재시도합니다.

![TeamAI 대시보드](docs/dashboard.png)

<sub>위 대시보드는 캡처가 아니라 <a href="docs/render-dashboard.py">docs/render-dashboard.py</a>가 생성한 이미지입니다. 실제 계정 이름이 저장소에 남지 않도록 하기 위함입니다.</sub>

> TeamAI는 독립적인 오픈소스 프로젝트입니다. Anthropic, OpenAI, 그리고 이와 무관한 teamai.com 서비스와 아무런 관련이 없습니다.

## 요구 사항

- Node.js 20 이상
- macOS 또는 Linux
- `claude` 및/또는 `codex` 별도 설치
- 본인 소유의 Claude Pro/Max 또는 ChatGPT Codex 구독 계정

## 설치

```bash
git clone https://github.com/soulduse/team-ai.git
cd team-ai
./scripts/install.sh
```

`install.sh`는 의존성 설치, 빌드, `teamai`/`tai`/`tac`/`tax` 명령 링크를 수행하고 셸 블록 추가 여부를 묻습니다. 멱등적이므로 업그레이드할 때 다시 실행하면 됩니다. 셸 블록을 건너뛰려면 `--no-shell`, 실제 변경 없이 계획만 보려면 `--dry-run`을 씁니다.

수동으로 하려면:

```bash
npm install
npm run build          # 필수: dist/는 저장소에 포함되지 않습니다
npm link
```

AI 에이전트로 설치를 자동화하시나요? [AGENTS.md](AGENTS.md)에 같은 절차가 검증 단계와 실패 분기를 갖춘 결정적 명령으로 정리돼 있습니다.

## 빠른 시작

```bash
teamai login
tai
```

`login`은 `[1] Claude` 또는 `[2] Codex` 중 무엇을 추가할지 묻습니다. 계정을 더 넣으려면 반복 실행하세요. `tai`는 짧은 세션 명령이며 `teamai start`와 동일합니다 — 로컬 릴레이를 띄우고 대시보드를 엽니다. TUI에서 `1`을 누르면 Claude Code가, `2`를 누르면 Codex가 실행됩니다. 클라이언트를 종료하면 대시보드로 돌아옵니다.

특정 제공자로 바로 세션을 시작하려면 전용 런처를 씁니다. 필요하면 릴레이를 자동으로 띄우고, 뒤에 붙인 인자를 모두 공식 클라이언트에 그대로 전달합니다.

```bash
tac                   # TeamAI 계정 풀을 통한 Claude Code
tac --resume          # teamai claude --resume 와 동일
tax                   # TeamAI 계정 풀을 통한 Codex
tax resume            # teamai codex resume 와 동일
teamai claude         # tac의 긴 형태
teamai codex          # tax의 긴 형태
teamai session        # [1] Claude / [2] Codex 대화식 선택
```

이름은 기존 TeamClaude의 `tc` 셸 함수를 덮어쓰지 않도록 의도적으로 피했습니다. `tc`는 계속 TeamClaude를, `tac`과 `tax`는 TeamAI를 가리킵니다.

## 셸 설정

```bash
./scripts/install-shell.sh            # ~/.zshrc에 마커로 감싼 블록 추가
./scripts/install-shell.sh --dry-run  # diff만 출력, 파일은 쓰지 않음
./scripts/install-shell.sh --uninstall
```

풀을 경유하는 `cl`(Claude Code)과 `co`(Codex), 그리고 `tai`, `tais`, LaunchAgent용 `taistart`/`tairestart`/`taistop`을 정의하고, 전역으로 고정된 `ANTHROPIC_BASE_URL`을 해제합니다 — TeamAI는 세션마다 자체 포트를 가리키므로, 남아 있는 전역 값은 이미 죽었을 수도 있는 프록시로 트래픽을 보낼 뿐입니다. 블록은 마커로 구분되어 제자리에서 다시 쓰이므로, 재실행하면 덧붙지 않고 갱신됩니다. 쓸 때마다 타임스탬프가 붙은 백업이 남고, 설치/제거를 반복해도 파일이 바이트 단위로 복원됩니다.

수퍼바이저는 선택 사항입니다. `cl`, `co`, `tai`, `teamai run` 모두 아무것도 리스닝하고 있지 않으면 스스로 릴레이를 띄우므로, LaunchAgent가 내려갔거나 실패했거나 애초에 설치되지 않았어도 계속 동작합니다. 죽은 프로세스가 남긴 오래된 `server.json`은 무시하고 교체합니다. 기동이 실패하면 "did not start"라는 맨 문장 대신 서버가 알려준 이유(포트 사용 중, 읽을 수 없는 자격증명 파일 등)를 보고하며, 전체 출력은 `~/.config/teamai/server-start.log`에 남습니다.

### 릴레이를 로그인 항목으로 실행하기

선택 사항입니다. 위에서 설치된 `taistart`/`tairestart`/`taistop` 별칭은 `com.teamai.proxy` 라벨의 LaunchAgent를 제어하므로, 라벨을 정확히 그대로 써야 합니다.

```xml
<!-- ~/Library/LaunchAgents/com.teamai.proxy.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>          <string>com.teamai.proxy</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/ABSOLUTE/PATH/TO/team-ai/dist/src/cli.js</string>
    <string>server</string>
  </array>
  <key>RunAtLoad</key>      <true/>
  <key>KeepAlive</key>      <true/>
  <key>StandardErrorPath</key> <string>/tmp/teamai.err.log</string>
</dict>
</plist>
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.teamai.proxy.plist
```

Node 경로는 `command -v node`로 확인한 실제 경로를 넣으세요. LaunchAgent는 셸의 PATH를 물려받지 않습니다.

## 계정

Codex는 평소의 브라우저 로그인 절차를 그대로 씁니다. TeamAI는 ChatGPT의 선택적 기기 코드(device-code) 인증 설정을 켜둘 것을 요구하지 않습니다.

자격증명 가져오기는 선택 사항이며, 내보내기 가능한 자격증명 파일이 있을 때만 동작합니다.

```bash
# 기존 TeamClaude 설정에서 모든 계정 가져오기
teamai import claude --from ~/.config/teamclaude.json

# Codex CLI의 현재 파일 기반 로그인 가져오기 (존재할 경우)
teamai import codex
```

최근 버전의 Claude Code는 자격증명을 `~/.claude/.credentials.json` 대신 macOS 키체인에 저장할 수 있습니다. 그 경우에는 `teamai login`을 쓰세요. `import`는 원본 TeamClaude·Claude Code·Codex 파일을 절대 수정하지 않습니다. TeamAI는 릴레이 세션용으로 격리된 Codex 홈을 따로 유지하므로 사용자의 원래 `~/.codex`는 그대로 남습니다.

## 운영

```bash
teamai status                                  # 서버 상태 + 계정 표
teamai accounts [claude|codex]                 # 계정 표만
teamai start                                   # 릴레이 기동 후 대시보드
teamai stop                                    # 릴레이 중지
teamai restart                                 # 중지 후 재기동, 대시보드
teamai server                                  # 릴레이를 포그라운드로 실행
teamai tui                                     # 대시보드만 (자동 기동 없음)
teamai disable codex user@example.com
teamai enable codex user@example.com
teamai priority claude user@example.com 1      # 또는: auto
```

계정은 남은 할당량이 많은 순(적게 쓴 순)으로 정렬되며, 대시보드와 풀의 실제 선택 로직이 같은 순서를 씁니다 — 맨 윗줄이 다음 요청이 나갈 계정입니다. Claude는 전체 주간 창이 아니라 모델별 주간(Fable) 창으로 판정하는데, 최상위 모델을 먼저 거절하는 것이 실제로 그 창이기 때문입니다. 모든 계정이 소진되면 전부 동점이 되고, 그때는 가장 먼저 풀리는 순으로 넘어갑니다 — 오늘 아무도 요청을 처리할 수 없는 상황에서는 리셋까지 남은 시간만이 계정을 구분하는 유일한 기준입니다(Claude는 Fable 창, Codex는 주간 창 기준). 측정되지 않은 계정은 맨 뒤로 갑니다(알 수 없음은 비어 있음과 다릅니다). 고정된 우선순위는 여전히 우선하며, `c`로 설정된 순서로 되돌릴 수 있습니다.

전체 화면 TUI는 Claude와 Codex 계정을 그룹으로 묶고, 사용량이 바뀌어도 현재 선택된 계정을 고정해 둡니다. Claude 행은 `5h session`, `7d overall`, 모델 범위의 `7d Fable` 창을 각각 보여주고, Codex 행은 주/부 창을 해당 계정이 실제로 보고한 기간을 제목으로 달아(`1w limit`) 보여줍니다. 할당량은 공식 클라이언트 응답에서 학습하며 재시작해도 유지됩니다.

푸터는 TeamClaude와 동일한 계정 워크플로를 제공합니다 — Claude/Codex 실행, 선택, 전환, 활성/비활성, 순서, 삭제, 추가/로그인, 재측정(`R`), 종료. `switch`는 선택한 계정을 해당 제공자 풀의 맨 앞에 고정합니다. 순서 모드에서는 순위를 지정하거나 계정을 자동 스케줄링으로 되돌릴 수 있습니다. Claude 프로필을 갱신하면 요금제 등급과 `past_due` 같은 비정상 구독 상태가 빨간색으로 표시됩니다.

`R`은 전체 계정의 할당량을 다시 측정합니다. 할당량은 별도 엔드포인트를 폴링해서 얻는 것이 아니라 업스트림이 돌려주는 rate-limit 헤더에서 학습하므로, 트래픽을 한 번도 처리하지 않은 계정은 무언가 측정하기 전까지 `-`로 표시됩니다. `R`은 이미 수용된 것으로 확인된 요청 형태를 유휴 상태의 모든 계정에 병렬로 재생하고(이미 측정된 계정과 스로틀된 계정도 포함 — 그쪽 429 응답도 신뢰할 수 있는 헤더를 담고 있습니다) `measured/targets` 개수를 정직하게 보고합니다. 그 요청 형태는 프록시를 실제로 통과한 2xx 응답에서만 확정되므로, 요청이 한 번도 성공하지 않았다면 `R`은 페이로드를 추측하는 대신 아직 프로브 템플릿이 없다고 알립니다. 모델 범위 주간(Fable) 창이 없는 계정에는 보충 프로브를 한 번 더 보냅니다 — 그 창은 Fable 등급 요청에 대한 응답에만 나타나기 때문입니다.

서버는 5분마다 스스로 워밍업도 합니다(`warmupIntervalMs`, `0`이면 비활성화). 업스트림에서 이미 리셋된 할당량 창을 정리하고 아직 측정되지 않은 계정만 측정하므로, 안정된 상태에서는 틱당 비용이 들지 않고 창이 넘어가면 `R`을 누르지 않아도 다시 채워집니다. 업스트림이 끝내 할당량을 보고하지 않는 계정은 세 번 헛수고한 뒤 제외되며, 해당 창이 리셋되거나 `R`을 누르면 그 예산이 다시 주어집니다.

`~D-N` 구독 값은 확정된 만료일이 아니라 추정치입니다. Anthropic의 프로필 엔드포인트는 구독 상태와 생성 시각은 주지만 현재 청구 주기의 종료일은 주지 않습니다. 그래서 TeamAI는 다음 월간 청구 기념일을 추정하고 `~`로 표시합니다. 프로필 상태는 서버 기동 시와 이후 6시간마다 갱신됩니다.

## 설정

설정과 자격증명은 `$TEAMAI_HOME`에 저장되며, 없으면 `$XDG_CONFIG_HOME/teamai`, 그다음 `~/.config/teamai` 순으로 결정됩니다. 프록시는 `127.0.0.1`에 바인딩하며 생성된 로컬 클라이언트 토큰을 요구합니다.

`config.json`은 첫 실행 시 다음 기본값으로 생성됩니다.

| 키 | 기본값 | 의미 |
| --- | --- | --- |
| `proxy.host` | `127.0.0.1` | 바인드 주소. 설계상 루프백 전용. |
| `proxy.claudePort` | `3456` | Claude 릴레이 포트. |
| `proxy.codexPort` | `3457` | Codex 릴레이 포트. |
| `proxy.controlPort` | `3556` | TUI가 통신하는 제어 채널. |
| `proxy.clientToken` | 자동 생성 | 릴레이되는 모든 클라이언트가 보내야 하는 로컬 토큰. |
| `switchThreshold` | `0.98` | 이 사용률을 넘으면 해당 계정을 더 이상 선택하지 않음. |
| `warmupIntervalMs` | `300000` | 백그라운드 재측정 주기. `0`이면 비활성화. |
| `maxConcurrentPerAccount` | `3` | 계정당 동시 처리 요청 수. |

다른 프로세스가 포트를 이미 점유하고 있다면 포트를 바꾸세요. 기동 실패의 가장 흔한 원인이며, 이유는 `server-start.log`에 남습니다.

## 범위와 준수 사항

0.1 버전은 구독 OAuth 계정과 래퍼로 실행하는 CLI 세션을 대상으로 합니다. 공개 OpenAI 호환 API를 제공하지 않고, Claude 요청을 Codex 요청으로 변환하지 않으며, Codex Desktop을 지원하지 않고, 서로 다른 사람의 자격증명을 함께 묶지 않습니다. 제공자의 약관과 정책 준수 책임은 사용자에게 있습니다. 프로덕션·상업용 API 워크로드에는 제공자의 공식 API 과금 체계를 쓰세요.

## 개발

```bash
npm run typecheck
npm test
npm run lint
```

파생 저작물 관련은 [NOTICE](NOTICE), 로컬 보안 모델은 [SECURITY.md](SECURITY.md)를 참고하세요.
