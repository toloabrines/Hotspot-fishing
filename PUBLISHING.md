# App Store publishing

## Required repository secrets

- `APP_STORE_CONNECT_API_KEY_ID`
- `APP_STORE_CONNECT_ISSUER_ID`
- `APP_STORE_CONNECT_API_KEY`
- `APP_STORE_CONNECT_APPLE_ID` (recommended for Appfile account resolution)

Optional overrides:

- `APPLE_TEAM_ID`
- `APP_STORE_TEAM_ID`
- `IOS_SCHEME`
- `IOS_CONFIGURATION`
- `IOS_PROJECT`
- `IOS_WORKSPACE`
- `TESTFLIGHT_CHANGELOG`

## One-time setup

1. Update `/home/runner/work/Hotspot-fishing/Hotspot-fishing/app-store-config.json` with the real App Store Connect values:
   - `bundleIdentifier`
   - `appId`
   - `teamId`
   - `appStoreTeamId`
2. Review `/home/runner/work/Hotspot-fishing/Hotspot-fishing/app-metadata.json` and replace the default description, keywords, and category if needed.
3. Copy the values from `/home/runner/work/Hotspot-fishing/Hotspot-fishing/ios/App/Info.plist.template` into the real iOS app `Info.plist` when the Xcode project is added.
4. Add App Store screenshots to `/home/runner/work/Hotspot-fishing/Hotspot-fishing/ios/App/fastlane/screenshots/en-US/`.

## Publishing checklist

- [ ] App name is correct in `app-metadata.json`
- [ ] Description and keywords are finalized
- [ ] Category matches the App Store listing
- [ ] Screenshots are exported and added to `ios/App/fastlane/screenshots/en-US/`
- [ ] App icon is ready in the Xcode asset catalog (1024x1024)
- [ ] Pricing and availability are configured in App Store Connect
- [ ] Privacy details and support URL are configured in App Store Connect
- [ ] `app-store-config.json` contains the real bundle ID, app ID, and team IDs
- [ ] App version is `1.0.0`
- [ ] Build number is `1`

## GitHub Actions publishing flow

1. Open **Actions** in GitHub.
2. Run **Build iOS and Publish to App Store**.
3. Choose `beta` to upload to TestFlight or `release` to upload the binary, metadata, and screenshots to App Store Connect.
4. For `release`, optionally enable:
   - `submit_for_review`
   - `automatic_release`

The workflow always validates:

- `app-metadata.json`
- `app-store-config.json`
- `app-screenshots.md`
- `ios/App/Info.plist.template`
- `PUBLISHING.md`

If the repository does not yet contain a real Xcode project or workspace in `ios/App`, the workflow stops after the publishing pre-flight checks and reports that the binary upload step was skipped.

## Fastlane lanes

- `fastlane beta` builds the iOS app and uploads the binary to TestFlight.
- `fastlane release` builds the iOS app, generates App Store metadata from `app-metadata.json`, validates screenshots, and uploads the release to App Store Connect.
