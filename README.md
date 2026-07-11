# Radpro TLD Personal Monitoring Service — Deployable Notifications + RSC Edition

> **Windows note:** Do not open `public/index.html` directly. Start the Node.js server with `START-RADPRO-WINDOWS.bat` or `npm start`, then open `http://localhost:3000`. The login, database, uploads, notifications and reports require the backend server.

This package converts the browser-only TLD Personal Monitoring prototype into a deployable Node.js application for RSO-controlled personnel dose, document and compliance management.

## What is included

- Node.js 22+ + Express backend
- SQLite database persistence using Node 22 built-in `node:sqlite`
- Session-based login with optional two-factor authentication
- Role-based access levels: employee, RSO/admin, system admin and read-only auditor
- Radpro Panel Admin dashboard for organization/hospital/group control, trial start/end dates, registration/renewal status, package details, billing amount/cycle, hospital limits and TLD user limits
- RSO/admin employee management with email, mobile/WhatsApp and TLD badge/Pers No. fields
- Employee portal with dose history, published documents, annual statement PDF and e-sign acknowledgement
- CSV / Excel / text-PDF dose report import from the frontend
- Rentech/BARC-style text-PDF parser with leading-zero TLD/Pers No. matching
- Per-employee filled TLD personal monitoring form attachments
- Quarter-wise TLD report attachments
- Document vault with open, download and delete actions
- Quarter compliance matrix: dose record + form + acknowledgement
- Automated reminder workflow for TLD return, report upload, missing forms and pending acknowledgements
- RSO-generated notifications for all TLD users, all employees or an individual user through portal, email and WhatsApp/mobile channels
- Targeted TLD dose-limit notifications after report import, so only employees whose imported Hp(10) crosses the configured limit are notified
- Configurable employee portal dose visibility: show all users their own dose records, or show dose records only to employees whose Hp(10) is at/above the configured notification limit
- Radiation Safety Committee module with member list, add/edit/delete, meeting minutes, decisions/action items and uploaded committee documents
- Email and WhatsApp provider hooks for reminders, notifications and 2FA codes
- Annual personal dose statement PDF per employee
- Overexposure/high-dose investigation workflow with RSO note, root cause, corrective action, closure status, e-signature and PDF export
- Accidental / overexposure case register for manual incident reporting, suspected/confirmed overexposure, abnormal TLD readings, badge misuse/loss, contaminated badge and pregnancy dose review
- Case fields for employee, received dose, dose report quarter, incident note, suspected cause, medical review, action taken, corrective/preventive action, reporting status, RSC review, employee acknowledgement/no-objection signature, closure and RSO e-signature
- Digital/e-sign dose acknowledgement for employees and RSO investigation closure
- Encrypted JSON backup export/restore using AES-256-GCM
- Audit log with CSV export
- AERB audit pack ZIP export with employee master, dose history, quarterly reports, forms, acknowledgements, investigation records, accidental/overexposure cases, notifications, Radiation Safety Committee records and audit log
- Forgot username / password recovery using registered email/mobile
- Dockerfile and Docker Compose setup

## Initial admin accounts

The first launch creates internal setup accounts for deployment/testing, but credentials are no longer displayed on the login page.

- Radpro Panel Admin: `radpro` / `radpro123`
- Demo Hospital RSO: `rso` / `rso123`

Change these passwords immediately after first login before customer use. The login page includes a Forgot username/password recovery flow using registered email/mobile. Configure SMTP or WhatsApp variables for production recovery delivery.

## Local development run

This Windows-friendly build needs Node.js 22.5 or newer. It does not use `better-sqlite3`, so Windows does not need Visual Studio C++ Build Tools just to install the app.

On Windows CMD:

```cmd
cd /d F:\radpro-tld-monitoring-compliance-edition\tld-monitoring-deployable
copy .env.example .env
npm install
npm start
```

On PowerShell / Linux / macOS:

```bash
cd tld-monitoring-deployable
cp .env.example .env
npm install
npm start
```

Open:

```text
http://localhost:3000
```

## Docker deployment

```bash
cd tld-monitoring-deployable
cp .env.example .env
# Edit .env and set a strong SESSION_SECRET
openssl rand -hex 32

docker compose up -d --build
```

Open:

```text
http://localhost:3000
```

