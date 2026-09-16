# Loot Locker

## Quick setup

This is the recommended macOS setup. It uses Docker for PostgreSQL and maps host port `5433` to the container's port `5432`, avoiding conflicts with a PostgreSQL installation already running on port `5432`.

### 1. Install Node.js and Docker Desktop

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install node
brew install --cask docker
open -a Docker
```

Wait for Docker Desktop to start, then verify the Docker daemon:

```bash
until docker info >/dev/null 2>&1; do
  sleep 1
done
```

### 2. Clone the project

```bash
git clone https://github.com/lootlocker0/Loot-Locker.git
cd Loot-Locker
```

### 3. Create the environment files

Next.js loads `.env.local`. Prisma loads `.env` through `prisma.config.ts`. Both files must contain the local database URLs.

```bash
cp .env.example .env.local
cp .env.example .env

sed -i '' \
  -e 's|^DATABASE_URL=.*|DATABASE_URL="postgresql://postgres:postgres@localhost:5433/lootlockers_dev?sslmode=disable"|' \
  -e 's|^DIRECT_URL=.*|DIRECT_URL="postgresql://postgres:postgres@localhost:5433/lootlockers_dev?sslmode=disable"|' \
  .env.local

sed -i '' \
  -e 's|^DATABASE_URL=.*|DATABASE_URL="postgresql://postgres:postgres@localhost:5433/lootlockers_dev?sslmode=disable"|' \
  -e 's|^DIRECT_URL=.*|DIRECT_URL="postgresql://postgres:postgres@localhost:5433/lootlockers_dev?sslmode=disable"|' \
  .env
```

### 4. Start PostgreSQL in Docker

```bash
docker pull postgres:15
docker rm -f lootlockers-postgres 2>/dev/null || true
docker run -d --name lootlockers-postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_DB=lootlockers_dev \
  -p 5433:5432 \
  postgres:15

until docker exec lootlockers-postgres pg_isready -U postgres -d lootlockers_dev; do
  sleep 1
done
```

### 5. Check the database connection

```bash
docker ps --filter name=lootlockers-postgres

docker exec lootlockers-postgres pg_isready -U postgres -d lootlockers_dev
docker exec lootlockers-postgres psql -U postgres -d lootlockers_dev -c 'SELECT current_database(), current_user;'
```

### 6. Install and initialize the application

```bash
npm install
npx prisma migrate deploy
docker exec -i lootlockers-postgres psql -U postgres -d lootlockers_dev < prisma/migrations/manual_constraints.sql
npx prisma db seed
```

### 7. Start the application

```bash
unset DATABASE_URL DIRECT_URL
npm run dev
```

Open http://localhost:3000.

## Troubleshooting

### Docker is not running

```bash
open -a Docker
until docker info >/dev/null 2>&1; do
  sleep 1
