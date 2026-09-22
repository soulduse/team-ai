# Codex 429 오표시·일시 오류 복구 수정 — Claude 리뷰 인계

작성일: 2026-09-22 (KST)
저장소: `/Users/soul/Documents/projects/team-ai`
기준 HEAD: `824e74957b2013e6db1b437b55cf5080722e80cf`
상태: **작업 트리 수정 및 빌드 완료 / 독립 리뷰 대기 / 실행 중 릴레이에 미적용 / 커밋·푸시 없음**

## 1. 리뷰 요청

현재 작업 트리의 아래 변경을 독립적으로 검토해 주세요. 이 문서의 설명이나 테스트 통과를 승인 근거로 그대로 받아들이지 말고, 오류 상태 전이·재시도 횟수·사용량 보존을 코드와 테스트로 확인해 주세요.

- 주요 변경: `src/proxy.ts`, `src/providers.ts`
- 신규 테스트: `test/transient-recovery.test.ts` (**미추적 파일이므로 일반 `git diff`에 나오지 않음**)
- 문서 변경: README 5종 끝의 `<!-- transient-recovery-2026-09-22 -->` 블록
- 결과: 심각도, 파일/행, 재현 조건, 영향, 수정 제안을 포함한 findings. 문제가 없으면 미검증 범위도 명시.
- 리뷰 중 실제 OpenAI 호출, 계정 사용량 반복 조회, 실행 중 릴레이 재시작은 필요하지 않음. 로컬 모의 서버로 검증 가능.
- 다른 세션 변경을 되돌리거나 작업 트리 전체를 커밋하지 말 것.

## 2. 문제와 확인한 증거

사용자가 Codex에서 아래 오류를 경험:

```text
exceeded retry limit, last status: 429 Too Many Requests
```

TeamAI 상태 파일의 2026-09-22 16:08:25 KST 이벤트에서 다음 순서를 확인했다. 계정 주소는 생략했다.

```text
Codex POST /codex/responses → [account] 503 transient; failover
Codex POST /codex/responses → 429 quota_exhausted (fable), next reset 22h52m
```

조사 당시 저장된 Codex 계정 사용량: 1개 29%, 3개 100%. 이는 그 시점의 저장 값이며 현재 실시간 잔여량을 보증하지 않는다. 사용자가 붙여 넣은 오류에는 발생 시각이 없으므로 위 이벤트와 동일 요청이라는 상관관계까지 확정한 것은 아니다.

기존 코드의 동작:

1. 가용 계정이 503을 반환하면 `transient`로 분류하고 해당 요청의 `excluded`에 추가.
2. 다른 계정이 모두 소진이면 `acquire()`가 null 반환.
3. `explainShortfall(excluded, wantsFable)`는 이미 제외된 가용 계정을 판단에서 빼고 남은 계정의 소진만 보고 429를 생성.
4. 원래 503 및 짧은 `Retry-After`가 소진 메시지 및 긴 대기로 바뀜.
5. Codex의 `request_max_retries=0` 설정 때문에 클라이언트 HTTP 재시도에 의존할 수 없음. SSE 재시도·idle timeout은 별도 설정.

수정 전 현재 dist를 사용한 로컬 모의 서버 재현 결과:

```json
{
  "upstreamStatus": 503,
  "upstreamRetryAfter": 2,
  "relayStatus": 429,
  "relayRetryAfter": "900",
  "reason": "quota_exhausted",
  "remainingAccountUsage": 0.29
}
```

이 재현은 가짜 자격증명과 loopback 서버만 사용했다. OpenAI 요청·과금·실계정 토큰 사용은 없었다.

추가 발견: 사용량 헤더가 없을 때 `Number(null) === 0` 때문에 Codex의 primary/secondary 사용량을 0%로 읽었다. 헤더 없는 503도 기존 사용량을 덮어쓸 수 있었다.

## 3. 변경 내용

### src/proxy.ts

