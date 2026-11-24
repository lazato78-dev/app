# Círculo Azul

A private, bilingual (Spanish / English) community where mothers of autistic teens chat about everyday life, with a paid monthly membership.

## Features
- **Live chat rooms** (Socket.io): meltdowns, school, sensory, sleep & food, puberty, friendships, family, self-care, wins.
- **Forum**: topics by category, with replies.
- **Learn**: guides on the autism spectrum and support levels, autistic love languages, meltdowns and sensory needs, communication, the teen years, caregiver self-care, and community guidelines.
- **Membership**: Stripe Checkout subscription + Stripe billing portal. With no Stripe keys configured, the app runs in free access mode.
- **Moderation**: report button on everything; admins (from `ADMIN_EMAIL`) can review and remove reported content.
- Accounts with email + password (bcrypt, httpOnly JWT cookie).

## Run locally
```
npm install
npm start
```
Open http://localhost:3000. With no `DATABASE_URL`, data is stored in an embedded Postgres in `./data`.

## Environment variables
| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (Render sets it automatically) |
| `JWT_SECRET` | Secret for login cookies (Render generates it) |
| `ADMIN_EMAIL` | Comma-separated emails that become moderators |
| `STRIPE_SECRET_KEY` | Stripe secret key |
| `STRIPE_PRICE_ID` | ID of the recurring monthly price |
| `STRIPE_WEBHOOK_SECRET` | Signing secret for `https://<your-app>/api/stripe/webhook` |
| `PRICE_LABEL` | Price text shown on the site, e.g. `$9.99 USD / mes` |

## Deploy on Render
1. Push this repo to GitHub.
2. In Render: **New → Blueprint**, choose the repo. `render.yaml` creates the web service and the database.
3. Fill in `ADMIN_EMAIL`, and later the Stripe variables.

## Stripe setup
1. In Stripe, create a product "Membresía" with a **recurring monthly price**, and copy its `price_...` ID.
2. Developers → Webhooks → add endpoint `https://<your-app>.onrender.com/api/stripe/webhook` with events `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`. Copy the `whsec_...` secret.
3. Enable the **Customer portal** in Stripe Billing settings.
4. Put the three values in the Render environment variables.
