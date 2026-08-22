import { Capacitor } from "@capacitor/core";
import { EarthShareNative } from "./earth-share-native";

export type GeneratedFileExportResult =
  "shared" | "downloaded" | "opened" | "copied" | "empty" | "cancelled";

interface GeneratedFileDownloadOptions {
  filename: string;
  mime: string;
  content: string;
  shareTitle?: string;
  shareText?: string;
}

function isShareCancel(error: unknown): boolean {
  const value = error as { name?: string; message?: string };
  return (
    value?.name === "AbortError" ||
    /cancel|cancelado|dismiss|closed|Share canceled/i.test(String(value?.message ?? error))
  );
}

function isCapacitorNative(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    if (typeof window === "undefined") return false;
    const cap = (window as unknown as { Capacitor?: { getPlatform?: () => string } }).Capacitor;
    const p = cap?.getPlatform?.();
    return p === "ios" || p === "android";
  }
}

function capacitorPlatform(): string {
  try {
    return Capacitor.getPlatform();
  } catch {
    if (typeof window === "undefined") return "web";
    const cap = (window as unknown as { Capacitor?: { getPlatform?: () => string } }).Capacitor;
    return cap?.getPlatform?.() ?? "web";
  }
}

function isIosLike(): boolean {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  const platform = navigator.platform || "";
  return /iPad|iPhone|iPod/i.test(ua) || (platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

// Esquemas oficiales de Google Earth en iOS. Si la app está instalada, abren
// directamente; si no, iOS muestra un error silencioso y caemos al fallback.
const GOOGLE_EARTH_IOS_SCHEMES = [
  "comgoogleearth-x-callback://",
  "comgoogleearth-x-callback://x-callback-url/open",
  "comgoogleearth://",
];
const GOOGLE_EARTH_APP_STORE_URL = "https://apps.apple.com/app/google-earth/id293622097";

type GoogleEarthLaunchResult = "opened" | "not-installed" | "unknown";

async function openAppStoreForGoogleEarth(): Promise<void> {
  if (typeof window === "undefined") return;
  if (isCapacitorNative() && capacitorPlatform() === "ios") {
    try {
      await EarthShareNative.openGoogleEarthStore();
      return;
    } catch {
      // plugin nativo antiguo/no disponible: usar AppLauncher/web
    }
  }
  if (isCapacitorNative()) {
    try {
      const { AppLauncher } = await import("@capacitor/app-launcher");
      await AppLauncher.openUrl({ url: GOOGLE_EARTH_APP_STORE_URL });
      return;
    } catch {
      // usar fallback web
    }
  }
  try {
    window.open(GOOGLE_EARTH_APP_STORE_URL, "_blank", "noopener");
  } catch {
    try {
      window.location.href = GOOGLE_EARTH_APP_STORE_URL;
    } catch {
      /* noop */
    }
  }
}

async function isGoogleEarthInstalledNative(): Promise<boolean | null> {
  if (!isCapacitorNative()) return null;
  try {
    const result = await EarthShareNative.isGoogleEarthInstalled();
    return !!result.installed;
  } catch {
    // plugin nativo antiguo/no disponible: probar AppLauncher
  }
  try {
    const { AppLauncher } = await import("@capacitor/app-launcher");
    for (const url of GOOGLE_EARTH_IOS_SCHEMES) {
      try {
        const { value } = await AppLauncher.canOpenUrl({ url });
        if (value) return true;
      } catch {
        // probar siguiente esquema
      }
    }
    return false;
  } catch {
    return null;
  }
}

async function tryOpenGoogleEarthApp(): Promise<GoogleEarthLaunchResult> {
  if (typeof window === "undefined") return "unknown";
  // En Capacitor nativo: canOpenUrl nos dice con certeza si la app está.
  if (isCapacitorNative()) {
    const installed = await isGoogleEarthInstalledNative();
    if (installed === false) return "not-installed";
    if (capacitorPlatform() === "ios") {
      try {
        const result = await EarthShareNative.openGoogleEarth();
        return result.opened ? "opened" : "unknown";
      } catch (err) {
        const msg = String((err as Error)?.message ?? err);
        if (/GOOGLE_EARTH_NOT_INSTALLED/i.test(msg)) return "not-installed";
      }
    }
    try {
      const { AppLauncher } = await import("@capacitor/app-launcher");
      for (const url of GOOGLE_EARTH_IOS_SCHEMES) {
        try {
          const canOpen = installed === true || (await AppLauncher.canOpenUrl({ url })).value;
          if (canOpen) {
            const result = await AppLauncher.openUrl({ url });
            if (result.completed === false) continue;
            return "opened";
          }
        } catch {
          // probar siguiente esquema
        }
      }
      if (installed === true) return "unknown";
      return "not-installed";
    } catch {
      // plugin no disponible
    }
    return "unknown";
  }
  // En navegador iOS: Safari no nos dice si funcionó. Detectamos por visibilidad:
  // si la pestaña se oculta tras intentar abrir el esquema, la app se abrió.
  return await new Promise<GoogleEarthLaunchResult>((resolve) => {
    let settled = false;
    const onHide = () => {
      if (document.hidden && !settled) {
        settled = true;
        cleanup();
        resolve("opened");
      }
    };
    const cleanup = () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onHide);
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onHide);
    try {
      window.location.href = GOOGLE_EARTH_IOS_SCHEMES[1];
    } catch {
      settled = true;
      cleanup();
      resolve("unknown");
      return;
    }
    setTimeout(() => {
      if (!settled) {
        settled = true;
        cleanup();
        resolve(document.hidden ? "opened" : "not-installed");
      }
    }, 1200);
  });
}

