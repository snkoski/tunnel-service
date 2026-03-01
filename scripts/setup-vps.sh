#!/usr/bin/env bash
# =============================================================================
# Tunnel Service — VPS Setup Script
# =============================================================================
#
# Run this on your VPS after cloning the repo:
#
#   git clone <repo-url> && cd tunnel-service
#   bash scripts/setup-vps.sh yourdomain.com --cloudflare-token YOUR_CF_TOKEN
#
# What this script does:
#   1. Installs system packages (nginx, certbot, ufw)
#   2. Installs Node.js 20 via NodeSource
#   3. Installs PM2 for process management
#   4. Configures UFW firewall (ports 22, 80, 443)
#   5. Obtains a wildcard SSL certificate via Cloudflare DNS challenge
#   6. Deploys and activates the nginx config
#   7. Copies server.js, installs dependencies, and starts via PM2
#
# Prerequisites (must be done manually before running this script):
#   - A VPS running Ubuntu 22.04 or 24.04
#   - DNS A records pointing at your VPS IP:
#       yourdomain.com    → VPS_IP
#       *.yourdomain.com  → VPS_IP
#   - A Cloudflare account managing your domain (for wildcard cert DNS challenge)
#   - A Cloudflare API token with "Zone:DNS:Edit" permissions for your domain
#
# =============================================================================

set -euo pipefail

# --- Colours -----------------------------------------------------------------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
BOLD='\033[1m'
NC='\033[0m'

print_step() { echo -e "\n${BLUE}${BOLD}──────────────────────────────────────────${NC}"; echo -e "${BLUE}${BOLD}  $1${NC}"; echo -e "${BLUE}${BOLD}──────────────────────────────────────────${NC}"; }
print_ok()   { echo -e "  ${GREEN}✓ $1${NC}"; }
print_warn() { echo -e "  ${YELLOW}⚠ $1${NC}"; }
print_err()  { echo -e "  ${RED}✗ $1${NC}"; }

# --- Usage -------------------------------------------------------------------
usage() {
    echo ""
    echo -e "${BOLD}Usage:${NC} bash scripts/setup-vps.sh <domain> [options]"
    echo ""
    echo -e "${BOLD}Arguments:${NC}"
    echo "  <domain>                    Your domain name (e.g. example.com)"
    echo ""
    echo -e "${BOLD}Options:${NC}"
    echo "  --cloudflare-token <token>  Cloudflare API token (required for wildcard cert)"
    echo "  --secret <secret>           Tunnel auth secret (auto-generated if omitted)"
    echo "  --server-dir <path>         Where to deploy server files (default: ~/tunnel-server)"
    echo "  --email <email>             Email for Let's Encrypt notifications"
    echo "  -h, --help                  Show this help"
    echo ""
    echo -e "${BOLD}Examples:${NC}"
    echo "  bash scripts/setup-vps.sh example.com --cloudflare-token cf_abc123"
    echo "  bash scripts/setup-vps.sh example.com --cloudflare-token cf_abc123 --email you@example.com"
    echo "  bash scripts/setup-vps.sh example.com  # skip SSL, show manual instructions"
    echo ""
    exit 1
}

# --- Parse arguments ---------------------------------------------------------
if [[ $# -eq 0 ]]; then usage; fi

DOMAIN="$1"
shift

CF_TOKEN=""
TUNNEL_SECRET=""
SERVER_DIR="$HOME/tunnel-server"
EMAIL=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --cloudflare-token) CF_TOKEN="$2";   shift 2 ;;
        --secret)           TUNNEL_SECRET="$2"; shift 2 ;;
        --server-dir)       SERVER_DIR="$2"; shift 2 ;;
        --email)            EMAIL="$2";      shift 2 ;;
        -h|--help)          usage ;;
        *) print_err "Unknown option: $1"; usage ;;
    esac
done

# --- Locate repo root --------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ ! -f "$REPO_ROOT/server/server.js" ]]; then
    print_err "server/server.js not found — run this script from inside the cloned repo."
    exit 1
fi
if [[ ! -f "$REPO_ROOT/nginx/tunnel.conf" ]]; then
    print_err "nginx/tunnel.conf not found — run this script from inside the cloned repo."
    exit 1
fi

# --- Generate secret if not provided ----------------------------------------
if [[ -z "$TUNNEL_SECRET" ]]; then
    # openssl is available on all Ubuntu systems before Node is installed
    TUNNEL_SECRET=$(openssl rand -hex 32)
fi