Docker Compose stores the database and uploaded files in the named volume `radpro_tld_data`.

## Email, WhatsApp and 2FA configuration

Reminders, RSO notifications and 2FA codes work in two modes:

1. **Logged/skipped mode** — no provider configured. The app records the reminder attempt but does not deliver it externally.
2. **Live provider mode** — configure SMTP and/or WhatsApp variables in `.env`.

SMTP example variables:

```env
SMTP_HOST=smtp.your-domain.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=alerts@your-domain.com
SMTP_PASS=your_password
SMTP_FROM=alerts@your-domain.com
```

WhatsApp options:

- Use WhatsApp Cloud API with `WHATSAPP_PHONE_NUMBER_ID` and `WHATSAPP_TOKEN`; or
- Use `WHATSAPP_API_URL` for your own webhook that accepts JSON `{ "to": "...", "message": "..." }`.

Set `TWO_FACTOR_REQUIRED=true` to require 2FA for all accounts, or enable 2FA per user in the employee master.

Set `AUTO_REMINDERS_ENABLED=true` to run the reminder sweep automatically. The sweep checks the current quarter for missing forms, missing acknowledgements and missing quarterly report uploads. RSO-created notifications are generated manually from the **Notifications** tab and are always saved in the portal history; email/WhatsApp delivery is attempted when those channels and providers are configured.

## Production checklist

1. Set a strong `SESSION_SECRET` in `.env`.
2. Change the demo RSO password.
3. Put the app behind HTTPS using a reverse proxy such as Nginx, Caddy or your hosting platform.
4. Set `COOKIE_SECURE=true` only when HTTPS is active.
5. Configure SMTP/WhatsApp provider credentials before enabling live reminders or mandatory 2FA.
6. Back up the persistent volume or the `data/` folder regularly.
7. Use encrypted backups for off-server storage.
8. Restrict server access to trusted users or your hospital/institution network.
9. Increase `MAX_UPLOAD_MB` only if your infrastructure and backup process can handle larger attachment files.
10. Validate report import and audit pack output against your official RSO workflow before production use.

## Data storage

By default:

- SQLite database: `./data/radpro_tld.db`
- Uploaded files: `./data/uploads/`

In Docker:

- SQLite database: `/app/data/radpro_tld.db`
- Uploaded files: `/app/data/uploads/`

## Importing from the old offline prototype

In the deployable app, log in as RSO, open **Reminders & AERB Pack**, and use **Import Backup JSON**. The importer supports the earlier localStorage backup structure with employees, doses, acknowledgements and attachments. Attachments stored as data URLs are converted into real files in the upload directory.

Encrypted backup restore: enter the password in the backup password field before importing the encrypted JSON file.

## TLD report import assumptions

The frontend parser follows the same practical rule used in the prototype:

- First column = TLD badge number or Pers No.
- CSV/Excel rows use Hp(10) and Hp(0.07) from the dose columns/last dose values
- Rentech-style text PDFs are parsed by row coordinates and selected service period
- Employee mapping is done by normalized TLD/Pers No.; unique employee-name matching is used as a fallback

For scanned PDFs, convert the report to CSV/Excel first or use OCR outside this app before import.

## Useful endpoints

- `GET /health` — health check
- `POST /api/auth/login` — login
- `POST /api/auth/verify-2fa` — complete 2FA login
- `GET /api/backup/export` — RSO backup export
- `GET /api/backup/export?encrypted=1&password=<password>` — encrypted backup export
- `GET /api/audit/export.csv` — audit log CSV export
- `GET /api/aerb/audit-pack` — AERB audit pack ZIP export
- `POST /api/notifications` — generate RSO notification for all TLD users, all employees or one user
- `GET /api/notifications` — notification history / employee portal notifications
- `GET /api/rsc/members` — Radiation Safety Committee member list
- `GET /api/rsc/meetings` — Radiation Safety Committee meetings and minutes
- `GET /api/rsc/documents` — Radiation Safety Committee document index
- `GET /api/reports/annual-statement/:employeeId?year=2026` — annual dose statement PDF
- `GET /api/investigations/:id/pdf` — investigation PDF export
- `GET /api/overexposure-cases` — accidental / overexposure case register
- `GET /api/overexposure-cases/:id/pdf` — accidental / overexposure case PDF export

## Notes

