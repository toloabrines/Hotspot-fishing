/**
 * Compartir enlaces usando siempre el sistema del dispositivo.
 *
 * Orden de intentos:
 *  1. Hoja de compartir nativa (Capacitor Share en iOS/Android).
 *  2. Web Share API del navegador (Safari/Chrome móvil).
 *  3. Portapapeles (async y fallback con textarea).
 *  4. Abrir el enlace en una pestaña para copiarlo a mano.
 */
import { Capacitor } from "@capacitor/core";
import { Share } from "@capacitor/share";

/** Origen público de la app: se usa cuando `window.location.origin` no es http(s). */
export const APP_PUBLIC_ORIGIN = "https://hotspot-fishing.lovable.app";

/**
 * Devuelve un origen válido para construir enlaces compartibles.
 * En la app nativa `window.location.origin` es `capacitor://localhost`,
 * que no sirve como enlace: en ese caso usamos el dominio público.
 */
export function shareableOrigin(): string {
  if (typeof window === "undefined" || !window.location) return APP_PUBLIC_ORIGIN;
  const origin = window.location.origin;
  if (/^https?:\/\//i.test(origin) && !/^https?:\/\/localhost(:\d+)?$/i.test(origin)) {
    return origin.replace(/\/+$/, "");
  }
  return APP_PUBLIC_ORIGIN;
}

/** Construye una URL absoluta compartible a partir de una ruta (+ hash opcional). */
export function buildShareUrl(path: string, hash?: string): string {
  const clean = path.startsWith("/") ? path : `/${path}`;
  const suffix = hash ? (hash.startsWith("#") ? hash : `#${hash}`) : "";
  return `${shareableOrigin()}${clean}${suffix}`;
}

export type ShareLinkResult = "shared" | "copied" | "opened" | "cancelled";

export interface ShareLinkOptions {
  url: string;
  title?: string;
  text?: string;
  dialogTitle?: string;
}

function isCancel(err: unknown): boolean {
  const v = err as { name?: string; message?: string };
  return (
    v?.name === "AbortError" ||
    /abort|cancel|cancelado|dismiss/i.test(String(v?.message ?? err))
  );
}

async function copyToClipboard(url: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(url);
      return true;
    }
  } catch {
    /* seguimos con el fallback manual */
  }
  try {
    if (typeof document === "undefined") return false;
    const ta = document.createElement("textarea");
    ta.value = url;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** Diálogo de último recurso: muestra el enlace para copiarlo/abrirlo a mano. */
function showLinkDialog(url: string, title?: string): void {
  if (typeof document === "undefined") return;
  const prev = document.getElementById("hf-share-link-dialog");
  if (prev) prev.remove();
  const wrap = document.createElement("div");
  wrap.id = "hf-share-link-dialog";
  wrap.style.cssText =
    "position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:16px;";
  const card = document.createElement("div");
  card.style.cssText =
    "background:#fff;color:#111;border-radius:12px;max-width:420px;width:100%;padding:16px;font:14px system-ui,sans-serif;box-shadow:0 10px 40px rgba(0,0,0,.3);";
  card.innerHTML = `
    <div style="font-weight:700;margin-bottom:8px;">${title ?? "Compartir enlace"}</div>
    <input readonly value="${url.replace(/"/g, "&quot;")}" style="width:100%;box-sizing:border-box;padding:8px;border:1px solid #ccc;border-radius:8px;font-size:12px;" />
    <div style="display:flex;gap:8px;margin-top:12px;">
      <button data-act="copy" style="flex:1;padding:9px;border:0;border-radius:8px;background:#2563eb;color:#fff;font-weight:700;">Copiar</button>
      <button data-act="open" style="flex:1;padding:9px;border:1px solid #ccc;border-radius:8px;background:#f3f4f6;font-weight:700;">Abrir</button>
      <button data-act="close" style="padding:9px 12px;border:1px solid #ccc;border-radius:8px;background:#fff;">Cerrar</button>
    </div>`;
  wrap.appendChild(card);
  const close = () => wrap.remove();
  wrap.addEventListener("click", (e) => {
    if (e.target === wrap) close();
  });
  card.querySelector<HTMLInputElement>("input")?.addEventListener("focus", (e) => {
    (e.target as HTMLInputElement).select();
  });
  card.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
    b.addEventListener("click", async () => {
      const act = b.dataset.act;
      if (act === "copy") {
        const ok = await copyToClipboard(url);
        b.textContent = ok ? "¡Copiado!" : "No se pudo copiar";
        return;
      }
      if (act === "open") {
        window.open(url, "_blank", "noopener");
        return;
      }
      close();
    });
  });
  document.body.appendChild(wrap);
}

/**
 * Mismo flujo que los waypoints (que sí funciona): en la app nativa se llama
 * SIEMPRE primero a la hoja nativa de Capacitor (import estático, sin perder
 * la activación del usuario); en web se usa Web Share y luego portapapeles.
 */
export async function shareLink({
  url,
  title,
  text,
  dialogTitle,
}: ShareLinkOptions): Promise<ShareLinkResult> {
  // 1) Hoja de compartir nativa (iOS/Android con Capacitor) — igual que waypoints.
  if (Capacitor.isNativePlatform()) {
    try {
      await Share.share({ title, text, url, dialogTitle: dialogTitle ?? title });
      return "shared";
    } catch (err) {
      if (isCancel(err)) return "cancelled";
      console.warn("Compartir nativo falló; usando fallback.", err);
    }
  }

  // 2) Web Share API del navegador.
  if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
    const data: ShareData = { url, ...(title ? { title } : {}), ...(text ? { text } : {}) };
    const canShare = (navigator as Navigator & { canShare?: (d: ShareData) => boolean }).canShare;
    if (!canShare || canShare.call(navigator, data)) {
      try {
        await navigator.share(data);
        return "shared";
      } catch (err) {
        if (isCancel(err)) return "cancelled";
        /* NotAllowedError u otro: seguimos con los siguientes intentos */
      }
    }
  }

  // 3) Portapapeles.
  if (await copyToClipboard(url)) {
    return "copied";
  }

  // 4) Diálogo con el enlace visible (nunca dejamos al usuario sin nada).
  showLinkDialog(url, dialogTitle ?? title);
  return "opened";
}


