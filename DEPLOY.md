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
