# Milk Tea Bot

Telegram bot for milk tea pre-ordering with cart, checkout, AI parsing, and PayOS payment integration.

## Storage model

- Orders are kept in memory (no database).
- Buyer session state is stored in Redis.
- Seller/admin operations are done in Telegram using `ADMIN_CHAT_ID`.

## Run local (polling)

1. Install dependencies:

```bash
npm install
```

2. Create `.env` from `.env.example` and set at least:
- `TELEGRAM_BOT_TOKEN`
- `ADMIN_CHAT_ID`
- `REDIS_URL`

3. Start bot:

```bash
npm run start
```

4. Seller/admin flow in Telegram:

- `/orders` to list orders
- `/order <orderCode>` to view order detail
- `/delivered <orderCode>` to confirm delivered

## AI integration

Enable AI parser by setting:
- `ENABLE_AI=true`
- `OPENAI_API_KEY=...`
- optional `OPENAI_MODEL=gpt-4.1-mini`

Usage:
- `/ai cho minh 2 tra sua truyen thong size L`
- Or plain text when bot is idle, for example: `cho minh 1 tra sua`

## PayOS integration

Set these env vars:
- `PAYOS_CLIENT_ID`
- `PAYOS_API_KEY`
- `PAYOS_CHECKSUM_KEY`
- `PAYOS_RETURN_URL`
- `PAYOS_CANCEL_URL`

Flow:
1. Customer confirms order using `/confirm`
2. Customer chooses QR with `/qr ORD0001`
3. Bot returns payment link (PayOS if configured, mock if not)
4. Pay webhook endpoint: `POST /webhooks/payos`

## Deploy on server (Webhook mode)

### Option A: Docker

```bash
docker build -t milk-tea-bot .
docker run -d \
  --name milk-tea-bot \
  -p 3000:3000 \
  -e BOT_MODE=webhook \
  -e TELEGRAM_WEBHOOK_URL=https://your-domain.com \
  -e TELEGRAM_BOT_TOKEN=... \
  -e ADMIN_CHAT_ID=... \
  -e PAYOS_CLIENT_ID=... \
  -e PAYOS_API_KEY=... \
  -e PAYOS_CHECKSUM_KEY=... \
  -e PAYOS_RETURN_URL=https://your-domain.com/payment/success \
  -e PAYOS_CANCEL_URL=https://your-domain.com/payment/cancel \
  -e ENABLE_AI=true \
  -e OPENAI_API_KEY=... \
  milk-tea-bot
```

### Option B: VM / bare server

```bash
npm ci --omit=dev
BOT_MODE=webhook TELEGRAM_WEBHOOK_URL=https://your-domain.com node src/app.js
```

## Important production notes

- Webhook mode requires HTTPS public domain.
- Telegram webhook path is auto-registered as `/telegram/webhook/<bot_token>`.
- Add reverse proxy (Nginx/Caddy) in front of app for SSL termination.
- Keep `.env` and API keys secret.
- Configure Redis with persistence if you want session data durability.

## VPS deploy for milktea.danhbku.xyz

This repository now includes deploy artifacts:
- Docker Compose stack: `docker-compose.yml`
- Nginx site config: `deploy/nginx/danhbku.xyz.conf`
- Step-by-step deploy guide: `deploy/VPS_DEPLOY_danhbku.xyz.md`

Minimal `.env` production values:
- `BOT_MODE=webhook`
- `TELEGRAM_WEBHOOK_URL=https://milktea.danhbku.xyz`
- `REDIS_URL=redis://redis:6379`
- `PAYOS_RETURN_URL=https://milktea.danhbku.xyz/payment/success`
- `PAYOS_CANCEL_URL=https://milktea.danhbku.xyz/payment/cancel`
