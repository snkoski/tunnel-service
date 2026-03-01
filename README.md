# Tunnel Service

An ngrok-style reverse tunnel system you own and control. Expose local web servers to the internet via a secure, persistent tunnel.

## Quick Start

```bash
# On your local machine (after VPS is set up)
export TUNNEL_HOST=yourdomain.com
export TUNNEL_SECRET=your-long-random-secret
node tunnel-client/client.js 3000

# Or with a persistent subdomain (for webhooks):
node tunnel-client/client.js 3000 --subdomain my-app
```

## Project Structure

```
├── tunnel-server/     # VPS server (Node.js)
│   ├── server.js
│   └── package.json
├── tunnel-client/     # Local CLI client
│   ├── client.js
│   └── package.json
├── nginx/
│   └── tunnel.conf   # nginx config template
└── README.md
```

## Setup Checklist

### Things You Must Do (Cursor Cannot Do These)

1. **Provision a VPS** — DigitalOcean, Hetzner, Linode, or AWS Lightsail. Ubuntu 22.04 or 24.04 LTS.

2. **Purchase a domain** — Point it at your VPS IP.

3. **Configure DNS** — Add these records at your registrar:
   ```
   A      yourdomain.com       →  YOUR_VPS_IP
   A      *.yourdomain.com     →  YOUR_VPS_IP   (wildcard)
   ```
   Start DNS early — propagation can take 30 min to a few hours.

4. **Obtain SSL certificate** — On the VPS, use certbot with DNS validation for a wildcard cert:
   ```bash
   sudo apt install certbot python3-certbot-dns-cloudflare
   certbot certonly --dns-cloudflare \
     --dns-cloudflare-credentials ~/.secrets/cloudflare.ini \
     -d yourdomain.com -d *.yourdomain.com
   ```
   Verify auto-renewal: `sudo certbot renew --dry-run`

5. **Install Node.js 20** — Ubuntu's apt ships Node 12; use NodeSource:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
   sudo apt install -y nodejs
   ```

6. **Configure nginx** — Copy `nginx/tunnel.conf` to `/etc/nginx/sites-available/tunnel`, replace `yourdomain.com` with your domain, then:
   ```bash
   sudo rm /etc/nginx/sites-enabled/default
   sudo ln -s /etc/nginx/sites-available/tunnel /etc/nginx/sites-enabled/tunnel
   sudo nginx -t
   sudo systemctl reload nginx
   ```

7. **Configure firewall**:
   ```bash
   sudo ufw allow 22
   sudo ufw allow 80
   sudo ufw allow 443
   sudo ufw enable
   ```

8. **Generate a secret** and set environment variables:
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

9. **Deploy the server** on the VPS:
   ```bash
   cd tunnel-server
   npm install
   TUNNEL_SECRET=your-secret pm2 start server.js --name tunnel
   pm2 save
   pm2 startup   # follow printed instructions
   ```

10. **Set local env vars** and run the client:
    ```bash
    export TUNNEL_HOST=yourdomain.com
    export TUNNEL_SECRET=your-secret
    node tunnel-client/client.js 3000
    ```

## Health Check

The server exposes `/_tunnel_health` on any subdomain. Use it to verify Node is running:

```bash
curl https://anything.yourdomain.com/_tunnel_health
# Returns: ok
```

## Usage

| Command | Description |
|---------|-------------|
| `node client.js 3000` | Random subdomain (e.g. `abc123.yourdomain.com`) |
| `node client.js 3000 --subdomain my-app` | Persistent subdomain `my-app.yourdomain.com` |
| `node client.js 3000 --no-rewrite-host` | Don't rewrite Host header (for servers that need original host) |

## Security

- Token is sent as the **first WebSocket message**, never in the URL (avoids logs, shell history)
- Timing-safe token comparison prevents timing attacks
- Subdomain validation: `[a-z0-9][a-z0-9-]{0,62}`
- 10MB request body limit
- Rate limiting: 30 req/min (control), 120 req/min (public)