- `usesFableBudget`가 없는 provider의 기본값을 true → false로 변경. Codex 요청에 Fable 문구가 붙는 문제를 해결. 실제 Claude provider는 명시적 함수를 유지.
- 요청 단위 `lastFailure`에 마지막 실패 응답 및 본문 저장. 계정 선택 불가 시 상위 실패가 있었다면 원래 HTTP 상태·본문·헤더를 반환.
- 네트워크 실패 후 다음 계정을 선택할 수 없는 경우에는 합성 502를 보관해 잘못된 quota 429를 피함. 네트워크 오류의 재실행 정책을 전면 변경한 것은 아님.
- transient 실패 계정을 요청 단위 집합에 모으고, 계정 전환으로도 처리하지 못한 경우 최대 **2개 추가 라운드**를 허용.
- 대기: `max(1초 × 2^라운드, 상위 Retry-After의 남은 시간) + 0~199ms jitter`.
- 한 번의 예약 대기 ≤10초, 누적 예약 대기 ≤20초일 때만 재시도. 이를 넘는 경우 상위 오류를 그대로 클라이언트로 반환. 긴 Retry-After를 줄여서 재요청하지 않음.
- 성공 응답 또는 이미 시작한 SSE 스트림은 이 새 재시도 루프에서 재생하지 않음.
- backoff 대기 중 클라이언트 연결 종료 시 타이머·리스너를 정리하고 admission 카운터를 반환.

**상한의 정확한 의미:** ‘최대 2회’는 계정 하나 기준 일반 사례의 추가 시도 횟수이며, 구현상 전체 계정 풀의 추가 라운드 수다. 가용 계정 N개가 모두 일시 실패하면 최대 3N개의 상위 HTTP 시도가 가능하다. 20초는 backoff 합계이며, 상위 응답 대기·토큰 갱신·본문 수신을 포함한 전체 요청 처리 시간 상한이 아니다.

### src/providers.ts

- Codex 사용량 측정: absent/빈 used-percent 헤더는 측정에서 제외. 유효한 측정이 없으면 기존 상태를 유지하도록 null 반환.
- Codex 429 분류: 본문 전체의 느슨한 정규식 대신 `error.code`, `error.type`, 최상위 `code`의 명시적 소진 코드 또는 Codex 사용량 ≥100% 헤더로 소진 판정.
- `rate_limit_exceeded`, `slow_down`만으로 계정 소진을 확정하지 않음.
- **Claude와 Codex 양쪽**의 5xx 분류에서 `Retry-After` 사용. 없으면 기존 1초 기본값 사용.

### 변경하지 않은 설정

```toml
request_max_retries = 0
stream_max_retries = 5
stream_idle_timeout_ms = 1800000
```

재시도는 릴레이가 담당한다. shadow config, 사용자의 기본 Codex 설정, 로그인 정보, 셸 alias는 이번 수정에서 바꾸지 않았다.

## 4. 테스트 및 검증

실행 환경: Node `v25.7.0`. 프로젝트의 최소 Node 20에서 별도 실행한 것은 아니다.

| 검증 | 결과 |
|---|---|
| `npm run typecheck` | 통과 |
| `npm test` | **98/98 통과**, 실패·스킵 0 |
| `npm run lint` | 통과 |
| `npm run build` | 통과, dist 생성 |
| `git diff --check` | 통과 |

당시 테스트 로그: `/tmp/teamai-recovery-tests.log` (임시 파일, 영구 증거 경로 아님).

신규 테스트 6개:

1. 가용 1개 + 소진 3개, 첫 503 후 두 번째 요청 200으로 복구.
2. 지속 503이면 상위 요청 총 3회에서 종료하고 503 본문 유지.
3. Retry-After 120초이면 추가 요청 없이 503·120초 헤더 보존.
4. 403을 429로 바꾸지 않고 반환.
5. backoff 중 클라이언트 취소 시 추가 호출 없이 admission 및 계정 슬롯 반환.
6. 빈 사용량 헤더, 일시적 429 코드, 실제 소진 코드·헤더, 503 Retry-After 분류 확인.

통합 테스트는 기존 29% 사용량 유지와 Codex 로그의 Fable/quota 오표시 부재도 확인한다.

재실행:

```bash
cd /Users/soul/Documents/projects/team-ai
node --test --import tsx test/transient-recovery.test.ts
npm run typecheck && npm test && npm run lint && npm run build
git diff --check
```

## 5. 특히 검토할 지점과 미검증 범위

