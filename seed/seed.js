// Slido 이벤트(E-WAVE 0827)의 실제 오픈텍스트 응답을 채팅 메시지로 주입.
// 사용: node seed/seed.js  (data/9587463.jsonl 를 새로 만든다)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CODE = "9587463";

// 💡 "ChatGPT랑 아이디어 다듬고 100자로 요약" 오픈텍스트 응답 (Slido admin에서 캡처)
const ideas = [
  "종목코드·평균매입가·수량만 입력하면 최신 시장·거시·재무 데이터를 연결해 포트폴리오의 수익·위험·금리·환율 민감도와 시나리오별 영향, 리밸런싱을 쉽게 보여주는 투자 분석 서비스",
  "출국이 임박한 일본 여행객이 저장한 사진을 올리면 장소를 식별하고, 영업시간과 이동 동선을 반영한 맞춤 일정을 만들어주는 서비스. 초기엔 한 도시·하루 코스로 유료 검증한다.",
  "Stockout Radar + Reorder Quantity Advisor 예측모델. 재고를 언제 발주하면 가장 경제적인지 도와주는 플러그인/앱 아이디어입니다.",
  "DART·ECOS 데이터를 융합해 AML 위험과 공시·거시지표를 연결하고, CAMS 자료 기반 참고정보 생성 가능성을 검증하는 분석 스킬.",
  "강의계획서를 AI가 분석해 시험·과제·팀플 등 부담 요소를 비교하고, 사용자의 조건에 맞는 과목을 추천하는 웹 서비스.",
  "사진을 분석해 색을 추출해 프레임 이미지를 만들고, 사진 내용과 색상을 바탕으로 이모지를 추천해주고 인스타그램 비율로 저장할 수 있는 서비스.",
  "\"3구 콘센트 내일 8시까지 사무실로 도착하게 해. 예산 10만 원.\" 직원마다 AI 에이전트를 두고 업무 효율을 끌어올려 비용 절감을 돕는 플랫폼.",
];

const dir = path.join(__dirname, "..", "data");
fs.mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${CODE}.jsonl`);

let ts = Date.now() - ideas.length * 60000; // 과거 시각으로 흩뿌림
const lines = ideas.map((text, i) =>
  JSON.stringify({ id: i + 1, text, ts: (ts += 60000) })
);
fs.writeFileSync(file, lines.join("\n") + "\n");
console.log(`seeded ${ideas.length} messages -> ${file}`);