# --- Banner ------------------------------------------------------------------
echo ""
echo -e "${BOLD}╔══════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║     Tunnel Service VPS Setup             ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "  Domain:       ${BOLD}$DOMAIN${NC}"
echo -e "  Server dir:   $SERVER_DIR"
echo -e "  SSL cert:     $([ -n "$CF_TOKEN" ] && echo "auto (Cloudflare DNS)" || echo "manual (see instructions at end)")"
echo ""

# =============================================================================
print_step "Step 1/7 — System packages"
# =============================================================================

sudo apt-get update -qq
sudo apt-get install -y -qq nginx ufw curl
print_ok "nginx, ufw, curl installed"

# =============================================================================
print_step "Step 2/7 — Node.js 20"
# =============================================================================

NODE_VERSION=$(node --version 2>/dev/null || echo "none")
if [[ "$NODE_VERSION" == v20* ]]; then
    print_ok "Node.js $NODE_VERSION already installed"
else
    echo "  Installing Node.js 20 via NodeSource..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - > /dev/null 2>&1
    sudo apt-get install -y -qq nodejs
    print_ok "Node.js $(node --version) installed"
fi

# =============================================================================
print_step "Step 3/7 — PM2"
# =============================================================================

if command -v pm2 &>/dev/null; then
    print_ok "PM2 $(pm2 --version) already installed"
else
    sudo npm install -g pm2 --quiet --no-progress
    print_ok "PM2 $(pm2 --version) installed"
fi

# =============================================================================
print_step "Step 4/7 — Firewall (UFW)"
# =============================================================================

sudo ufw allow 22/tcp  > /dev/null 2>&1
sudo ufw allow 80/tcp  > /dev/null 2>&1
sudo ufw allow 443/tcp > /dev/null 2>&1

# Enable without prompting; exit 0 even if already enabled
echo "y" | sudo ufw enable > /dev/null 2>&1 || true

print_ok "UFW enabled: ports 22, 80, 443 open"

# =============================================================================
print_step "Step 5/7 — SSL certificate (Let's Encrypt wildcard)"
# =============================================================================

CERT_PATH="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"

if [[ -f "$CERT_PATH" ]]; then
    print_ok "Certificate already exists at $CERT_PATH"
    SSL_READY=true
elif [[ -n "$CF_TOKEN" ]]; then
    echo "  Installing certbot Cloudflare DNS plugin..."
    sudo apt-get install -y -qq certbot python3-certbot-dns-cloudflare

    # Store Cloudflare credentials
    mkdir -p "$HOME/.secrets"
    cat > "$HOME/.secrets/cloudflare.ini" <<EOF
dns_cloudflare_api_token = $CF_TOKEN
EOF
    chmod 600 "$HOME/.secrets/cloudflare.ini"
    print_ok "Cloudflare credentials saved to ~/.secrets/cloudflare.ini"

    echo "  Requesting wildcard certificate (DNS propagation may take ~30s)..."

    CERTBOT_ARGS=(
        certonly
        --dns-cloudflare
        --dns-cloudflare-credentials "$HOME/.secrets/cloudflare.ini"
        --agree-tos
        --non-interactive
        -d "$DOMAIN"
        -d "*.$DOMAIN"
    )
    [[ -n "$EMAIL" ]] && CERTBOT_ARGS+=(--email "$EMAIL") || CERTBOT_ARGS+=(--register-unsafely-without-email)

    sudo certbot "${CERTBOT_ARGS[@]}"

    print_ok "Wildcard certificate obtained"
    echo "  Verifying auto-renewal..."
    sudo certbot renew --dry-run --quiet && print_ok "Auto-renewal works" || print_warn "Auto-renewal dry-run failed — check certbot timer"
    SSL_READY=true
else
    print_warn "No --cloudflare-token provided. Skipping SSL setup."
    SSL_READY=false
fi

# =============================================================================
print_step "Step 6/7 — nginx configuration"
# =============================================================================

NGINX_AVAILABLE="/etc/nginx/sites-available/tunnel"
NGINX_ENABLED="/etc/nginx/sites-enabled/tunnel"

# Copy config and substitute domain placeholder
sudo cp "$REPO_ROOT/nginx/tunnel.conf" "$NGINX_AVAILABLE"
sudo sed -i "s/yourdomain\.com/$DOMAIN/g" "$NGINX_AVAILABLE"
print_ok "nginx config deployed to $NGINX_AVAILABLE"