function isGoogleEarthFile(filename: string, mime?: string): boolean {
  const lower = filename.toLowerCase();
  return (
    lower.endsWith(".kml") || lower.endsWith(".kmz") || /google-earth|kml|kmz/i.test(mime ?? "")
  );
}

function earthMime(filename: string, mime?: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".kmz")) return "application/vnd.google-earth.kmz";
  if (lower.endsWith(".kml")) return "application/vnd.google-earth.kml+xml";
  return mime || "application/vnd.google-earth.kml+xml";
}

function safeExportFilename(filename: string): string {
  return (
    filename
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "export.kml"
  );
}

async function shareViaCapacitor(
  filename: string,
  mime: string,
  content: string,
  shareTitle?: string,
): Promise<GeneratedFileExportResult | null> {
  let lastNativeError: unknown = null;
  try {
    const platform = capacitorPlatform();
    const safeName = safeExportFilename(filename);

    // Los GPX en iOS pasan directamente por nuestro UIActivityViewController.
    // El plugin Share genérico puede resolver sin presentar nada en WKWebView.
    if (platform === "ios" && safeName.toLowerCase().endsWith(".gpx")) {
      try {
        await EarthShareNative.shareFile({
          filename: safeName,
          content,
          title: shareTitle ?? "Compartir GPX",
        });
        return "shared";
      } catch (err) {
        if (isShareCancel(err)) return "cancelled";
        lastNativeError = err;
        console.warn("No se pudo abrir el compartidor GPX nativo.", err);
      }
    }

    if (platform === "ios" && isGoogleEarthFile(safeName, mime)) {
      const installed = await isGoogleEarthInstalledNative();
      if (installed === false) {
        await openAppStoreForGoogleEarth();
        window.alert(
          "Google Earth no está instalado. Te he abierto la App Store para instalarlo; después vuelve a tocar Google Earth en Hotspot Fishing.",
        );
        return "cancelled";
      }
      try {
        await EarthShareNative.shareKml({
          filename: safeName,
          content,
          title: shareTitle ?? "Abrir en Google Earth",
        });
        return "shared";
      } catch (err) {
        lastNativeError = err;
        const msg = String((err as Error)?.message ?? err);
        if (/GOOGLE_EARTH_NOT_INSTALLED/i.test(msg)) {
          await openAppStoreForGoogleEarth();
          window.alert(
            "Google Earth no está instalado. Te he abierto la App Store para instalarlo; después vuelve a tocar Google Earth en Hotspot Fishing.",
          );
          return "cancelled";
        }
        if (/cancel|dismiss|Share canceled/i.test(msg)) return "cancelled";
        console.warn("Plugin nativo EarthShare no disponible; probando Share estándar.", err);
      }
    }

    const [{ Filesystem, Directory, Encoding }, { Share }] = await Promise.all([
      import("@capacitor/filesystem"),
      import("@capacitor/share"),
    ]);
    const directory = platform === "ios" ? Directory.Documents : Directory.Cache;
    // En iOS deja el KML en Documents raíz: UIActivityViewController y Archivos
    // resuelven mejor el tipo por extensión si no va dentro de subcarpetas.
    const path = safeName;

    const written = await Filesystem.writeFile({
      path,
      data: content,
      directory,
      encoding: Encoding.UTF8,
      recursive: true,
    });

    const uriResult = await Filesystem.getUri({ path, directory }).catch(() => null);
    const fileUri = uriResult?.uri ?? written.uri;
    if (!fileUri) return null;

    // En iPhone, FileOpener/UIDocumentInteractionController puede resolver la
    // promesa aunque iOS no llegue a presentar ningún menú para KML/KMZ. Eso
    // dejaba el botón en "no hace nada" porque no entraba ningún fallback.
    // La hoja nativa de compartir sí presenta siempre una acción visible y es
    // el flujo que Google Earth registra para recibir archivos KML/KMZ.
    if (isGoogleEarthFile(safeName, mime)) {
      if (platform === "ios") {
        // ÚNICO flujo iPhone: hoja nativa de compartir. No usamos FileOpener
        // como fallback en iOS porque UIDocumentInteractionController puede
        // devolver éxito sin enseñar nada, que es justo el fallo reportado.
        const shareAttempts: Parameters<typeof Share.share>[0][] = [
          { title: shareTitle ?? "Abrir en Google Earth", files: [fileUri] },
          { title: shareTitle ?? "Abrir en Google Earth", url: fileUri },
        ];

        for (const options of shareAttempts) {
          try {
            await Share.share(options);
            return "shared";
          } catch (err) {
            lastNativeError = err;
            const msg = String((err as Error)?.message ?? err);
            if (/cancel|dismiss|Share canceled/i.test(msg)) return "cancelled";

            // Si iOS aún está cerrando otra hoja/presentación, reintenta una vez
            // después de que termine la transición nativa.
            if (/progress|present|presentation|share/i.test(msg)) {
              await new Promise((resolve) => setTimeout(resolve, 450));
              try {
                await Share.share(options);
                return "shared";
              } catch (retryErr) {
                lastNativeError = retryErr;
                const retryMsg = String((retryErr as Error)?.message ?? retryErr);
                if (/cancel|dismiss|Share canceled/i.test(retryMsg)) return "cancelled";
              }
            }
          }
        }

        console.warn("No se pudo mostrar la hoja nativa de KML/KMZ en iOS.", lastNativeError);
        // Último recurso nativo: intentar abrir Google Earth con deep link.
        // El KML ya está en Documents → el usuario podrá importarlo desde la app.
        const launched = await tryOpenGoogleEarthApp();
        if (launched === "opened") return "opened";
        if (launched === "not-installed") await openAppStoreForGoogleEarth();
        return null;
      }

      try {
        const { FileOpener } = await import("@capacitor-community/file-opener");
        const baseOptions: Parameters<typeof FileOpener.open>[0] = {
          filePath: fileUri,
          openWithDefault: false,
          chooserPosition: {
            x: Math.round(window.innerWidth / 2),
            y: Math.round(window.innerHeight / 2),
          },
        };

        // En iOS, dejar contentType vacío permite que UIDocumentInteractionController
        // resuelva la UTI por extensión (.kml/.kmz). Si el sistema no la resuelve,
        // segundo intento con MIME explícito. En Android conviene pasar MIME.
        const attempts: Parameters<typeof FileOpener.open>[0][] =
          platform === "ios"
            ? [baseOptions, { ...baseOptions, contentType: earthMime(safeName, mime) }]
            : [{ ...baseOptions, contentType: earthMime(safeName, mime) }];

        let lastError: unknown = null;
        for (const options of attempts) {
          try {
            await FileOpener.open(options);
            return "opened";
          } catch (err) {
            lastError = err;
            const msg = String((err as Error)?.message ?? err);
            if (/cancel|dismiss/i.test(msg)) return "cancelled";
          }
        }
        console.warn("No se pudo abrir KML/KMZ con FileOpener; usando compartir.", lastError);
      } catch (err) {
        const msg = String((err as Error)?.message ?? err);
        if (/cancel|dismiss/i.test(msg)) return "cancelled";
        console.warn("FileOpener no disponible para KML/KMZ; usando compartir.", err);
      }
    }

    await Share.share({
      title: shareTitle ?? filename,
      files: [fileUri],
      dialogTitle: shareTitle ?? "Compartir",
    });
    return "shared";
  } catch (err) {
    lastNativeError = err;
    const msg = String((err as Error)?.message ?? err);
    if (/cancel|dismiss/i.test(msg)) return "cancelled";
    console.warn("Exportación nativa fallida.", lastNativeError);
    return null;
  }
}

