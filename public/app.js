// 공용 헬퍼: SSE 구독 + 메시지 전송 + 👍 리액션. XSS 안전(textContent만 사용).
export const esc = encodeURIComponent;

// code의 메타+기존 메시지 로드, 이후 SSE로 신규/리액션 수신.
// onMsg(m): 메시지(초기 로드분 + 신규), onReact({id,reactions}): 리액션 갱신
export async function connect(code, { onMeta, onMsg, onReact, onVote, onDel, onPin, onStage, onPolls } = {}) {
  const r = await fetch(`/api/${esc(code)}`);
  if (!r.ok) {
    document.body.innerHTML = `<div class="center"><div class="card"><h1>Event not found</h1><p>We could not find event code <b>${code}</b>.</p><a href="/">← Back home</a></div></div>`;
    return;
  }
  const data = await r.json();
  onMeta?.(data);
  for (const m of data.messages) onMsg?.(m);

  const es = new EventSource(`/stream/${esc(code)}`);
  es.onmessage = (e) => {
    const o = JSON.parse(e.data);
    if (o.kind === "react") onReact?.(o);
    else if (o.kind === "vote") onVote?.(o);
    else if (o.kind === "del") onDel?.(o);
    else if (o.kind === "pin") onPin?.(o);
    else if (o.kind === "stage") onStage?.(o);
    else if (o.kind === "polls") onPolls?.(o.polls);
    else onMsg?.(o);
  };
  return es;
}

// 고정 먼저, 그다음 정렬(recent: 최신, top: 좋아요순)
export function sortMessages(list, sort) {
  const rank =
    sort === "top"
      ? (a, b) => b.reactions - a.reactions || b.ts - a.ts
      : (a, b) => b.ts - a.ts;
  return [...list].sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || rank(a, b));
}

// 관리자 액션 (key는 body로 전달, 서버가 검증)
export async function adminAction(code, key, pathPart, body = {}) {
  const r = await fetch(`/admin/${esc(code)}/${pathPart}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, ...body }),
  });
  return r.ok ? r.json() : null;
}

export async function send(code, text, pollId = "qa") {
  const r = await fetch(`/msg/${esc(code)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, pollId }),
  });
  return r.ok;
}

function reactionToken() {
  const key = "qr-chat:reaction-device";
  let token = localStorage.getItem(key);
  if (!token) {
    token = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(key, token);
  }
  return token;
}

export async function react(code, id) {
  const key = `qr-chat:reacted:${code}:${id}`;
  if (localStorage.getItem(key)) return;
  const r = await fetch(`/react/${esc(code)}/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: reactionToken() }),
  });
  if (r.ok) localStorage.setItem(key, "1");
}

// 메시지 li 생성 (텍스트 + 👍 버튼). textContent = XSS 안전.
export function buildLi(code, m) {
  const li = document.createElement("li");
  li.dataset.id = m.id;
  if (m.pinned) li.classList.add("pinned");
  const txt = document.createElement("span");
  txt.className = "txt";
  txt.textContent = m.text;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "react";
  const alreadyReacted = localStorage.getItem(`qr-chat:reacted:${code}:${m.id}`);
  if (alreadyReacted) { btn.classList.add("reacted"); btn.disabled = true; }
  btn.innerHTML = `👍 <b>${m.reactions || 0}</b>`;
  btn.onclick = async () => { await react(code, m.id); btn.classList.add("reacted"); btn.disabled = true; };
  li.append(txt, btn);
  return li;
}

// data-id 로 특정 메시지의 리액션 카운트만 갱신
export function setCount(root, id, n) {
  const b = root.querySelector(`li[data-id="${id}"] .react b`);
  if (b) b.textContent = n;
}

export async function vote(code, pollId, opt) {
  await fetch(`/vote/${esc(code)}/${esc(pollId)}/${opt}`, { method: "POST" });
}

// poll 카드 생성. interactive=true면 옵션 클릭으로 투표(1기기 1표는 localStorage).
export function renderPoll(code, poll, interactive) {
  const wrap = document.createElement("div");
  wrap.className = "poll";
  wrap.dataset.poll = poll.id;
  const q = document.createElement("h3");
  q.textContent = poll.q; // XSS 안전
  wrap.append(q);

  if (poll.type === "text") {
    const hint = document.createElement("p");
    hint.className = "poll-hint";
    hint.textContent = interactive ? "Use the input below to respond anonymously." : `${poll.responseCount || 0} responses`;
    wrap.append(hint);
    return wrap;
  }

  const votedKey = `voted:${code}:${poll.id}`;
  const votedOpt = localStorage.getItem(votedKey);

  poll.options.forEach((label, i) => {
    const row = document.createElement("div");
    row.className = "opt";
    row.dataset.i = i;
    const bar = document.createElement("div"); bar.className = "bar";
    const lab = document.createElement("span"); lab.className = "lab"; lab.textContent = label;
    const cnt = document.createElement("span"); cnt.className = "cnt"; cnt.textContent = "0";
    row.append(bar, lab, cnt);
    if (interactive) {
      row.classList.add("clickable");
      if (votedOpt !== null) row.classList.add("voted");
      if (String(i) === votedOpt) row.classList.add("mine");
      row.onclick = () => {
        if (localStorage.getItem(votedKey) !== null) return; // 1기기 1표
        localStorage.setItem(votedKey, i);
        wrap.querySelectorAll(".opt").forEach((o) => o.classList.add("voted"));
        row.classList.add("mine");
        vote(code, poll.id, i);
      };
    }
    wrap.append(row);
  });
  updatePoll(wrap, poll.counts || []);
  return wrap;
}

export function updatePoll(wrap, counts) {
  const total = counts.reduce((a, b) => a + b, 0);
  wrap.querySelectorAll(".opt").forEach((row) => {
    const c = counts[+row.dataset.i] || 0;
    const pct = total ? Math.round((c / total) * 100) : 0;
    row.querySelector(".bar").style.width = pct + "%";
    row.querySelector(".cnt").textContent = total ? `${c} · ${pct}%` : "0";
  });
}
