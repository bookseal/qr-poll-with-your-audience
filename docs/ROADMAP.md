# Roadmap

Slido를 따라가되 항상 "지금 강의에 필요한 최소"만 붙인다. 각 phase는 이전 것 위에 얹는다.

## Phase 0 — MVP (완료)
- QR로 입장하는 **익명 실시간 채팅 월**
- 참가자 뷰(`/r/:code`) + 발표자 대형화면(`/present/:code`, QR 포함)
- SSE 실시간, JSONL 파일 영속, 이벤트 문구는 `events/<code>.json`
- 기본 안전장치: 길이 제한(500자), IP rate limit, XSS 안전 렌더

## Phase 1 — 리액션 / 업보트 (완료)
- 메시지에 👍 리액션 (Slido 오픈텍스트 반응, Q&A 업보트에 대응)
- 발표자 화면에서 "최신순 ↔ 인기순" 정렬 토글
- 한글 IME 조합 중 Enter 오전송 버그 수정

## Phase 2 — 객관식 Poll
- `events/<code>.json`에 poll 정의(질문 + 옵션)
- 참가자는 탭해서 투표, 발표자 화면에 실시간 막대 집계
- 참고 Slido poll: `🚦 지금 내 MVP, 어디까지 왔어요?`

## Phase 3 — 진행 제어 / 모더레이션
- 발표자: poll open/close, 다음/이전, 메시지 숨김·고정
- Slido의 "설문조사 시작/중지" 흐름 재현

## Phase 4 — 다중 이벤트 / Export
- 이벤트 목록 관리 UI
- 결과 CSV/JSON export
- 저장소를 JSONL → SQLite로 승급(동시성/쿼리 필요 시)

## Phase 5 — 오픈텍스트 시각화
- 응답 word cloud, 라이트/다크 테마