async function shareFileOnly(
  filename: string,
  mime: string,
  content: string,
  shareTitle?: string,
): Promise<GeneratedFileExportResult> {
  const safeName = safeExportFilename(filename);

  if (isCapacitorNative()) {
    try {
      const [{ Filesystem, Directory, Encoding }, { Share }] = await Promise.all([
        import("@capacitor/filesystem"),
        import("@capacitor/share"),
      ]);
      const directory = Directory.Cache;
      await Filesystem.writeFile({
        path: safeName,
        data: content,
        directory,
        encoding: Encoding.UTF8,
        recursive: true,
      });
      const { uri } = await Filesystem.getUri({ path: safeName, directory });
      await Share.share({
        title: shareTitle ?? safeName,
        files: [uri],
      });
      return "shared";
    } catch (err) {
      if (isShareCancel(err)) return "cancelled";
      console.warn("No se pudo abrir Compartir con el archivo.", err);
    }
  }

  const nav = navigator as Navigator & {
    canShare?: (data: ShareData) => boolean;
    share?: (data: ShareData) => Promise<void>;
  };

  if (nav.share && typeof File !== "undefined" && !isInIframe()) {
    try {
      const file = new File([content], safeName, { type: mime });
      if (!nav.canShare || nav.canShare({ files: [file] })) {
        await nav.share({ files: [file], title: shareTitle ?? safeName });
        return "shared";
      }
    } catch (err) {
      if (isShareCancel(err)) return "cancelled";
      console.warn("Web Share no pudo compartir el archivo.", err);
    }
  }

  return "cancelled";
}

