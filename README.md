# Onboarding Hub 🚀

A web app to manage company onboarding procedures, built as an interactive to-do list with task tracking, orientation planning, and resource links.

---

## Files

| File | Purpose |
|------|---------|
| `index.html` | Main app HTML |
| `styles.css`  | All styles + branding (Navy #1A5276, Gold #F4D03F) |
| `app.js`      | App logic, Supabase integration, rendering |
| `supabase-schema.sql` | Run this in Supabase SQL Editor first |
| `netlify.toml` | Netlify routing config |

---

## Deployment Steps

### Step 1 — Supabase (Database)

1. Go to [app.supabase.com](https://app.supabase.com) and create a **New Project**.
2. Once created, go to **SQL Editor** and paste the contents of `supabase-schema.sql`. Click **Run**.
3. Go to **Settings → API** and copy:
   - **Project URL** (e.g. `https://xxxx.supabase.co`)
   - **anon public** key

### Step 2 — GitHub (Code Hosting)

1. Go to [github.com/Air-Solutions-Balancing-LLC/onboarding.hub](https://github.com/Air-Solutions-Balancing-LLC/onboarding.hub) (org repo).

### Step 3 — Netlify (Publishing)

1. Go to [netlify.com](https://app.netlify.com) and click **Add new site → Import from Git**.
2. Connect your GitHub account and select your `onboarding-hub` repository.
3. Leave build settings blank (no build command needed).
4. Click **Deploy site**.
5. Your app will be live at a URL like `https://your-app.netlify.app`.

### Step 4 — Connect Supabase in the App

1. Open your live app URL.
2. The setup screen will appear. Enter your Supabase **Project URL** and **anon key**.
3. Click **Connect & Initialize** — the app will create initial data automatically.
4. Share the URL with your team. Everyone uses the same link!

---

## Features

- **Dashboard** — Stats overview, urgent tasks, upcoming orientation highlights
- **Weekly Tasks** — Kanban board (Not Started / In Progress / Completed) with category filters and add task
- **May 2026 Orientation** — 6-phase prep plan with progress bar and checkable steps
- **Responsibilities** — Expandable procedures with step-by-step checklists
- **Resources** — All links and documents from the Excel spreadsheet

## Sharing

Since the app uses Supabase's public anon key, **all users see the same data** — checkboxes, task status updates, and new tasks are shared across everyone who opens the link. This is ideal for a small team.

## Customization

- **Colors**: Edit CSS variables at the top of `styles.css` (currently Navy `#1A5276` + Gold `#F4D03F`)
- **Procedures**: Edit the `RESPONSIBILITIES` array in `app.js`
- **Orientation tasks**: Edit `ORIENTATION_PHASES` in `app.js`
- **Resources**: Edit `LINKS_DATA` in `app.js`
