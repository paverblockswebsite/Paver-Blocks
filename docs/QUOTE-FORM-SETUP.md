# Development quotation form setup

The public quotation page contains a secure enquiry form that is shown only when both preview build variables are configured. It sends submissions to the development Worker; the Worker validates Turnstile server-side and stores accepted enquiries in the development D1 database.

## Development endpoints

- Pages preview hostname: `development-site-foundation.paver-blocks.pages.dev`
- Worker API origin: `https://paver-blocks-api-dev.hellopaverblocks.workers.dev`
- Submission route: `POST /api/public/inquiries`
- D1 database: `paver-blocks-dev`

## 1. Create a development Turnstile widget

In the Cloudflare dashboard, open Turnstile and select **Add widget**.

Use these settings:

- Widget name: `Paver Blocks Development Quote Form`
- Hostname: `development-site-foundation.paver-blocks.pages.dev` (hostname only; no scheme or path)
- Widget mode: **Managed**
- The page sets the widget action to `inquiry`; the Worker requires the same action and the exact hostname in the Siteverify response.

Copy the **sitekey** and **secret key**. The sitekey is public and belongs in the Pages preview build environment. The secret key must remain private and must never be committed to Git.

## 2. Configure Pages preview build variables

In Cloudflare Pages, open project `paver-blocks` → Settings → Environment variables → Preview. Add:

- `VITE_PUBLIC_API_BASE_URL` = `https://paver-blocks-api-dev.hellopaverblocks.workers.dev`
- `VITE_TURNSTILE_SITE_KEY` = the widget sitekey

Do not set these production values yet. Save the preview variables and trigger a new preview build so Astro can embed the public values in the static page.

## 3. Configure the Worker secret

In Workers & Pages, open `paver-blocks-api-dev` → Settings → Variables and Secrets. Add:

- `TURNSTILE_SECRET_KEY` as an encrypted secret using the widget secret key.

The checked-in development Wrangler configuration already sets `TURNSTILE_HOSTNAME` to the preview hostname and `SITE_ORIGIN` to the approved Pages branch-preview origin. Do not place the secret in Wrangler configuration or GitHub.

## 4. Safe verification

Before collecting real customer enquiries:

1. Confirm the preview quote page displays the Turnstile widget and form.
2. Submit one clearly labelled test enquiry using non-sensitive test details.
3. Confirm the Worker returns success and the row is saved in the development `inquiries` table.
4. Confirm a missing, expired, reused, or invalid Turnstile token is rejected without a D1 write.
5. After the admin Access application is configured, confirm the test enquiry appears in the private dashboard.
6. Select and document the inquiry/audit retention periods and publish an appropriate privacy notice before accepting real customer data.

The Worker fails closed when the Turnstile secret is missing or verification fails. Do not disable Turnstile to make the form appear to work.

## Production boundary

This setup is development-only. Do not add production API origins, production Turnstile keys, or production secrets until the domain, Access path protection, privacy/retention requirements, and live integration tests have been reviewed and separately approved.