function isInIframe(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.self !== window.top;
  } catch {
    return true; // cross-origin access denied → estamos en un iframe
  }
}

function submitAttachmentDownload(
  filename: string,
  mime: string,
  content: string,
  iframed: boolean,
  hiddenTarget = false,
  forceBlank = false,
): boolean {
  if (typeof document === "undefined") return false;

  const form = document.createElement("form");
  form.method = "POST";
  form.action = "/api/public/gpx-download";
  form.style.display = "none";
  // En iframe sandbox (preview de Lovable) usar _blank para abrir el download
  // en una pestaña nueva sin sacar al usuario de la app. En la app publicada
  // _self mantiene la sesión y Safari/Chrome lo tratan como descarga real
  // gracias a Content-Disposition: attachment.
  let frame: HTMLIFrameElement | null = null;
  if (hiddenTarget) {
    frame = document.createElement("iframe");
    frame.name = `kml-download-${Date.now()}`;
    frame.style.display = "none";
    document.body.appendChild(frame);
    form.target = frame.name;
  } else {
    form.target = forceBlank || iframed ? "_blank" : "_self";
  }
  form.rel = "noopener";

  const filenameInput = document.createElement("input");
  filenameInput.type = "hidden";
  filenameInput.name = "filename";
  filenameInput.value = filename;

  const mimeInput = document.createElement("input");
  mimeInput.type = "hidden";
  mimeInput.name = "mime";
  mimeInput.value = mime;

  const contentInput = document.createElement("textarea");
  contentInput.name = "content";
  contentInput.value = content;

  form.append(filenameInput, mimeInput, contentInput);
  document.body.appendChild(form);
  form.submit();
  setTimeout(() => {
    form.remove();
    frame?.remove();
  }, 3000);
  return true;
}

async function copyContent(filename: string, content: string): Promise<GeneratedFileExportResult> {
  try {
    await navigator.clipboard?.writeText(content);
    alert(`${filename} copiado al portapapeles.`);
    return "copied";
  } catch {
    alert(`No se pudo exportar ${filename}. Abre la app en Safari/Chrome y vuelve a intentarlo.`);
    return "cancelled";
  }
}

