// 공용 헬퍼: SSE 구독 + 메시지 전송. XSS 안전(textContent만 사용).
export function esc(code) {
  return encodeURIComponent(code);
}

export function addToFeed(feed, msg, prepend = false) {
  const li = document.createElement("li");
  li.textContent = msg.text; // textContent = XSS 안전
  li.dataset.id = msg.id;
  if (prepend) feed.prepend(li);
  else feed.append(li);
}

// code의 메타+기존 메시지 로드, 이후 SSE로 신규 수신
export async function connect(code, { feed, onMeta, onMessage, prepend = false }) {
  const r = await fetch(`/api/${esc(code)}`);
  if (!r.ok) {
    document.body.innerHTML = `<div class="center"><div class="card"><h1>없는 코드</h1><p>이벤트 코드 <b>${code}</b> 를 찾을 수 없어요.</p><a href="/">← 처음으로</a></div></div>`;
    return;
  }
  const data = await r.json();
  onMeta?.(data);
  for (const m of data.messages) (onMessage || ((x) => addToFeed(feed, x, prepend)))(m);

  const es = new EventSource(`/stream/${esc(code)}`);
  es.onmessage = (e) => (onMessage || ((x) => addToFeed(feed, x, prepend)))(JSON.parse(e.data));
  return es;
}

export async function send(code, text) {
  const r = await fetch(`/msg/${esc(code)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  return r.ok;
}