- **여러 계정의 혼합 실패:** transient 다음 다른 계정의 quota/403/네트워크 오류가 오면 `lastFailure`가 덮어써진다. 마지막 오류만 반환하는 정책이 적절한지, 먼저 실패한 가용 계정의 복구 기회를 누락하는지 검토. 신규 통합 테스트는 가용 계정 1개 사례 중심이다.
- **재시도 간격 경계:** jitter를 더한 값이 10초를 넘으면 그 라운드를 수행하지 않는다. 10초 Retry-After 경계 및 HTTP-date 헤더를 새 통합 테스트로 직접 확인하지 않았다.
- **동시 세션:** transient 계정을 전역 cooldown시키지 않으므로 다른 요청은 즉시 같은 계정에 접근할 수 있다. 다수 세션 동시 429의 폭주 완화에 현재 요청 단위 backoff만으로 충분한지 검토.
- **수신 중 취소:** 이번 테스트는 backoff 취소를 검증한다. 헤더 대기·오류 본문 수신 중 취소/수신 실패의 계정 슬롯 정리는 기존 코드까지 별도 검토 필요. `response.text()`가 실패하기 전에 `pool.release()`가 실행되지 않는 기존 경로에 주의.
- **분류 호환성:** 알려지지 않은 JSON 스키마, 메시지에만 들어간 소진 문구, 일반 rate-limit 헤더와 구독용 Codex 헤더의 의미 차이를 검토. 공식 API 문서의 한도 수치를 구독 백엔드에 동일 적용한 것은 아님.
- **Claude 영향:** 5xx Retry-After와 공통 dispatch 변경이 Claude에도 적용된다. 기존 전체 테스트는 통과했으나 신규 복구 통합 테스트는 Codex 중심이다.
- **멱등성:** 명시적인 실패 HTTP 응답 후에만 새 재시도 라운드를 수행한다. 상위 서버가 실패 응답 전 일부 작업을 실행하는 경우까지 중복 실행 부재를 증명하지 않았다.
- 실 OpenAI 장애 재현, 운영 적용 후 장시간 관찰, 병렬 부하 테스트, Node 20 검증은 미실시.

## 6. 다른 세션 변경과 적용 상태

작업 시작 시 README.md 및 ko/ja/zh-CN/es 5종은 이미 수정된 상태였다. **이번 작업 소유분은 각 파일 끝의 `transient-recovery-2026-09-22` 마커 블록뿐**이다. README의 나머지 diff를 이번 수정으로 간주하거나 통째로 되돌리지 말 것.

소스 2개는 작업 시작 시 깨끗했고 신규 테스트는 이번에 생성했다. 이 인계 문서도 이번 요청으로 추가했다.

- 빌드된 dist는 gitignored. 커밋 대상 아님.
- 실행 중 TeamAI 릴레이는 아직 재시작하지 않았다. 따라서 운영에서 개선 효과를 확인했다고 보고하면 안 됨.
- `src/runtime.ts`의 shutdown은 잠깐 drain한 뒤 남은 연결을 강제로 끊는다. 다른 세션의 응답 생성도 중단될 수 있으므로 적용 시점 조율 필요.
- 재시작 CLI는 TTY 제약이 있으므로 저장소 `AGENTS.md`의 운영 절차를 따를 것. 리뷰 중 임의 재시작 불필요.
- 커밋·푸시 없음.

## 7. 리뷰 시작 시 코드 동일성 확인

문서 작성 당시 SHA-256. 다르면 다른 세션의 후속 변경을 확인하고 현재 코드 기준으로 리뷰할 것.

```text
ff73e4c6ba9399abd59eb9a17a97ba4d30d33200afbca3d927bd9abca22173eb  src/proxy.ts
91c1517406a47d2ba289cd283eafce2a6561491898f2bc324488bf7d275b3c4d  src/providers.ts
46329db1170b08c8bba66f41b36729c2a242104063407aba970c2e531e92768a  test/transient-recovery.test.ts
```

## 8. 확인한 공식 자료

- https://developers.openai.com/api/docs/guides/error-codes
- https://developers.openai.com/api/docs/guides/rate-limits
- https://developers.openai.com/codex/config-reference/
- https://developers.openai.com/codex/auth/

공식 문서는 429 일시 제한과 소진, 503 일시 과부하를 구별하고 Retry-After 기반 대기를 설명한다. 이 프로젝트의 실제 경로는 `https://chatgpt.com/backend-api/codex/responses`이며 일반 유료 API와 동일한 요금·한도 체계라는 주장은 하지 않는다.
