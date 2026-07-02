# Hotspot-fishing

## iOS publishing

This repository uses the workflow:

- `.github/workflows/ios-testflight.yml`

## Required Secrets

Configure these **Repository Secrets** in GitHub:

- `APP_STORE_CONNECT_API_KEY_ID`
- `APP_STORE_CONNECT_ISSUER_ID`
- `APP_STORE_CONNECT_API_KEY`
- `APP_STORE_CONNECT_APPLE_ID`

## Running

1. Go to **Actions**
2. Select **Build iOS and Publish to App Store**
3. Choose `beta` for TestFlight or `release` for App Store
4. Click **Run workflow**

See `/home/runner/work/Hotspot-fishing/Hotspot-fishing/PUBLISHING.md` for the full publishing checklist and metadata requirements.
