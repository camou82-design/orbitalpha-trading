#!/usr/bin/env bash
# Run on Ubuntu Lightsail as a user with sudo (e.g. ubuntu).
# Prerequisites: DNS trade.orbitalpha.kr → this host; ports 80/443 open; PM2 app listening on 127.0.0.1:3010
#
# After HTTPS works, set API CORS origin (no code change — env only), e.g. in PM2 ecosystem or shell:
#   ORBITALPHA_TRADING_DASHBOARD_ORIGIN=https://trade.orbitalpha.kr
#
# Usage:
#   export CERTBOT_EMAIL='you@example.com'
#   sudo -E bash setup-trade-ssl.sh
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EMAIL="${CERTBOT_EMAIL:-}"
if [[ -z "${EMAIL}" ]]; then
  echo "Set CERTBOT_EMAIL (Let's Encrypt account / expiry notices)." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -y
sudo apt-get install -y nginx certbot python3-certbot-nginx

sudo install -m 644 "${SCRIPT_DIR}/conf.d-websocket-map.conf" /etc/nginx/conf.d/websocket-map.conf
sudo install -m 644 "${SCRIPT_DIR}/trade.orbitalpha.kr.conf" /etc/nginx/sites-available/trade.orbitalpha.kr
sudo ln -sf /etc/nginx/sites-available/trade.orbitalpha.kr /etc/nginx/sites-enabled/trade.orbitalpha.kr

if [[ -f /etc/nginx/sites-enabled/default ]]; then
  sudo rm -f /etc/nginx/sites-enabled/default
fi

sudo nginx -t
sudo systemctl reload nginx

# Issue cert and let certbot patch this vhost for TLS + HTTP→HTTPS redirect
sudo certbot --nginx \
  -d trade.orbitalpha.kr \
  --non-interactive \
  --agree-tos \
  -m "${EMAIL}" \
  --redirect

sudo nginx -t
sudo systemctl reload nginx

echo "Done. Verify: curl -sI https://trade.orbitalpha.kr/login"
