# Publishing

This repository includes iOS publishing workflows that require the following files before App Store automation can run:

- `app-metadata.json`
- `app-store-config.json`
- `app-screenshots.md`
- `ios/App/Info.plist.template`

## Placeholder values to replace

Before shipping to TestFlight or the App Store, update these placeholders with real Apple values:

- `app-store-config.json` → `bundleIdentifier`, `appId`, and `teamId`
- `ios/App/Info.plist.template` → any additional production plist keys your iOS app needs

## Screenshots

See `app-screenshots.md` for the expected App Store screenshot set and capture guidance.
