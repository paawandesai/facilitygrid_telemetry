# Hosting a public demo on Oracle Cloud Always Free

One free ARM VM runs the whole compose stack unchanged and gives you a public link like `http://<public-ip>:8080`. Nothing here is billed as long as you stay inside the Always Free limits (up to 4 Ampere OCPUs and 24 GB of RAM in total, 200 GB of block storage).

Every image the stack uses is published for arm64 (`node:22-alpine`, `nginx:1.27-alpine`, `postgres:16-alpine`, `redpandadata/redpanda`, `python:3.12-slim`), and `package-lock.json` already lists the `linux-arm64` builds of esbuild and Rollup that the web build needs, so nothing changes for ARM.

## 1. Create the account

1. Sign up at <https://signup.cloud.oracle.com>. A card is needed for identity checks; it isn't charged for Always Free resources.
2. Choose your **home region** carefully, because it can't be changed later and Always Free VMs only run there. Pick one near you (for example US East (Ashburn) or US West (Phoenix)).
3. Optional but sensible: **Billing → Budgets → Create budget** with a $1 alert, so you hear about anything that isn't free.

## 2. Create the VM

**Compute → Instances → Create instance**:

| Setting | Value |
|---|---|
| Name | `facilitygrid-demo` |
| Image | **Canonical Ubuntu 24.04** (the aarch64 build is picked automatically for an Ampere shape) |
| Shape | **Change shape → Ampere → VM.Standard.A1.Flex**, 2 OCPUs, 12 GB memory (4 / 24 is also free) |
| Networking | Create a new virtual cloud network with a **public subnet**, and keep **Assign a public IPv4 address** on |
| SSH keys | Upload your public key (`~/.ssh/id_ed25519.pub`), or let Oracle generate a pair and download the private key |
| Boot volume | Default (about 47 GB) is plenty |

Click **Create** and note the **Public IP address** once it says Running.

If you get **"Out of capacity for shape VM.Standard.A1.Flex"**, try another availability domain in the same form, try again later, or upgrade the account to Pay As You Go (Always Free resources stay free after the upgrade, and A1 capacity is much easier to get).

## 3. Open port 8080 in Oracle's firewall

**Networking → Virtual cloud networks →** your VCN **→ Security Lists → Default Security List → Add Ingress Rules**:

| Field | Value |
|---|---|
| Source CIDR | `0.0.0.0/0` (or just your own IP, `x.x.x.x/32`, to keep it private) |
| IP protocol | TCP |
| Destination port range | `8080` |

## 4. Prepare the VM

SSH in (Ubuntu images use the `ubuntu` user):

```sh
ssh -i ~/.ssh/id_ed25519 ubuntu@<public-ip>
```

Oracle's Ubuntu images ship an iptables policy that rejects everything except SSH. Allow 8080 and save it so it survives reboots:

```sh
sudo iptables -I INPUT -p tcp --dport 8080 -j ACCEPT
sudo netfilter-persistent save
```

Install Docker with the Compose plugin, and let the `ubuntu` user run it:

```sh
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu
exit          # log out and back in so the group applies
```

Redpanda needs more async-I/O slots than the kernel default on some hosts. Raising the limit is harmless:

```sh
echo 'fs.aio-max-nr = 1048576' | sudo tee /etc/sysctl.d/99-redpanda.conf
sudo sysctl --system
```

## 5. Get the code and start it

The repository is private, so clone with a GitLab personal access token that has `read_repository` (GitLab → Preferences → Access tokens):

```sh
git clone https://oauth2:<TOKEN>@labs.gauntletai.com/paawandesai/facilitygrid_telemetry.git
cd facilitygrid_telemetry
```

Start the stack. The first build takes several minutes on ARM.

```sh
# Exactly what the brief runs, starting empty:
docker compose up -d --build

# Or with the demo building, live feed and injected faults (recommended for a shared link):
docker compose -f docker-compose.yml -f docker-compose.demo.yml up -d --build
```

Check it:

```sh
docker compose ps                  # api should say (healthy)
docker compose logs -f demo        # if you started the demo overlay
curl -s localhost:8080/api/stats
```

Open **http://\<public-ip\>:8080** in a browser. With the demo overlay, the Equipment board fills within a minute, the charts move every 10 seconds, and the Proof page counters start climbing.

Every service restarts on its own after a crash or a VM reboot.

## 6. Drive it from your laptop

The provided generator works against the hosted copy as is:

```sh
python3 telemetry_generator.py --target http://<public-ip>:8080 --scenario replay
python3 telemetry_generator.py --target http://<public-ip>:8080 --scenario race
python3 telemetry_generator.py --target http://<public-ip>:8080 --scenario trace --seed paawandesai
```

## Day-to-day

| Task | Command |
|---|---|
| Update to the latest code | `git pull && docker compose -f docker-compose.yml -f docker-compose.demo.yml up -d --build` |
| Start again from empty | `docker compose -f docker-compose.yml -f docker-compose.demo.yml down -v`, then `up -d` again |
| Stop the demo feed only | `docker compose -f docker-compose.yml -f docker-compose.demo.yml stop demo` |
| Disk used by the data | `docker system df -v` (the demo writes roughly 250k readings a day; reset weekly if you leave it running) |

## Things to know

- **No authentication.** Anyone with the link can post readings and claim devices. That's fine for a demo; restrict the security-list source to your IP if you want it private.
- **Idle reclamation.** Oracle may reclaim Always Free VMs that stay almost idle for a week. The demo feed keeps the VM lightly busy, but if the link has to stay up for weeks, upgrading to Pay As You Go removes that rule and still costs nothing within the free limits.
- **HTTPS** isn't set up. If you need it, put a free Cloudflare quick tunnel in front (`cloudflared tunnel --url http://localhost:8080` on the VM) or add Caddy with a domain name.
