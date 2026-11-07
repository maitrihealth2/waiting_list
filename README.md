# Waitlist Server - Affyne Labs

Express server for managing waitlist signups, maintaining an aggregated document of all email IDs, and sending welcome emails from `no-reply@auth.affynelabs.com` via Google SMTP.

## Key Features

- **Automated Name Extraction**: Subscribers only need to provide their email address. The server automatically derives their name (e.g. `john.doe@example.com` → `John Doe`, `keerthivardhanm@gmail.com` → `Keerthi Vardhan M`).
- **Interactive Web Control Hub (`GET /`)**: Open `http://localhost:3000/` in any browser to view live queue metrics, submit test registrations with live auto-detected name preview, search subscriber status, and download full CSV exports.
- **Zero-Data-Leak Architecture**:
  - Administrative endpoints (`/api/emails`, `/api/waitlist/export`) are strictly gated by `ADMIN_API_KEY`.
  - Public status lookups (`/api/waitlist/position`) return **only** sequence position and reference number with zero PII leakage.
  - Sanitized health check with zero internal configuration exposure.
- **Separate Email ID Storage**:
  - **Aggregated Document** (`meta/all_emails`): Holds an array of all collected email IDs and total count in a single document for quick exports and inspection.
  - **Dedicated Collection** (`subscribers/{email}`): Individual document per subscriber with contact and position metadata.
- **Automated Waitlist Numbering**: Sequences entries starting from `1001+` (e.g., `1015`, `WL-01015`).
- **Nodemailer SMTP Integration**: Sends responsive HTML and plain-text welcome emails with sender set to `Affyne Labs <no-reply@auth.affynelabs.com>`.
- **Deduplication**: Automatically rejects duplicate email registrations with a `409 Conflict` response.
- **Queue Count Endpoint (`GET /api/waitlist/count`)**: Returns real-time waitlist size for frontend widgets.
- **Position Lookup (`GET /api/waitlist/position?email=...`)**: Query subscriber details by email.
- **Resend Welcome Email (`POST /api/waitlist/resend`)**: Re-dispatches confirmation emails on demand.
- **One-Click CSV Export (`GET /api/waitlist/export`)**: Direct download of all waitlist entries in CSV format.
- **Contact Inquiries (`POST /api/contact`)**: Logs user inquiries and sends auto-acknowledgement emails.

---

## API Reference

### 1. Join Waitlist (Name is Optional!)
`POST /api/waitlist`

```json
{
  "email": "keerthi.vardhan@gmail.com"
}
```
*Note: `name` is completely optional. If omitted, the server extracts `Keerthi Vardhan` directly from the email address.*

**Response (`201 Created`):**
```json
{
  "success": true,
  "message": "You have been added to the waiting list.",
  "referenceNumber": "WL-01015",
  "waitlistNumber": 1015,
  "referralUrl": "https://affynelabs.com?ref=WL-01015",
  "emailSent": true
}
```

### 2. Live Queue Counter
`GET /api/waitlist/count`
```json
{
  "success": true,
  "count": 9,
  "nextNumber": 1015
}
```

### 3. Check Position
`GET /api/waitlist/position?email=user@example.com`
```json
{
  "success": true,
  "waitlistNumber": 1010,
  "referenceNumber": "WL-01010",
  "status": "approved"
}
```

### 4. Resend Confirmation Email
`POST /api/waitlist/resend`
```json
{
  "email": "user@example.com"
}
```

### 5. Export CSV (Protected)
`GET /api/waitlist/export?key=<ADMIN_API_KEY>`
Or header `x-admin-key: <ADMIN_API_KEY>`

---

## Running the Server

```bash
# Start server with auto-reload
npm run dev

# Or standard production start
npm start
```
Open **`http://localhost:3000`** in your browser.
