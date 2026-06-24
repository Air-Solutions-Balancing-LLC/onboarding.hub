# Onboarding Hub 🚀

A web app to manage company onboarding procedures, built as an interactive to-do list with task tracking, orientation planning, and resource links.

---

## Files

| File | Purpose |
|------|---------|
| `index.html` | Main app (UI + logic) |
| `config.js` | Supabase URL + anon key |
| `hub-auth.js` | Microsoft sign-in + shared data sync |
| `supabase-schema.sql` | Run in Supabase SQL Editor |
| `netlify.toml` | Netlify routing config |

---

## Deployment Steps

### Step 1 — Supabase (Database + Auth)

1. Go to [app.supabase.com](https://app.supabase.com) and open your project.
2. **SQL Editor** → paste `supabase-schema.sql` → **Run**.
3. **Settings → API** → copy the **anon public** key into `config.js` (replace `REPLACE_WITH_YOUR_ANON_KEY`).
4. **Authentication → Providers → Azure** → enable and enter your Azure app credentials (client ID, secret, tenant URL).
5. **Authentication → URL Configuration**:
   - **Site URL:** `https://airadigmonboarding.netlify.app`
   - **Redirect URLs:** add `https://airadigmonboarding.netlify.app` and `http://localhost:3000`

### Step 1b — Azure App Registration

In [Azure Portal](https://portal.azure.com) → **App registrations** → your app → **Authentication**:

- Add redirect URI (Web): `https://skranbwtgsoqjiwhnxak.supabase.co/auth/v1/callback`

Only users in your Air Solutions Azure tenant can sign in (configured via the tenant URL in Supabase).

### Step 2 — GitHub (Code Hosting)

1. Go to [github.com/Air-Solutions-Balancing-LLC/onboarding.hub](https://github.com/Air-Solutions-Balancing-LLC/onboarding.hub) (org repo).

### Step 3 — Netlify (Publishing)

1. Go to [netlify.com](https://app.netlify.com) and click **Add new site → Import from Git**.
2. Connect your GitHub account and select your `onboarding-hub` repository.
3. Leave build settings blank (no build command needed).
4. Click **Deploy site**.
5. Your app will be live at a URL like `https://your-app.netlify.app`.

### Step 4 — Sign in

1. Open the live app URL.
2. Click **Sign in with Microsoft** using your Air Solutions account.
3. On first sign-in, any data in your browser's local storage is migrated to Supabase so the team shares one database.

---

## Local development

```bash
npm install
npm run dev
```

Open http://localhost:3000 and sign in with Microsoft (add `http://localhost:3000` to Supabase redirect URLs).

---

## Features

- **Dashboard** — Stats overview, urgent tasks, upcoming orientation highlights
- **Weekly Tasks** — Kanban board (Not Started / In Progress / Completed) with category filters and add task
- **May 2026 Orientation** — 6-phase prep plan with progress bar and checkable steps
- **Responsibilities** — Expandable procedures with step-by-step checklists
- **Resources** — All links and documents from the Excel spreadsheet

## Sharing

Signed-in users share the same Supabase data — tasks, resources, checkboxes, and orientation plans stay in sync for the whole team.

## Customization

- **Nav tab colors**: Edit CSS in `index.html` (`.nav-link.active` rules)
- **Default data**: Edit `DEFAULT_RESOURCES`, `DEFAULT_RESPONSIBILITIES`, and `INIT_TASKS` in `index.html`
