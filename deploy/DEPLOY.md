# 배포 (ssh prod + Cloudflare Tunnel)

대상: Ubuntu 20.04 (aarch64, Oracle Cloud), Node 18. 앱은 단일 Node 프로세스(포트 3000).
공개 도메인: **https://qr-chat.physical-spark.com**

> 이 서버는 포트 80/443을 k8s ingress가 점유해서 nginx 리버스 프록시 대신
> **Cloudflare Tunnel**로 붙였다. 인바운드 포트/방화벽/Oracle 보안목록을 전부 우회하고
> `localhost:3000`으로 바로 연결된다. (nginx 방식은 `nginx.conf` 참고 — 포트가 비어있는 서버용.)

## 1. 코드 배치 + 앱 서비스
```bash
ssh prod
git clone https://github.com/bookseal/qr-chat-with-your-audience.git ~/qr-chat
cd ~/qr-chat
npm ci --omit=dev
node seed/seed.js                      # (선택) 예시 데이터

sudo cp deploy/qr-chat.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now qr-chat
curl -s localhost:3000/api/9587463 | head    # 응답 확인
```

## 2. Cloudflare Tunnel
```bash
# 설치 (arm64)
curl -fsSL -o /tmp/cf.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64.deb
sudo dpkg -i /tmp/cf.deb

# 인증 → 브라우저에서 physical-spark.com zone authorize (cert.pem 생성)
cloudflared tunnel login

# 터널 생성 + DNS 자동 등록(CNAME)
cloudflared tunnel create qr-chat
cloudflared tunnel route dns qr-chat qr-chat.physical-spark.com
```

`/etc/cloudflared/config.yml` (deploy/cloudflared-config.example.yml 참고):
```yaml
tunnel: <TUNNEL_ID>
credentials-file: /etc/cloudflared/<TUNNEL_ID>.json
ingress:
  - hostname: qr-chat.physical-spark.com
    service: http://localhost:3000
  - service: http_status:404
```

서비스로 상시 실행:
```bash
sudo cloudflared service install
sudo systemctl enable --now cloudflared
```

## 3. 확인
```bash
curl -s https://qr-chat.physical-spark.com/api/9587463 | head
```
- 발표자: https://qr-chat.physical-spark.com/present/9587463
- 폰으로 QR 스캔 → `/r/9587463` → 익명 전송 → 발표자 화면 실시간 반영

## 업데이트
```bash
cd ~/qr-chat && git pull && npm ci --omit=dev && sudo systemctl restart qr-chat
```

## 참고: 왜 Vercel이 아니라 self-host인가
실시간 채팅은 지속 연결(SSE/WebSocket)이 핵심인데 Vercel은 서버리스라 지속 연결이 약하고,
실시간엔 Ably/Pusher/Supabase 같은 외부 서비스 + 외부 DB가 추가로 필요하다. 서버·도메인을
이미 가진 지금은 단일 Node 프로세스 + Cloudflare Tunnel이 부품이 가장 적고 단순하다.
