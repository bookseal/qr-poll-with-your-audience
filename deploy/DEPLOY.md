# 배포 (ssh prod + Cloudflare)

대상: Ubuntu 20.04, Node 18, nginx 이미 설치됨. 앱은 단일 Node 프로세스(포트 3000).

## 1. 코드 배치
```bash
ssh prod
git clone https://github.com/bookseal/qr-chat-with-your-audience.git ~/qr-chat
cd ~/qr-chat
npm ci --omit=dev
node seed/seed.js        # (선택) 예시 데이터 주입
```

## 2. systemd 서비스
```bash
sudo cp deploy/qr-chat.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now qr-chat
systemctl status qr-chat        # active(running) 확인
curl -s localhost:3000/api/9587463 | head    # 응답 확인
```

## 3. nginx 리버스 프록시
```bash
sudo cp deploy/nginx.conf /etc/nginx/sites-available/qr-chat
sudo ln -sf /etc/nginx/sites-available/qr-chat /etc/nginx/sites-enabled/qr-chat
sudo nginx -t && sudo systemctl reload nginx
```

## 4. Cloudflare DNS
Cloudflare 대시보드 → physical-spark.com → DNS:
- **A** 레코드: `qr-chat` → prod 공인 IP, **Proxied(주황 구름)**
- SSL/TLS 모드: **Full** (권장). 우선 빠르게면 Flexible도 동작.

## 5. 확인
- `https://qr-chat.physical-spark.com/present/9587463` → 발표자 화면 + QR
- 폰으로 QR 스캔 → `/r/9587463` → 익명 메시지 전송 → 발표자 화면에 실시간 반영

## 업데이트
```bash
cd ~/qr-chat && git pull && npm ci --omit=dev && sudo systemctl restart qr-chat
```

## 참고: 왜 Vercel이 아니라 self-host인가
실시간 채팅은 지속 연결(SSE/WebSocket)이 핵심인데 Vercel은 서버리스라 지속 연결이 약하고,
실시간엔 Ably/Pusher/Supabase 같은 외부 서비스 + 외부 DB가 추가로 필요하다. 서버·도메인을
이미 가진 지금은 단일 Node 프로세스 self-host가 부품이 가장 적고 단순하다.
