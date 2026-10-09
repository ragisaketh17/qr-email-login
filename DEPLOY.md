# Deploy to Vercel

Vercel runs the app as a serverless function, so it must use a remote database.
This project uses Turso/libSQL on Vercel and keeps local SQLite for development.

## Deploy

1. Create a Turso database and generate a database auth token. Keep both values
   private; do not put them in source files.
2. Push the project to a GitHub repository, then import that repository in
   Vercel. Use the repository root as the project root and keep the detected
   Node.js build settings.
3. Add these environment variables in the Vercel project settings for
   **Production** (and Preview too, if you want preview deployments to work):
   - `TURSO_DATABASE_URL`: the database URL from Turso.
   - `TURSO_AUTH_TOKEN`: the database auth token from Turso.
   - `DASHBOARD_USERNAME`: your chosen dashboard username.
   - `DASHBOARD_PASSWORD`: a unique, strong password.
   - `DASHBOARD_UTC_OFFSET_MINUTES`: `330` for India, or your timezone's UTC
     offset in minutes.
4. Deploy (or redeploy after adding the environment variables), then open the
   Vercel deployment URL. The app uses Vercel's assigned URL for QR codes.

Vercel deployments intentionally fail with a service-unavailable response when
the Turso URL or auth token is missing; they never fall back to temporary local
SQLite storage. The Turso database starts empty; customer records in the
existing local `users.db` are not uploaded automatically.

# Deploy to Render

This app uses SQLite. The Render Blueprint provisions a persistent disk for the
database, so customer accounts, visits, and reward claims survive deploys and
restarts. Persistent disks require a paid Render web service.

## Deploy

1. Commit and push this project to a GitHub repository. Do not commit `.env`,
   `users.db`, or credentials.
2. In Render, choose **New > Blueprint**, connect the repository, and select
   `render.yaml`.
3. When prompted, set `DASHBOARD_USERNAME` and `DASHBOARD_PASSWORD`. Use a
   unique, strong password; do not deploy with the local default `admin123`.
4. Deploy the Blueprint and wait for the service health check to pass.
5. Open the `onrender.com` service URL. The app uses Render's assigned external
   URL automatically for its QR code and dashboard links.

The deployed SQLite database starts empty; the ignored local `users.db` is not
uploaded. Back up important data before deleting or replacing the Render disk.
