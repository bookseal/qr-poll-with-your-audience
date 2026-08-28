# 💬 QR Chat — a minimal Slido clone

강의장에서 **QR만 찍으면 가입·설치·로그인 없이 익명으로** 실시간 참여하는 채팅 월.
[Slido](https://www.slido.com/)에서 딱 필요한 만큼만 떼어낸 최소 버전이다.

![flow](https://img.shields.io/badge/QR%20%E2%86%92%20%EC%9D%B5%EB%AA%85%20%EC%B1%84%ED%8C%85-198038)

## 지금 되는 것 (Phase 0 MVP)
- **참가자** `/r/:code` — 폰에서 익명으로 메시지 전송, 실시간 피드
- **발표자** `/present/:code` — 대형화면에 QR + 실시간 메시지
- SSE 실시간 · JSONL 파일 영속 · 이벤트 문구는 JSON 파일

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

## 배포
`ssh prod`(Ubuntu·Node18·nginx)에 systemd로 띄우고 Cloudflare로
`qr-chat.physical-spark.com` 연결 → [`deploy/DEPLOY.md`](deploy/DEPLOY.md).

### Vercel도 되나요?
가능은 하다. 다만 실시간 채팅은 지속 연결(SSE/WebSocket)이 핵심인데 Vercel은 서버리스라
지속 연결이 약해서 **Ably/Pusher/Supabase 같은 외부 실시간 서비스 + 외부 DB**가 추가로 필요하다.
서버·도메인을 이미 가진 상황에선 단일 Node 프로세스 self-host가 부품이 가장 적고 단순해서 그쪽을 택했다.

## License
MIT