This Windows-friendly package uses the built-in Node.js SQLite module available in Node 22+. This avoids native `better-sqlite3` compilation errors on Windows.

This is a deployable internal application starter. For regulated clinical production use, add institution-specific security review, access controls, audit retention policy, server backups, HTTPS, validation against official TLD/PMS reports, and documented acceptance testing.

## Windows local opening note

Do not open `public/index.html` directly from Explorer/WinRAR. This is a server-backed application and must be opened through Node.js.

For Windows local use:

1. Extract the full ZIP to a normal folder such as `F:\radpro-tld`.
2. Double-click `OPEN_RADPRO_TLD_WINDOWS.bat` in the outer folder, or `START_RADPRO_WINDOWS.bat` inside `tld-monitoring-deployable`.
3. Keep the black command window open.
4. Open `http://localhost:3000` in Chrome/Edge.

Default setup accounts are created for deployment/testing only; credentials are not shown on the live login page. Use `radpro / radpro123` for Radpro Panel Admin or `rso / rso123` for the demo Hospital RSO, then change passwords immediately.


## Multi-hospital registration model

This edition adds a Radpro Panel / Hospitals module.

Default accounts:

- Radpro Panel Admin: `radpro` / `radpro123`
- Demo Hospital RSO: `rso` / `rso123`

Access roles:

- `sysadmin`: Radpro panel admin. Can register organizations/hospital groups and hospitals/institutes.
- `org_admin`: organization super admin. Can manage multiple hospitals under one organization.
- `admin` / `rso`: hospital-level admin/RSO. Can manage users, TLD reports, forms, RSC, notifications and audit pack for that hospital.
- `auditor`: read-only audit user.
- `employee`: TLD user self-service portal.

Recommended workflow:

1. Login as `radpro`.
2. Open **Radpro Panel / Hospitals**.
3. Create an organization/hospital group.
4. Add one or more hospitals/institutes under the organization.
5. Create an Organization Super Admin user with access role `org_admin`.
6. Create hospital-level RSO/Admin users with access role `rso` or `admin` and assign their hospital.
7. Hospital RSO adds TLD users, imports quarterly TLD reports and manages compliance records.


## Added in v2.5.0 - Quarterly Awareness & Acknowledgement Reports

- TLD Dose Acknowledgement Status PDF report with employee name, TLD number, department, quarter, dose, acknowledged/pending status and acknowledgement date.
- Awareness poster shown mandatorily to each TLD user once every quarter before employee portal access.
- Awareness acceptance is logged employee-wise and quarter-wise.
- Awareness Acceptance PDF report for RSO/Audit records.
- Awareness records included in backup/restore and AERB audit pack export.
- Default Hindi TLD safe-use awareness poster included at `public/assets/tld_awareness_hindi.jpg`.


## Radiation Safety Training Module

This edition includes a Radiation Safety Training tab. The uploaded AERB-style training document is included at `public/assets/radiation_safety_training_module.pdf`.

RSO/Admin workflow:
- Open **Radiation Safety Training**.
- Select the quarter and number of questions, for example 10.
- Click **Auto Create Random Questionnaire**.
- Review participant scores and export **Training Score PDF**.

Employee workflow:
- Open **Radiation Safety Training** in the employee portal.
- Open/read the training document.
- Start the objective multiple-choice questionnaire.
- Submit answers and view score out of the total marks.

Each question carries 1 point. Score reports are available in PDF for audit/training records.

## Phase 1 cloud stabilization

This build is intended for Render Starter + persistent disk deployment before the future PostgreSQL/object-storage migration.

Required Render disk:

- Mount path: `/app/data`
- Size: 1 GB for trial or 5 GB+ for production

Required environment values:

```env
NODE_ENV=production
PORT=3000
DATA_DIR=/app/data
DB_FILE=/app/data/radpro_tld.db
UPLOAD_DIR=/app/data/uploads
COOKIE_SECURE=true
SESSION_SECRET=replace_with_long_random_secret
MAX_UPLOAD_MB=25
ENABLE_DEMO_SEED=false
```

Health checks:

- Public: `/health`
- Radpro Super Admin: `/api/system/cloud-status`
- Radpro Super Admin preflight: POST `/api/system/cloud-preflight`

Important: do not use Render Free for real customer trial data. SQLite database and uploaded files require persistent disk storage.