function blobAnchorDownload(filename: string, mime: string, content: string): boolean {
  if (typeof document === "undefined") return false;
  try {
    const blob = new Blob([content], { type: `${mime};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    a.target = "_self";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 8000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Hoja de exportación propia (siempre visible). Cada botón se ejecuta dentro
 * de su propio gesto del usuario, que es lo que Safari/Chrome exigen para
 * permitir Compartir o Descargar. Devuelve inmediatamente: no hay awaits
 * previos que invaliden la activación del usuario.
 */
export interface ExportFileSpec {
  filename: string;
  mime: string;
  content: string;
}

export function presentExportSheet(
  filename: string,
  mime: string,
  content: string,
): GeneratedFileExportResult {
  return presentExportSheetMulti([{ filename, mime, content }]);
}

/**
 * Hoja de exportación propia (siempre visible) con una fila por archivo.
 * Cada botón se ejecuta dentro de su propio gesto del usuario, que es lo que
 * Safari/Chrome exigen para permitir Compartir o Descargar. Con varios
 * archivos (GPX + KML) ninguna ventana sustituye a la anterior: el usuario
 * guarda uno, y la hoja sigue abierta para el siguiente.
 */
export function presentExportSheetMulti(files: ExportFileSpec[]): GeneratedFileExportResult {
  if (typeof document === "undefined" || files.length === 0) return "cancelled";

  const specs = files.map((f) => {
    const safeName = safeExportFilename(f.filename);
    const isEarth = isGoogleEarthFile(safeName, f.mime);
    return {
      safeName,
      isEarth,
      mime: isEarth ? earthMime(safeName, f.mime) : f.mime || "text/plain",
      content: f.content,
    };
  });
  const anyEarth = specs.some((s) => s.isEarth);

  document.getElementById("hotspot-kml-export-fallback")?.remove();

  const overlay = document.createElement("div");
  overlay.id = "hotspot-kml-export-fallback";
  overlay.style.cssText = [
    "position:fixed",
    "inset:0",
    "z-index:2147483647",
    "display:flex",
    "align-items:center",
    "justify-content:center",
    "padding:18px",
    "background:rgba(2,6,23,.78)",
    "font-family:system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
  ].join(";");

  const box = document.createElement("div");
  box.style.cssText = [
    "width:min(380px,100%)",
    "max-height:86vh",
    "overflow:auto",
    "border:1px solid rgba(16,185,129,.65)",
    "border-radius:14px",
    "background:#07111f",
    "color:#f8fafc",
    "box-shadow:0 18px 50px rgba(0,0,0,.45)",
    "padding:16px",
  ].join(";");

  const title = document.createElement("div");
  title.textContent =
    specs.length > 1
      ? `${specs.length} archivos listos`
      : specs[0]!.isEarth
        ? "KML listo para Google Earth"
        : `${specs[0]!.safeName} listo`;
  title.style.cssText = "font-size:15px;font-weight:800;margin-bottom:8px";

  const message = document.createElement("div");
  message.textContent =
    specs.length > 1
      ? "Guarda cada archivo por separado: la ventana no se cierra hasta que pulses Cerrar."
      : anyEarth
        ? "Pulsa Guardar en Archivos. Después podrás abrir el KML desde Archivos o compartirlo con Google Earth."
        : "Pulsa Guardar en Archivos para conservar el archivo en este dispositivo.";
  message.style.cssText = "font-size:13px;line-height:1.35;color:#cbd5e1;margin-bottom:14px";

  const status = document.createElement("div");
  status.style.cssText =
    "display:none;margin-bottom:10px;border-radius:9px;background:#0f172a;color:#d1fae5;padding:8px;font-size:12px;line-height:1.3";

  const say = (text: string) => {
    status.style.display = "block";
    status.textContent = text;
  };

  const rows = document.createElement("div");
  rows.style.cssText = "display:flex;flex-direction:column;gap:12px";

  for (const spec of specs) {
    const row = document.createElement("div");
    row.style.cssText =
      "border:1px solid rgba(148,163,184,.25);border-radius:12px;padding:10px;background:#0b1626";

    const name = document.createElement("div");
    name.textContent = spec.safeName;
    name.style.cssText =
      "font-size:12.5px;font-weight:700;color:#e2e8f0;margin-bottom:8px;word-break:break-all";

    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:8px;flex-wrap:wrap";

    const saveToFiles = document.createElement("button");
    saveToFiles.type = "button";
    saveToFiles.textContent = "Guardar en Archivos";
    saveToFiles.style.cssText =
      "flex:1 1 160px;border:0;border-radius:10px;background:#10b981;color:#04111d;font-weight:800;padding:10px 12px;font-size:13px";

    const fallbackDownload = (): boolean =>
      isInIframe()
        ? submitAttachmentDownload(spec.safeName, spec.mime, spec.content, true, false, true)
        : blobAnchorDownload(spec.safeName, spec.mime, spec.content) ||
          submitAttachmentDownload(spec.safeName, spec.mime, spec.content, false, false, true);

    saveToFiles.onclick = async () => {
      const nav = navigator as Navigator & {
        canShare?: (data: ShareData) => boolean;
        share?: (data: ShareData) => Promise<void>;
      };
      // En el visor embebido y en navegadores sin Web Share con archivos
      // (Chrome escritorio, Android antiguo) la única vía real es la descarga.
      if (isInIframe() || !nav.share || typeof File === "undefined") {
        const ok = fallbackDownload();
        say(
          ok
            ? `Archivo enviado a Descargas: ${spec.safeName}`
            : "El navegador ha bloqueado el guardado. Abre la app fuera del visor y vuelve a intentarlo.",
        );
        if (ok) saveToFiles.textContent = "Guardado ✓";
        return;
      }

      saveToFiles.textContent = "Abriendo Archivos…";
      saveToFiles.setAttribute("disabled", "true");
      const candidates = fileShareMimeCandidates(spec.safeName, spec.mime);
      let lastMessage = "";
      for (const candidate of candidates) {
        try {
          const file = new File([spec.content], spec.safeName, candidate ? { type: candidate } : undefined);
          if (nav.canShare && !nav.canShare({ files: [file] })) continue;
          await nav.share({ files: [file], title: spec.safeName });
          say(`${spec.safeName}: elige “Guardar en Archivos”.`);
          saveToFiles.textContent = "Guardar de nuevo";
          saveToFiles.removeAttribute("disabled");
          return;
        } catch (err) {
          const e = err as Error;
          if (e?.name === "AbortError") {
            lastMessage = "Has cerrado el menú de compartir.";
            break;
          }
          lastMessage = e?.message || "El sistema ha bloqueado el menú de compartir.";
        }
      }
      // Si el sistema no ofrece Compartir, no dejamos al usuario sin archivo.
      const ok = !lastMessage.includes("cerrado") ? fallbackDownload() : false;
      say(ok ? `Archivo enviado a Descargas: ${spec.safeName}` : lastMessage || "Usa Descargar.");
      saveToFiles.textContent = "Guardar en Archivos";
      saveToFiles.removeAttribute("disabled");
    };

    const download = document.createElement("button");
    download.type = "button";
    download.textContent = "Descargar";
    download.style.cssText =
      "flex:1 1 110px;border:1px solid rgba(16,185,129,.7);border-radius:10px;background:#052e24;color:#d1fae5;font-weight:800;padding:10px 12px;font-size:13px";
    download.onclick = () => {
      const ok = fallbackDownload();
      say(ok ? `${spec.safeName} enviado a Descargas.` : "No se pudo iniciar la descarga.");
    };

    const copy = document.createElement("button");
    copy.type = "button";
    copy.textContent = "Copiar";
    copy.style.cssText =
      "border:1px solid rgba(148,163,184,.45);border-radius:10px;background:#0f172a;color:#f8fafc;font-weight:700;padding:10px 12px;font-size:13px";
    copy.onclick = () => {
      void navigator.clipboard?.writeText(spec.content);
      copy.textContent = "Copiado";
    };

    actions.append(saveToFiles, download, copy);
    row.append(name, actions);
    rows.append(row);
  }

  const footer = document.createElement("div");
  footer.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;margin-top:14px";

  if (anyEarth) {
    const openApp = document.createElement("button");
    openApp.type = "button";
    openApp.textContent = "Abrir Google Earth";
    openApp.style.cssText =
      "flex:1 1 140px;border:1px solid rgba(59,130,246,.7);border-radius:10px;background:#0b1e3a;color:#dbeafe;font-weight:800;padding:10px 12px;font-size:13px";
    openApp.onclick = async () => {
      if (!isCapacitorNative() && !isIosLike()) {
        say("Abriendo Google Earth Web. Allí: ☰ → Proyectos → Importar archivo KML y elige el archivo guardado.");
        window.open("https://earth.google.com/web/", "_blank", "noopener,noreferrer");
        return;
      }
      say("Abriendo Google Earth…");
      const result = await tryOpenGoogleEarthApp();
      if (result === "opened") {
        say("Si Google Earth no se abre, guarda el KML y ábrelo desde Archivos.");
        return;
      }
      say("Google Earth no está instalado. Abriendo la tienda…");
      await openAppStoreForGoogleEarth();
    };
    footer.append(openApp);
  }

  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "Cerrar";
  close.style.cssText =
    "flex:0 0 auto;border:0;border-radius:10px;background:#1e293b;color:#f8fafc;font-weight:700;padding:10px 14px;font-size:13px";
  close.onclick = () => overlay.remove();
  footer.append(close);

  box.append(title, message, status, rows, footer);
  overlay.append(box);
  document.body.appendChild(overlay);
  // La hoja está visible, pero el archivo aún no se ha guardado. Devolver
  // "opened" evita que una exportación combinada sustituya esta hoja por la
  // siguiente antes de que el usuario pueda pulsar Guardar en Archivos.
  return "opened";
}


function fileShareMimeCandidates(filename: string, mime: string): string[] {
  const lower = filename.toLowerCase();
  const candidates = lower.endsWith(".kml")
    ? [mime, "application/vnd.google-earth.kml+xml", "application/xml", "text/xml", ""]
    : lower.endsWith(".gpx")
      ? [mime, "application/gpx+xml", "application/xml", "text/xml", ""]
      : lower.endsWith(".geojson") || /geo\+json|json/i.test(mime)
        ? [mime, "application/geo+json", "application/json", "text/plain", ""]
      : [mime, "application/xml", "text/xml", ""];
  return Array.from(new Set(candidates));
}

/**
 * Guarda el archivo EN EL DISPOSITIVO ("Archivos" en iPhone, "Descargas" en
 * Android/escritorio). Prioriza mecanismos que terminan en un archivo real:
 *  1) App nativa (Capacitor) → Filesystem + hoja nativa "Guardar en Archivos".
 *  2) File System Access API (Chrome/Edge Android y escritorio) → selector.
 *  3) Web Share con archivo (iOS Safari/PWA muestra "Guardar en Archivos").
 *  4) Descarga real vía POST al endpoint con Content-Disposition: attachment.
 *  5) Blob + anchor y, como último recurso, portapapeles.
 */
/**
 * Exportación garantizada: en la app nativa usa la hoja del sistema; en web
 * (Safari, Chrome, PWA o preview embebido) muestra SIEMPRE nuestra hoja con
 * Compartir / Descargar / Google Earth / Copiar, de modo que el botón nunca
 * se queda "sin hacer nada".
 */
export async function exportFileWithSheet({
  filename,
  mime,
  content,
  shareTitle,
}: GeneratedFileDownloadOptions): Promise<GeneratedFileExportResult> {
  if (typeof window === "undefined") return "cancelled";
  if (isCapacitorNative()) {
    const platform = capacitorPlatform();
    if (platform === "ios") {
      try {
        const result = await EarthShareNative.saveFileToFiles({
          filename: safeExportFilename(filename),
          content,
          title: shareTitle ?? filename,
        });
        return result.saved ? "downloaded" : "cancelled";
      } catch (err) {
        if (isShareCancel(err)) return "cancelled";
        console.warn("El selector nativo de Archivos falló; usando Compartir.", err);
      }
    }
    if (platform === "android") {
      // Paridad con iPhone: dejamos primero un archivo real en Documentos y
      // después abrimos la hoja del sistema ("Guardar en Archivos"/Drive).
      const saved = await writeToAndroidDocuments(filename, content);
      const shared = await shareViaCapacitor(filename, mime, content, shareTitle);
      if (shared && shared !== "cancelled") return shared;
      if (saved) return "downloaded";
      if (shared === "cancelled") return "cancelled";
      return presentExportSheet(filename, mime, content);
    }
    const result = await shareViaCapacitor(filename, mime, content, shareTitle);
    if (result && result !== "cancelled") return result;
    if (result === "cancelled") return result;
  }
  return presentExportSheet(filename, mime, content);
}

/** Escribe el archivo en Documentos (Android) para que exista en el dispositivo. */
async function writeToAndroidDocuments(filename: string, content: string): Promise<boolean> {
  try {
    const { Filesystem, Directory, Encoding } = await import("@capacitor/filesystem");
    await Filesystem.writeFile({
      path: safeExportFilename(filename),
      data: content,
      directory: Directory.Documents,
      encoding: Encoding.UTF8,
      recursive: true,
    });
    return true;
  } catch (err) {
    console.warn("No se pudo escribir en Documentos (Android).", err);
    return false;
  }
}

/**
 * Exporta varios archivos (p. ej. GPX + KML) sin que ninguna ventana se salte:
 * en nativo se guardan de uno en uno (esperando a que el usuario termine con
 * el anterior) y en web se muestra una única hoja con una fila por archivo.
 */
export async function exportFilesWithSheet(
  files: ExportFileSpec[],
  shareTitle?: string,
): Promise<GeneratedFileExportResult> {
  if (typeof window === "undefined" || files.length === 0) return "cancelled";
  if (isCapacitorNative()) {
    let last: GeneratedFileExportResult = "cancelled";
    for (const file of files) {
      last = await exportFileWithSheet({ ...file, shareTitle: shareTitle ?? file.filename });
      if (last === "cancelled") return "cancelled";
    }
    return last;
  }
  return presentExportSheetMulti(files);
}


export async function saveGeneratedFileToDevice({

  filename,
  mime,
  content,
  shareTitle,
  shareText,
}: GeneratedFileDownloadOptions): Promise<GeneratedFileExportResult> {
  if (typeof window === "undefined") return "cancelled";
  const safeName = safeExportFilename(filename);
  const iframed = isInIframe();

  // 1) App nativa
  if (isCapacitorNative()) {
    const result = await shareViaCapacitor(safeName, mime, content, shareTitle);
    if (result) return result;
  }

  // 2) Selector de guardado nativo del navegador
  const picker = (
    window as unknown as {
      showSaveFilePicker?: (opts: unknown) => Promise<{
        createWritable: () => Promise<{ write: (d: string) => Promise<void>; close: () => Promise<void> }>;
      }>;
    }
  ).showSaveFilePicker;
  if (!iframed && typeof picker === "function") {
    try {
      const ext = safeName.slice(safeName.lastIndexOf("."));
      const handle = await picker({
        suggestedName: safeName,
        types: [{ description: "Archivo", accept: { [mime]: [ext] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(content);
      await writable.close();
      return "downloaded";
    } catch (err) {
      if (isShareCancel(err)) return "cancelled";
      console.warn("showSaveFilePicker no disponible.", err);
    }
  }

  // 3) Hoja de compartir con archivo (iOS: "Guardar en Archivos")
  const nav = navigator as Navigator & {
    canShare?: (data: ShareData) => boolean;
    share?: (data: ShareData) => Promise<void>;
  };
  if (!iframed && nav.share && typeof File !== "undefined") {
    for (const candidate of fileShareMimeCandidates(safeName, mime)) {
      try {
        const file = new File([content], safeName, candidate ? { type: candidate } : undefined);
        if (nav.canShare && !nav.canShare({ files: [file] })) continue;
        await nav.share({ files: [file], title: shareTitle ?? safeName, text: shareText });
        return "shared";
      } catch (err) {
        if (isShareCancel(err)) return "cancelled";
      }
    }
  }

  // 4) Descarga real desde el servidor (Content-Disposition: attachment)
  if (submitAttachmentDownload(safeName, mime, content, iframed, false, iframed || isIosLike()))
    return "downloaded";

  // 5) Fallbacks
  if (blobAnchorDownload(safeName, mime, content)) return "downloaded";
  return copyContent(safeName, content);
}

export async function downloadGeneratedFile({
  filename,
  mime,
  content,
  shareTitle,
  shareText,
}: GeneratedFileDownloadOptions): Promise<GeneratedFileExportResult> {
  if (typeof window === "undefined") return "cancelled";

  const iframed = isInIframe();
  const nav = navigator as Navigator & {
    canShare?: (data: ShareData) => boolean;
    share?: (data: ShareData) => Promise<void>;
  };

  // 0) En app nativa (Capacitor iOS/Android) el Web Share API con archivos no
  // funciona de forma fiable en WKWebView. Usamos el plugin nativo: escribimos
  // el archivo en el sandbox; para KML en iOS abrimos el menú nativo "Abrir en"
  // con UIDocumentInteractionController para que Google Earth salga como destino.
  if (isCapacitorNative()) {
    const result = await shareViaCapacitor(filename, mime, content, shareTitle);
    if (result) return result;
    if (isGoogleEarthFile(filename, mime)) {
      window.alert(
        "iPhone no ha podido abrir la hoja de Google Earth. El KML se ha guardado como 'frentes-productivos.kml' en Archivos → En mi iPhone → Hotspot Fishing. Ábrelo desde Archivos y elige Compartir → Google Earth.",
      );
      return "cancelled";
    }
    // Si falla, seguimos con los fallbacks web.
  }

  // 1) Web Share API (iOS/Android nativo y PWA). Bloqueada en iframes.
  if (!iframed && nav.share && typeof File !== "undefined") {
    const mimeCandidates = fileShareMimeCandidates(filename, mime);
    for (const candidate of mimeCandidates) {
      try {
        const file = new File([content], filename, candidate ? { type: candidate } : undefined);
        if (nav.canShare && !nav.canShare({ files: [file] })) continue;
        await nav.share({ files: [file], title: shareTitle ?? filename, text: shareText });
        return "shared";
      } catch (err) {
        const name = (err as Error)?.name;
        if (name === "AbortError") return "cancelled";
      }
    }
  }

  // En iPhone navegador/preview no usamos POST ni iframe: iOS puede convertir
  // esa respuesta en una pestaña blanca. Dejamos la app en pantalla y mostramos
  // un enlace local tocable por el usuario, que Safari sí trata como archivo.
  if (!isCapacitorNative() && isIosLike() && isGoogleEarthFile(filename, mime)) {
    return presentExportSheet(filename, mime, content);
  }

  // 2) Dentro de un iframe sandboxed (preview de Lovable, embebidos) el blob
  // anchor suele fallar silenciosamente. Probamos primero el form POST que
  // abre la descarga real desde el servidor con Content-Disposition.
  if (iframed && submitAttachmentDownload(filename, mime, content, iframed)) return "downloaded";

  // 3) Blob + anchor download — método principal fuera de iframe: funciona en
  // navegador desktop, PWA y la mayoría de WebViews nativas.
  if (blobAnchorDownload(filename, mime, content)) return "downloaded";

  // 4) Form POST como último recurso en navegadores muy restrictivos.
  if (submitAttachmentDownload(filename, mime, content, iframed)) return "downloaded";

  return copyContent(filename, content);
}

export async function saveGeneratedFileToFiles({
  filename,
  mime,
  content,
  shareTitle,
  shareText,
}: GeneratedFileDownloadOptions): Promise<GeneratedFileExportResult> {
  if (typeof window === "undefined") return "cancelled";

  // En la app iOS abre directamente UIDocumentPicker en modo exportación:
  // el usuario elige una carpeta de Archivos y pulsa Guardar.
  if (isCapacitorNative() && capacitorPlatform() === "ios") {
    try {
      const result = await EarthShareNative.saveFileToFiles({
        filename: safeExportFilename(filename),
        content,
        title: shareTitle ?? filename,
      });
      return result.saved ? "downloaded" : "cancelled";
    } catch (err) {
      if (isShareCancel(err)) return "cancelled";
      console.warn("El selector nativo de Archivos no está disponible; usando Compartir.", err);
    }
  }

  // En la web/PWA, y también si una instalación nativa todavía no incluye el
  // plugin actualizado, no terminamos silenciosamente. Este flujo intenta en
  // orden: selector de archivos, Compartir con el GPX y descarga HTTP real.
  // La descarga HTTP es esencial dentro del visor embebido, donde Web Share
  // está bloqueado por el navegador.
  return saveGeneratedFileToDevice({
    filename,
    mime,
    content,
    shareTitle,
    shareText,
  });
}

