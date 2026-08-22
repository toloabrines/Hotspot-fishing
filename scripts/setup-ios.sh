#!/usr/bin/env bash
# ============================================================
#  Hotspot Fishing — bootstrap del proyecto iOS (Capacitor)
#  Ejecutar UNA VEZ en un Mac (local o runner macOS de CI).
#  Requisitos: macOS, Xcode 15+, Node 20+, bun o npm, CocoaPods.
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "▶︎ 1/6  Instalando dependencias JS"
if command -v bun >/dev/null 2>&1; then
  bun install
else
  npm install
fi

echo "▶︎ 2/6  Build de producción de la PWA"
if command -v bun >/dev/null 2>&1; then
  bun run build
else
  npm run build
fi

echo "▶︎ 3/6  Añadiendo plataforma iOS (si no existe)"
if [ ! -d "ios" ]; then
  npx cap add ios
else
  echo "    ios/ ya existe — salto cap add"
fi

echo "▶︎ 4/6  Copiando Privacy Manifest"
mkdir -p ios/App/App
cp ios-config/PrivacyInfo.xcprivacy ios/App/App/PrivacyInfo.xcprivacy
echo "    ⚠︎ En Xcode: arrastrar PrivacyInfo.xcprivacy al target App"
echo "      la primera vez (Copy if needed = ON, Target = App)."

echo "▶︎ 5/6  Mergeando claves de Info.plist"
PLIST="ios/App/App/Info.plist"
if [ -f "$PLIST" ]; then
  /usr/libexec/PlistBuddy -c "Add :NSLocationWhenInUseUsageDescription string 'Hotspot Fishing usa tu ubicación únicamente para centrar el mapa oceanográfico en tu posición actual. No se almacena ni se comparte.'" "$PLIST" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Add :ITSAppUsesNonExemptEncryption bool false" "$PLIST" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string 'Hotspot Fishing'" "$PLIST" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Add :UIFileSharingEnabled bool true" "$PLIST" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Add :LSSupportsOpeningDocumentsInPlace bool true" "$PLIST" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Add :LSApplicationQueriesSchemes array" "$PLIST" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Add :LSApplicationQueriesSchemes:0 string comgoogleearth" "$PLIST" 2>/dev/null || true
  echo "    Claves base añadidas. Revisa ios-config/Info.plist.snippet.xml"
  echo "    para añadir orientaciones soportadas manualmente."
else
  echo "    ✗ No existe $PLIST (¿falló cap add ios?)"
  exit 1
fi

echo "▶︎ 6/6  Sincronizando assets y generando iconos"
npx cap sync ios
if [ -f "public/icon-512.png" ]; then
  npx --yes @capacitor/assets generate --ios --iconBackgroundColor '#0a1929' || true
fi

echo ""
echo "✅ iOS listo. Siguientes pasos:"
echo "   - Abrir con:  npx cap open ios"
echo "   - O dejar que GitHub Actions + fastlane lo firmen y suban a TestFlight."

