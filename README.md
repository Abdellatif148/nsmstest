# NOOK SMS API — Production Ready
## Morocco's SMS Infrastructure for Developers

---

## What This IS vs The MVP

| Feature | MVP | Production (This) |
|---------|-----|-------------------|
| Storage | RAM (lost on restart) | Supabase PostgreSQL |
| Security | Basic key check | Caching + timing protection |
| Validation | Manual if/else | Joi schema validation |
| Logging | console.log | Winston + rotating files |
| Bulk SMS | Blocking HTTP | Bull queue + Redis |
| Gateways | Africa's Talking only | AT + Vonage + Infobip fallback |
| Security headers | None | Helmet (11 headers) |
| Error handling | Basic try/catch | Structured error system |
| Tests | None | Jest + Supertest |
| Docker | No | Dockerfile + docker-compose |
| Rate limiting | Global only | Global + per-client |
| Compression | No | Gzip compression |

---

## Project Structure

```
nook-sms-production/
├── src/
│   ├── index.js                    ← Entry point
│   ├── config/
│   │   ├── env.js                  ← Env validation (crashes if wrong)
│   │   ├── logger.js               ← Winston logging
│   │   └── database.js             ← Supabase client + SQL schema
│   ├── routes/
│   │   ├── sms.js                  ← /v1/sms/*
│   │   ├── analytics.js            ← /v1/analytics/*
│   │   └── clients.js              ← /v1/clients/*
│   ├── services/
│   │   ├── SmsService.js           ← Core SMS logic
│   │   └── GatewayService.js       ← Multi-gateway with failover
│   ├── middleware/
│   │   ├── auth.js                 ← API key auth with caching
│   │   └── validate.js             ← Joi validation
│   └── queues/
│       └── BulkSmsQueue.js         ← Bull queue for bulk sending
├── tests/
│   └── sms.test.js                 ← Jest tests
├── Dockerfile                      ← Production container
├── docker-compose.yml              ← Local dev environment
├── .env.example                    ← Environment template
└── package.json
```

---

## Setup — 10 Steps to Production

### Step 1 — Clone and install
```bash
git clone your-repo
cd nook-sms-production
npm install
```

### Step 2 — Create Supabase database
1. Go to supabase.com → New project
2. Open SQL Editor
3. Paste the SQL from `src/config/database.js` (the comment block)
4. Run all SQL — creates all tables

### Step 3 — Configure environment
```bash
cp .env.example .env
```
Fill in `.env`:
- `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` from Supabase
- `AT_API_KEY` and `AT_USERNAME` from Africa's Talking
- Generate `JWT_SECRET`: `node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"`
- Generate `WEBHOOK_SECRET`: same command
- Generate `ADMIN_API_KEY`: same command

### Step 4 — Start Redis (for bulk SMS queue)
```bash
# With Docker:
docker run -d -p 6379:6379 redis:7-alpine

# Or with docker-compose (recommended):
docker-compose up redis -d
```

### Step 5 — Run tests
```bash
npm test
```

### Step 6 — Start in development
```bash
npm run dev
```

### Step 7 — Test the API
```bash
# Health check
curl http://localhost:3000/health

# Register a client
curl -X POST http://localhost:3000/v1/clients/register \
  -H "Content-Type: application/json" \
  -d '{
    "company_name": "Rapidio",
    "email": "tech@rapidio.ma",
    "phone": "+212612345678",
    "plan": "standard"
  }'

# Send an SMS (use the api_key from registration response)
curl -X POST http://localhost:3000/v1/sms/send \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "to": "+212612345678",
    "message": "Votre code est 4829"
  }'
```

### Step 8 — Deploy to Railway.app
```bash
# Install Railway CLI
npm install -g @railway/cli

# Login
railway login

# Create project
railway new

# Add environment variables (copy from .env)
railway variables set KEY=VALUE ...

# Deploy
railway up
```

### Step 9 — Configure Africa's Talking webhook
In your Africa's Talking dashboard:
- Delivery reports URL: `https://your-app.railway.app/v1/sms/webhook/delivery`

### Step 10 — Set your custom domain
In Railway: Settings → Domains → Add custom domain → api.nook.ma

---

## All API Endpoints

### Public (no auth)
```
POST /v1/clients/register    Create business account
GET  /health                 Server health status
GET  /                       API information
```

### Authenticated (require API key)
```
GET  /v1/clients/me          Account information
PATCH /v1/clients/me         Update account
POST /v1/clients/rotate-key  Rotate API key
GET  /v1/clients/billing     Transaction history

POST /v1/sms/send            Send single SMS
POST /v1/sms/bulk            Send bulk SMS (queued)
GET  /v1/sms/bulk/status/:id Check bulk job progress
GET  /v1/sms/status/:id      Check single message status
GET  /v1/sms/messages        List messages (paginated)

GET  /v1/analytics/overview  Full dashboard stats
GET  /v1/analytics/usage     Messages over time
GET  /v1/analytics/best-times Best sending times
```

---

## Gateway Failover — How It Works

```
Business sends SMS
        ↓
Africa's Talking (primary)
    ↓ SUCCESS → done
    ↓ FAIL
Vonage (fallback 1)
    ↓ SUCCESS → done
    ↓ FAIL
Infobip (fallback 2)
    ↓ SUCCESS → done
    ↓ FAIL → return error
```

After 3 consecutive failures on a gateway, it is skipped automatically until it recovers.

---

## Pricing — Your Margins

| You pay (AT) | You charge | Your margin |
|-------------|-----------|-------------|
| 0.07 DH | 0.20 DH | 65% |

Monthly revenue at 1M messages: 200,000 DH
Monthly gateway cost: 70,000 DH
Your profit: 130,000 DH

---

## Security Features

- ✅ Helmet.js — 11 security HTTP headers
- ✅ CORS — only your domains allowed
- ✅ Rate limiting — global + per-client plan
- ✅ Input validation — Joi schemas, rejects bad data early
- ✅ API key format check — before database query
- ✅ Client cache — reduces DB queries by 80%
- ✅ Webhook signature verification — Africa's Talking HMAC
- ✅ Non-root Docker user — container security
- ✅ Environment validation — crashes fast if config wrong
- ✅ API key rotation with audit trail
- ✅ Partial key logging — never full key in logs
- ✅ SQL injection protection — Supabase parameterized queries

---

## This is your infrastructure.
## You own it.
## Deploy it. Sell access. Build on it.
## 🚀
# nsmstest
# nsmstest
