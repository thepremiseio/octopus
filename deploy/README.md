# Deployment

## Remote access via Tailscale + Caddy

To access the Boardroom from other devices (e.g. a laptop on the road):

1. Install [Tailscale](https://tailscale.com) on both machines and sign in
   with the same account.

2. Install [Caddy](https://caddyserver.com/docs/install) on your workstation.

3. Copy `Caddyfile.example` to `Caddyfile` in this directory:
   ```
   cp deploy/Caddyfile.example deploy/Caddyfile
   ```

4. Generate a password hash and add your credentials:
   ```
   caddy hash-password
   ```
   Paste the output into `deploy/Caddyfile` replacing the example line.

5. Start Caddy from the deploy directory:
   ```
   cd deploy && caddy run
   ```

6. Make sure the Octopus server binds to localhost only (not 0.0.0.0).

7. On your remote device, open your Tailscale IP on port 7777:
   ```
   http://100.x.x.x:7777
   ```

The Boardroom will connect its API and WebSocket calls back through Caddy
automatically — no additional configuration needed.
