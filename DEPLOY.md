# Deploy Kanabana

Kanabana runs as one container. The browser and the API share port 4050. Accounts, projects, and tasks live in MongoDB Atlas. Resumes, KT documents, and screenshots are stored in the private S3 bucket `kanabana` in `ap-south-1`. They are not kept in the container.

## 1. Create the Atlas cluster

1. Open [cloud.mongodb.com](https://cloud.mongodb.com) and sign in.
2. Create an organization and a project if you do not already have one. Name the project `Kanabana`.
3. Click **Build a cluster** (or **Create**).
4. Choose the shared **M0** tier to start. It is enough for this office. Pick a region close to the VM. From India, use **Mumbai (`ap-south-1`)**.
5. Name the cluster `kanabana` and create it. Wait until the status is available.

## 2. Database user and network access

Atlas will offer a security quickstart. If it does not:

1. **Database Access → Add New Database User**. Username `kanabana`. A password with letters and numbers is easiest. Save the password somewhere safe. Give the user **Read and write to any database**.
2. **Network Access → Add IP Address**.
   - Add the **VM’s public IP** so the container can connect.
   - Add the IP of the computer where you will open Compass and run the one-time copy.
   - Do not leave `0.0.0.0/0` (anywhere) in place. That opens the database to the whole internet. Use it only for a short test, then delete it.

## 3. Connection string

1. On the cluster, click **Connect**.
2. Choose **Drivers**, then **Node.js**.
3. Copy the SRV string. It looks like `mongodb+srv://kanabana:<password>@kanabana.xxxxx.mongodb.net/?retryWrites=true&w=majority`.
4. Replace `<password>` with the database user’s password. If the password contains `@`, `#`, `/`, or `:`, encode it first (`@` becomes `%40`).

## 4. Compass

1. Install [MongoDB Compass](https://www.mongodb.com/try/download/compass).
2. In Atlas, **Connect → Compass** and copy that string (it is the same host as the driver string).
3. In Compass, choose **New connection**, paste the string, and connect.
4. You will not see a `kanabana` database until the app starts or the copy below finishes. Compass does not need you to create the collections by hand. The server creates them and their indexes on startup.

After the copy, open database `kanabana`. The collections match the old tables (`users`, `departments`, `tasks`, and the rest). Passwords are stored as hashes. Do not edit those in Compass.

## 5. Point the project at Atlas

On the machine that has this repo:

```bash
cp .env.example .env
```

Edit `.env`:

```bash
MONGODB_URI=mongodb+srv://kanabana:YOUR_PASSWORD@kanabana.xxxxx.mongodb.net/?retryWrites=true&w=majority
MONGODB_DB=kanabana
JWT_SECRET=paste-a-long-random-string
AWS_ACCESS_KEY_ID=the-same-key-used-on-the-office-computer
AWS_SECRET_ACCESS_KEY=the-same-secret-used-on-the-office-computer
S3_BUCKET=kanabana
S3_REGION=ap-south-1
```

Copy those four storage lines from the office computer’s `.env`. A hosted machine without them can sign people in, but resume and KT uploads fail. Do not commit the values.

Generate a secret with `openssl rand -base64 32`. `.env` is not committed.

The server reads `MONGODB_URI` at startup, retries for a few minutes if Atlas is briefly unreachable, and only then accepts requests. Uploads are not stored in MongoDB.

## 6. Copy the existing office

The current data is in `server/data/kanabana.db` (people, departments, attendance, activity). Stop `npm run dev` first so the file is settled, then from the repo root:

```bash
npm install --prefix server
npm run migrate
```

The command prints a count per collection. Running it again is refused once people are already in Atlas. Use `npm run migrate -- --force` only when you mean to overwrite those records with the SQLite file.

Sign-in passwords are copied as they are. The same emails and passwords keep working.

The SQLite file is left where it is, as a backup. The running app no longer reads it.

## 7. Run it on the VM

Install Docker and the Docker Compose plugin on the VM. Copy the repo and the `.env` file onto the VM (do not commit `.env`). The hosted `.env` needs the same `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_BUCKET`, and `S3_REGION` as the office computer. After `docker compose up -d --build`, the log should say `File storage is ready (kanabana in ap-south-1)`.

```bash
docker compose up -d --build
```

Open `http://THE_VM_IP:4050`. The page and `/api` come from the same process, so the office UI does not need a separate API address.

The sign-in screen currently fills in an email and password in the page source. Clear those defaults in `client/src/pages/Login.jsx` before the VM is reachable from outside the office, then rebuild. Anyone who can load the page can read a prefilled password.

Useful checks:

```bash
docker compose ps
docker compose logs -f app
curl http://127.0.0.1:4050/api/health
```

`{"ok":true}` means the process can reach Atlas.

To ship a new version later: `docker compose up -d --build`.

### Optional local MongoDB

Atlas is the database to use on the VM. A local server is only for trying the containers without Atlas:

```bash
docker compose --profile local up -d mongo mongo-init
```

Then set `MONGODB_URI=mongodb://mongo:27017/kanabana?replicaSet=rs0` for the app container. Compass on your computer can use `mongodb://127.0.0.1:27017/?directConnection=true`.

## 8. What to watch

In Atlas, open the cluster **Metrics**.

- **Connections** should stay low. This process keeps at most 10 working connections, and it drops idle ones after a minute. A single VM does not need a larger pool.
- If requests start failing with wait-queue timeouts and CPU is not busy, raise `maxPoolSize` in `server/store.js`.
- If CPU or memory is pegged, fix the slow query before adding connections. M0 will also show a storage warning if the database outgrows the free tier.

The pool is sized for one office server and short requests, not a public high-traffic site.
