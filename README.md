# 💬 QR Chat — a minimal Slido clone

강의장에서 **QR만 찍으면 가입·설치·로그인 없이 익명으로** 실시간 참여하는 채팅 월.
[Slido](https://www.slido.com/)에서 딱 필요한 만큼만 떼어낸 최소 버전이다.

![flow](https://img.shields.io/badge/QR%20%E2%86%92%20%EC%9D%B5%EB%AA%85%20%EC%B1%84%ED%8C%85-198038)

## 지금 되는 것 (Phase 0–3)
- **랜딩** `/` — 코드로 입장하거나 **새 이벤트 생성**(제목+발표자 이메일 입력 → 코드+temporary access 발급). 발표자는 이벤트 코드와 이메일로 콘솔에 재접속할 수 있다. 남용 방지로 이벤트 총 **10개 제한** + 생성 rate-limit.
- **청중** `/r/:code` — 폰에서 익명 메시지 + 👍 리액션 + 객관식 poll 투표. **강사가 띄운 것(메시지 월 ↔ 질문)만 보임**(Slido처럼 focus를 따라감)
- **빔프로젝터** `/present/:code` — 읽기 전용 대형화면. QR + 강사가 띄운 것(메시지 월/질문)을 실시간 표시
- **관리자 콘솔** `/admin/:code?key=…` — 강사용. 질문 띄우기/다음·이전, 메시지 삭제(soft)·고정, 좋아요순 정렬, "빔프로젝터 창 열기". URL 비밀키로 보호
- SSE 실시간 · JSONL 파일 영속 · 이벤트/설문 문구는 `events/<code>.json` 하나로 관리

### 강의 흐름 (창 3개)
1. 강사: 랜딩에서 이벤트 생성 → **관리자 콘솔**(맥북)로 이동
2. 콘솔에서 "빔프로젝터 창 열기" → **`/present`**를 빔에 띄움 (QR 노출)
3. 학생: QR 스캔 → **`/r`**에서 익명 참여
4. 강사가 콘솔에서 질문을 띄우면 빔 화면이 실시간 전환

로드맵은 [`docs/ROADMAP.md`](docs/ROADMAP.md) (리액션 → 객관식 poll → 진행제어 → export → word cloud).

## 빠른 시작
```bash
npm install
node seed/seed.js          # (선택) 예시 데이터 주입
npm start                  # http://localhost:3000
```
- 발표자: http://localhost:3000/present/9587463
- 참가자: http://localhost:3000/r/9587463
- 자체 체크: `npm test` (server 로직 assert)

## 이벤트 추가
`events/<코드>.json` 파일 하나면 끝. UI 없이 문구만 JSON으로 관리한다.
```json
{ "code": "9587463", "title": "E-WAVE 아카데미 · 0827 MVP 만들기" }
```
예시 데이터는 실제 Slido 이벤트(`E-WAVE 아카데미 · 0827 MVP 만들기`, 코드 9587463)의
오픈텍스트 아이디어 응답을 담았다 — `seed/seed.js`.

## 구조
```
server.js            express: 정적 + SSE + 메시지 POST + QR
public/              index / join / present / app.js / style.css
events/<code>.json   이벤트 메타 (문구)
data/<code>.jsonl    메시지 로그 (gitignore)
seed/seed.js         예시 데이터
deploy/              systemd + nginx + 배포 가이드
```

## 스택 (일부러 최소)
- Node 18 + Express, 의존성 딱 2개: `express`, `qrcode`
- 실시간: **SSE** (WebSocket 라이브러리 불필요)
- 저장: append-only **JSONL** 파일 (동시성 필요해지면 SQLite로 승급)

## 배포 — **라이브**: https://qr-chat.physical-spark.com
`ssh prod`(Ubuntu·Node18)에 systemd로 앱을 띄우고 **Cloudflare Tunnel**로
`qr-chat.physical-spark.com` 연결 → [`deploy/DEPLOY.md`](deploy/DEPLOY.md).
(포트 80/443을 k8s가 점유해 nginx 대신 tunnel 사용 — 인바운드 포트 오픈 불필요)

### Vercel도 되나요?
가능은 하다. 다만 실시간 채팅은 지속 연결(SSE/WebSocket)이 핵심인데 Vercel은 서버리스라
지속 연결이 약해서 **Ably/Pusher/Supabase 같은 외부 실시간 서비스 + 외부 DB**가 추가로 필요하다.
서버·도메인을 이미 가진 상황에선 단일 Node 프로세스 self-host가 부품이 가장 적고 단순해서 그쪽을 택했다.

## License
MIT
