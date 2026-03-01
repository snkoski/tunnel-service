# Tunnel Service

A self-hosted ngrok-style reverse tunnel. Exposes local servers to the internet via a secure WebSocket tunnel through your own VPS.

```
tunnel 3000
# → https://a1b2c3d4.yourdomain.com

tunnel 3000 --subdomain my-app
# → https://my-app.yourdomain.com
```

## Architecture

```
Browser → nginx (TLS) → Node public server (:4000) → WebSocket → tunnel client → localhost:PORT
                         Node control server (:4001) ←──────────── tunnel client (wss://)
```

- **Server** (`server/`) — Node.js process on your VPS. Manages authenticated WebSocket tunnels and proxies public HTTP traffic through them.
- **Client** (`client/`) — CLI tool on your dev machine. Connects outbound to the server, receives forwarded requests, proxies them to localhost, and returns responses.
- **nginx** (`nginx/`) — Reference config for TLS termination and routing.

## Prerequisites

- A VPS running Ubuntu 22.04/24.04 (DigitalOcean, Hetzner, Linode, etc.)
- A domain name with DNS pointed at your VPS:
  - `A yourdomain.com → VPS_IP`
  - `A *.yourdomain.com → VPS_IP`
- A wildcard SSL certificate (Let's Encrypt via certbot)

## VPS Setup

### 1. Install dependencies

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y nginx certbot python3-certbot-dns-cloudflare

# Node.js 20 via NodeSource (Ubuntu's default is too old)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# PM2 for process management
sudo npm install -g pm2
```

### 2. Obtain wildcard SSL certificate

```bash
# Create Cloudflare credentials file
mkdir -p ~/.secrets
cat > ~/.secrets/cloudflare.ini << 'EOF'
dns_cloudflare_api_token = YOUR_CLOUDFLARE_API_TOKEN
EOF
chmod 600 ~/.secrets/cloudflare.ini

# Get the certificate
sudo certbot certonly --dns-cloudflare \
  --dns-cloudflare-credentials ~/.secrets/cloudflare.ini \
  -d yourdomain.com -d '*.yourdomain.com'

# Verify auto-renewal works
sudo certbot renew --dry-run
```

### 3. Configure nginx

```bash
sudo cp nginx/tunnel.conf /etc/nginx/sites-available/tunnel
# Edit the file: replace "yourdomain.com" with your actual domain
sudo nano /etc/nginx/sites-available/tunnel

sudo rm /etc/nginx/sites-enabled/default
sudo ln -s /etc/nginx/sites-available/tunnel /etc/nginx/sites-enabled/tunnel
sudo nginx -t
sudo systemctl reload nginx
```

### 4. Configure firewall

```bash
sudo ufw allow 22
sudo ufw allow 80
sudo ufw allow 443
sudo ufw enable
```

### 5. Deploy the server

```bash
# Copy the server/ directory to your VPS, then:
cd ~/tunnel-server
npm install

# Generate a secret token
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# Start with PM2
TUNNEL_SECRET=your-generated-secret pm2 start server.js --name tunnel
pm2 save
pm2 startup  # follow the printed instruction
```

## Client Setup

### Install

```bash
cd client/
npm install
```

### Configure

Set these environment variables (add to your shell profile):

```bash
export TUNNEL_HOST=yourdomain.com
export TUNNEL_SECRET=your-generated-secret
```

### Usage

```bash
# Tunnel localhost:3000
node client.js 3000

# Tunnel with a persistent subdomain
node client.js 3000 --subdomain my-app

# Keep original Host header (disable rewriting)
node client.js 3000 --no-rewrite-host

# Or if installed globally via npm link:
tunnel 3000
tunnel 8080 --subdomain api-dev
```

### Options

| Flag | Description |
|------|-------------|
| `--subdomain <name>` | Request a specific subdomain instead of a random one |
| `--no-rewrite-host` | Don't rewrite the Host header to `localhost:PORT` |
| `--help`, `-h` | Show help |

## Features

- Token-based authentication (timing-safe comparison, sent as first WebSocket message)
- Wildcard subdomain routing with persistent subdomain support
- Binary-safe request/response proxying (Base64 over JSON)
- 10MB request body limit
- Heartbeat-based dead connection detection (30s interval)
- Auto-reconnect with exponential backoff (1s → 30s)
- Graceful shutdown with in-flight request draining
- Health check endpoint at `/_tunnel_health`
- Host header rewriting for dev server compatibility

## Limits

| Limit | Value |
|-------|-------|
| Max request body | 10MB (nginx allows 11MB to avoid off-by-one) |
| Request timeout | 30 seconds |
| Auth timeout | 5 seconds |
| Max WebSocket payload | 16MB (accommodates Base64 inflation) |
| Heartbeat interval | 30 seconds |