done
```

### Docker says the container name already exists

```bash
docker rm -f lootlockers-postgres
```

Then run the PostgreSQL `docker run` command from Quick setup again.

### Check whether PostgreSQL is reachable

```bash
docker ps --filter name=lootlockers-postgres
docker exec lootlockers-postgres pg_isready -U postgres -d lootlockers_dev
```

### Check whether the application database has tables

```bash
docker exec lootlockers-postgres psql -U postgres -d lootlockers_dev -c '\dt'
```

### Reapply migrations and seed data

```bash
npx prisma migrate deploy
docker exec -i lootlockers-postgres psql -U postgres -d lootlockers_dev < prisma/migrations/manual_constraints.sql
npx prisma db seed
```

To make it live in the database, rerun the seed in the project:

```bash
set -a && source .env.local && set +a && npx prisma db seed
```

### Prisma says `DATABASE_URL` or `DIRECT_URL` is missing

```bash
pwd
grep -E '^(DATABASE_URL|DIRECT_URL)=' .env.local .env
unset DATABASE_URL DIRECT_URL
npx prisma generate
```

### Prisma cannot reach the database

```bash
docker start lootlockers-postgres
docker exec lootlockers-postgres pg_isready -U postgres -d lootlockers_dev
npx prisma migrate deploy
```

### Next.js keeps using an old database URL

Stop the development server with `Ctrl+C`, then run:

```bash
unset DATABASE_URL DIRECT_URL
rm -rf .next
npm run dev
```

### Port `5433` is already in use

```bash
lsof -nP -iTCP:5433 -sTCP:LISTEN
```

Stop the process using that port, or change `5433` consistently in both `.env.local` and `.env`, and in the Docker `-p` option.

### Port `3000` is already in use

```bash
lsof -nP -iTCP:3000 -sTCP:LISTEN
```

Stop the old Next.js process, then run `npm run dev` again.

## Database commands

Stop the database:

```bash
docker stop lootlockers-postgres
```

Start the database again:

```bash
docker start lootlockers-postgres
```

Remove the database container and its data:

```bash
docker rm -f lootlockers-postgres
```

## Setup Trial #1: Original Homebrew PostgreSQL setup

These are the commands from the first setup attempt. This trial used Homebrew PostgreSQL on the default host port `5432`.

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
echo >> /Users/$USER/.bash_profile
echo 'eval "$(/usr/local/bin/brew shellenv bash)"' >> /Users/$USER/.bash_profile
eval "$(/usr/local/bin/brew shellenv bash)"
brew install node

cd Loot-Locker
npm install
cp .env.example .env.local
brew install postgresql
brew services start postgresql@18
psql -d postgres -c "CREATE DATABASE lootlockers_dev;"
```

The original `psql -c "CREATE DATABASE lootlockers_dev;"` command failed because `psql` tried to connect to a database named after the macOS user. The corrected command specifies the existing `postgres` database with `-d postgres`.

For a Homebrew PostgreSQL database, the matching local URLs are:

```env
DATABASE_URL="postgresql://aizarameenhossain@localhost:5432/lootlockers_dev?sslmode=disable"
DIRECT_URL="postgresql://aizarameenhossain@localhost:5432/lootlockers_dev?sslmode=disable"
```

## Setup Trial #2: Corrected Docker PostgreSQL setup

This is the corrected setup used after Trial #1. Docker Desktop provides PostgreSQL, and host port `5433` maps to the container's port `5432`.

```bash
brew install --cask docker
open -a Docker
until docker info >/dev/null 2>&1; do
  sleep 1
done

cd Loot-Locker
cp .env.example .env.local
cp .env.example .env

sed -i '' \
  -e 's|^DATABASE_URL=.*|DATABASE_URL="postgresql://postgres:postgres@localhost:5433/lootlockers_dev?sslmode=disable"|' \
  -e 's|^DIRECT_URL=.*|DIRECT_URL="postgresql://postgres:postgres@localhost:5433/lootlockers_dev?sslmode=disable"|' \
  .env.local

sed -i '' \
  -e 's|^DATABASE_URL=.*|DATABASE_URL="postgresql://postgres:postgres@localhost:5433/lootlockers_dev?sslmode=disable"|' \
  -e 's|^DIRECT_URL=.*|DIRECT_URL="postgresql://postgres:postgres@localhost:5433/lootlockers_dev?sslmode=disable"|' \
  .env

docker pull postgres:15
docker rm -f lootlockers-postgres 2>/dev/null || true
docker run -d --name lootlockers-postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_DB=lootlockers_dev \
  -p 5433:5432 \
  postgres:15

until docker exec lootlockers-postgres pg_isready -U postgres -d lootlockers_dev; do
  sleep 1
done

npm install
npx prisma migrate deploy
docker exec -i lootlockers-postgres psql -U postgres -d lootlockers_dev < prisma/migrations/manual_constraints.sql
npx prisma db seed

unset DATABASE_URL DIRECT_URL
rm -rf .next
npm run dev
```
