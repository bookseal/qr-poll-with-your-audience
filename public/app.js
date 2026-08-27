// 공용 헬퍼: SSE 구독 + 메시지 전송 + 👍 리액션. XSS 안전(textContent만 사용).
export const esc = encodeURIComponent;

// code의 메타+기존 메시지 로드, 이후 SSE로 신규/리액션 수신.
// onMsg(m): 메시지(초기 로드분 + 신규), onReact({id,reactions}): 리액션 갱신
export async function connect(code, { onMeta, onMsg, onReact } = {}) {
  const r = await fetch(`/api/${esc(code)}`);
  if (!r.ok) {
    document.body.innerHTML = `<div class="center"><div class="card"><h1>없는 코드</h1><p>이벤트 코드 <b>${code}</b> 를 찾을 수 없어요.</p><a href="/">← 처음으로</a></div></div>`;
    return;
  }
  const data = await r.json();
  onMeta?.(data);
  for (const m of data.messages) onMsg?.(m);

  const es = new EventSource(`/stream/${esc(code)}`);
  es.onmessage = (e) => {
    const o = JSON.parse(e.data);
    if (o.kind === "react") onReact?.(o);
    else onMsg?.(o);
  };
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

export async function react(code, id) {
  await fetch(`/react/${esc(code)}/${id}`, { method: "POST" });
}

// 메시지 li 생성 (텍스트 + 👍 버튼). textContent = XSS 안전.
export function buildLi(code, m) {
  const li = document.createElement("li");
  li.dataset.id = m.id;
  const txt = document.createElement("span");
  txt.className = "txt";
  txt.textContent = m.text;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "react";
  btn.innerHTML = `👍 <b>${m.reactions || 0}</b>`;
  btn.onclick = () => react(code, m.id);
  li.append(txt, btn);
  return li;
}

// data-id 로 특정 메시지의 리액션 카운트만 갱신
export function setCount(root, id, n) {
  const b = root.querySelector(`li[data-id="${id}"] .react b`);
  if (b) b.textContent = n;
}
