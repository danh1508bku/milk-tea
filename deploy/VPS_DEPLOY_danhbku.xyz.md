# Deploy VPS for milktea.danhbku.xyz

This guide assumes Ubuntu + Docker + GoDaddy DNS.

## 1. DNS on GoDaddy

Create A records:
- Name: milktea -> Value: <your_vps_ip>

Wait for DNS propagation.

## 2. Server prerequisites

```bash
sudo apt update
sudo apt -y install nginx certbot python3-certbot-nginx
```

Install Docker Engine + Compose plugin if not installed yet.

## 3. Project setup

```bash
cd /opt
sudo git clone <your_repo_url> milk-tea-bot
sudo chown -R $USER:$USER /opt/milk-tea-bot
cd /opt/milk-tea-bot
```

Create .env based on .env.example and fill values.

Required production values:
- BOT_MODE=webhook
- TELEGRAM_WEBHOOK_URL=https://milktea.danhbku.xyz
- REDIS_URL=redis://redis:6379
- PAYOS_RETURN_URL=https://milktea.danhbku.xyz/payment/success
- PAYOS_CANCEL_URL=https://milktea.danhbku.xyz/payment/cancel
- ADMIN_CHAT_ID=<telegram_chat_id_number>

## 4. Start app stack

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f app
```

Expected logs include:
- Bot mode: webhook
- Order storage mode: in-memory
- Buyer session Redis enabled: true

## 5. Nginx setup

```bash
sudo cp deploy/nginx/danhbku.xyz.conf /etc/nginx/sites-available/milk-tea-bot
sudo ln -s /etc/nginx/sites-available/milk-tea-bot /etc/nginx/sites-enabled/milk-tea-bot
sudo nginx -t
sudo systemctl reload nginx
```

## 6. Enable HTTPS

```bash
sudo certbot --nginx -d milktea.danhbku.xyz
```

## 7. Verify Telegram webhook

```bash
curl "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/getWebhookInfo"
```

`url` should point to:
- https://milktea.danhbku.xyz/telegram/webhook/<token>

## 8. Operations

Restart app:
```bash
docker compose restart app
```

Update after git pull:
```bash
git pull
docker compose up -d --build
```

View logs:
```bash
docker compose logs -f app
```