# Disable the default Ubuntu site (conflicts on port 80)
if [[ -f /etc/nginx/sites-enabled/default ]]; then
    sudo rm /etc/nginx/sites-enabled/default
    print_ok "Removed default nginx site"
fi

# Enable the tunnel site
if [[ ! -L "$NGINX_ENABLED" ]]; then
    sudo ln -s "$NGINX_AVAILABLE" "$NGINX_ENABLED"
    print_ok "Tunnel site enabled"
fi

if [[ "$SSL_READY" == true ]]; then
    sudo nginx -t
    sudo systemctl reload nginx
    print_ok "nginx config tested and reloaded"
else
    print_warn "SSL cert not present — nginx NOT reloaded yet."
    print_warn "After obtaining your cert, run:  sudo nginx -t && sudo systemctl reload nginx"
fi

# =============================================================================
print_step "Step 7/7 — Deploy tunnel server"
# =============================================================================

mkdir -p "$SERVER_DIR"
cp "$REPO_ROOT/server/server.js"   "$SERVER_DIR/server.js"
cp "$REPO_ROOT/server/package.json" "$SERVER_DIR/package.json"
print_ok "server.js copied to $SERVER_DIR"

cd "$SERVER_DIR"
npm install --quiet --no-progress
print_ok "npm dependencies installed"

# Stop and remove any existing tunnel process before starting fresh
pm2 stop tunnel   2>/dev/null || true
pm2 delete tunnel 2>/dev/null || true

# Start with the generated/provided secret
TUNNEL_SECRET="$TUNNEL_SECRET" pm2 start server.js --name tunnel
pm2 save

print_ok "Tunnel server started via PM2"

# Configure PM2 to start on boot (pm2 startup prints a command we need to run as sudo)
echo ""
echo "  Configuring PM2 autostart on reboot..."
PM2_STARTUP_CMD=$(pm2 startup 2>&1 | grep "^sudo" || true)
if [[ -n "$PM2_STARTUP_CMD" ]]; then
    eval "$PM2_STARTUP_CMD"
    pm2 save
    print_ok "PM2 autostart configured (survives reboots)"
else
    print_warn "Could not auto-configure PM2 startup. Run manually:  pm2 startup && pm2 save"
fi

# =============================================================================
# Summary
# =============================================================================

echo ""
echo -e "${BOLD}${GREEN}╔══════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${GREEN}║            Setup complete!               ║${NC}"
echo -e "${BOLD}${GREEN}╚══════════════════════════════════════════╝${NC}"
echo ""
echo -e "${BOLD}Your tunnel secret (save this somewhere safe):${NC}"
echo -e "  ${YELLOW}${BOLD}$TUNNEL_SECRET${NC}"
echo ""
echo -e "${BOLD}Add these to your local shell profile (~/.zshrc or ~/.bashrc):${NC}"
echo -e "  ${YELLOW}export TUNNEL_HOST=$DOMAIN${NC}"
echo -e "  ${YELLOW}export TUNNEL_SECRET=$TUNNEL_SECRET${NC}"
echo ""
echo -e "${BOLD}Use the tunnel client:${NC}"
echo "  cd client/ && npm install"
echo "  node client.js 3000                    # random subdomain"
echo "  node client.js 3000 --subdomain my-app # persistent subdomain"
echo ""

if [[ "$SSL_READY" == false ]]; then
    echo -e "${YELLOW}${BOLD}Still required (SSL certificate):${NC}"
    echo "  sudo apt install certbot python3-certbot-dns-cloudflare"
    echo "  mkdir -p ~/.secrets"
    echo "  echo 'dns_cloudflare_api_token = YOUR_CF_TOKEN' > ~/.secrets/cloudflare.ini"
    echo "  chmod 600 ~/.secrets/cloudflare.ini"
    echo "  sudo certbot certonly --dns-cloudflare \\"
    echo "    --dns-cloudflare-credentials ~/.secrets/cloudflare.ini \\"
    echo "    --agree-tos --non-interactive \\"
    echo "    -d $DOMAIN -d '*.$DOMAIN'"
    echo "  sudo nginx -t && sudo systemctl reload nginx"
    echo "  sudo certbot renew --dry-run"
    echo ""
fi

echo -e "${BOLD}Check server status:${NC}"
echo "  pm2 status"
echo "  pm2 logs tunnel --lines 50"
echo ""
echo -e "${BOLD}Test the tunnel:${NC}"
echo "  curl -I https://test.$DOMAIN  # should return nginx response"
echo ""
