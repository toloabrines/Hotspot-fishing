import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "app.lovable.hotspotfishing",
  appName: "Hotspot Fishing",
  webDir: "dist",
  server: {
    // App "shell": carga la web publicada en Lovable.
    // Requiere conexión a internet (los mapas oceanográficos ya la necesitan).
    url: "https://hotspot-fishing.lovable.app",
    cleartext: false,
  },
  ios: {
    contentInset: "always",
  },
  android: {
    // Mismas garantías que en iOS: HTTPS estricto, sin contenido mixto,
    // y captura de gestos para que el mapa Leaflet funcione bien en WebView.
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: false,
  },
};

export default config;

