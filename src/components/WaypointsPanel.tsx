/**
 * Panel de Waypoints guardados (chinchetas fijas). Permite:
 *  - Activar el modo "Añadir waypoint" (siguiente clic en el mapa crea uno).
 *  - Guardar la posición GPS actual como waypoint.
 *  - Listar, renombrar, navegar (Ir) y borrar waypoints existentes.
 *  - Iniciar / cerrar sesión para sincronizar en la nube.
 */
import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import type { SavedWaypoint } from "../hooks/use-saved-waypoints";
import { toDegMinSec } from "./FishingHotspots.types";
import { supabase } from "../integrations/supabase/client";
import {
  exportWaypointsGpx,
  pickAndParseWaypointsFile,
  shareWaypointsGpx,
} from "../lib/waypoints-io";

interface WaypointsPanelProps {
  waypoints: SavedWaypoint[];
  addMode: boolean;
  onToggleAddMode?: () => void;
  onAddAtGps: (() => void) | null;
  onFlyTo: (w: SavedWaypoint) => void;
  onNavigate?: (w: SavedWaypoint) => void;
  onRename: (id: string, name: string) => void;
  onRemove: (id: string) => void;
  onBulkImport?: (
    items: Array<{ lat: number; lng: number; name: string; depth: number | null; reason: string }>,
  ) => Promise<number> | number;
  onClearAll?: () => void;
  cloudMode?: boolean;
}

export function WaypointsPanel({
  waypoints,
  addMode,
  onToggleAddMode,
  onAddAtGps,
  onFlyTo,
  onNavigate,
  onRename,
  onRemove,
  onBulkImport,
  onClearAll,
  cloudMode = false,
}: WaypointsPanelProps) {
  const [userEmail, setUserEmail] = useState<string | null>(null);
  const [busy, setBusy] = useState<null | "import" | "save" | "share" | "manual">(null);
  // ── Alta manual por coordenadas GMS ──
  const [manualOpen, setManualOpen] = useState(false);
  const [manualError, setManualError] = useState<string | null>(null);
  const [mf, setMf] = useState({
    latD: "",
    latM: "",
    latS: "",
    latH: "N",
    lngD: "",
    lngM: "",
    lngS: "",
    lngH: "E",
    name: "",
  });

  const num = (v: string) => Number(String(v).trim().replace(/,/g, "."));

  const parsedManualCoordinates = (() => {
    const latDegreesText = mf.latD.trim();
    const lngDegreesText = mf.lngD.trim();
    if (!latDegreesText || !lngDegreesText) return null;
    const latD = num(latDegreesText);
    const latM = num(mf.latM.trim() || "0");
    const latS = num(mf.latS.trim() || "0");
    const lngD = num(lngDegreesText);
    const lngM = num(mf.lngM.trim() || "0");
    const lngS = num(mf.lngS.trim() || "0");
    const values = [latD, latM, latS, lngD, lngM, lngS];
    if (values.some((value) => !Number.isFinite(value) || value < 0)) return null;
    if (latD > 90 || lngD > 180 || latM >= 60 || lngM >= 60 || latS >= 60 || lngS >= 60) {
      return null;
    }
    let lat = latD + latM / 60 + latS / 3600;
    let lng = lngD + lngM / 60 + lngS / 3600;
    if (mf.latH === "S") lat = -lat;
    if (mf.lngH === "O" || mf.lngH === "W") lng = -lng;
    if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
    // Evita residuos binarios del cálculo GMS sin reducir la precisión GPS.
    return {
      lat: Math.round(lat * 1e12) / 1e12,
      lng: Math.round(lng * 1e12) / 1e12,
    };
  })();

  const handleManualSave = async () => {
    setManualError(null);
    const latDegreesText = mf.latD.trim();
    const lngDegreesText = mf.lngD.trim();
    if (!latDegreesText || !lngDegreesText) {
      setManualError("Introduce los grados de latitud y longitud.");
      return;
    }
    const latD = num(latDegreesText);
    const latM = num(mf.latM || "0");
    const latS = num(mf.latS || "0");
    const lngD = num(lngDegreesText);
    const lngM = num(mf.lngM || "0");
    const lngS = num(mf.lngS || "0");
    const vals = [latD, latM, latS, lngD, lngM, lngS];
    if (vals.some((v) => !Number.isFinite(v) || v < 0)) {
      setManualError("Introduce valores numéricos válidos.");
      return;
    }
    if (latD > 90 || lngD > 180) {
      setManualError("Grados fuera de rango (lat ≤ 90, lon ≤ 180).");
      return;
    }
    if ([latM, lngM].some((v) => v >= 60) || [latS, lngS].some((v) => v >= 60)) {
      setManualError("Minutos y segundos deben estar entre 0 y 59,999.");
      return;
    }
    let lat = latD + latM / 60 + latS / 3600;
    let lng = lngD + lngM / 60 + lngS / 3600;
    if (mf.latH === "S") lat = -lat;
    if (mf.lngH === "O" || mf.lngH === "W") lng = -lng;
    if (lat > 90 || lat < -90 || lng > 180 || lng < -180) {
      setManualError("Coordenadas fuera de rango.");
      return;
    }
    lat = Math.round(lat * 1e12) / 1e12;
    lng = Math.round(lng * 1e12) / 1e12;
    const name = mf.name.trim() || `WP ${toDegMinSec(lat, "lat")} ${toDegMinSec(lng, "lng")}`;
    if (!onBulkImport) {
      setManualError("No se puede guardar en este momento. Recarga la aplicación.");
      return;
    }
    // Si ya existe un waypoint prácticamente en esas coordenadas (≈30 m),
    // no es un error: lo mostramos en el mapa directamente.
    const existing = waypoints.find(
      (w) => Math.abs(w.lat - lat) < 3e-4 && Math.abs(w.lng - lng) < 3e-4,
    );
    if (existing) {
      setManualOpen(false);
      setMf((s) => ({ ...s, latD: "", latM: "", latS: "", lngD: "", lngM: "", lngS: "", name: "" }));
      onFlyTo(existing);
      return;
    }
    setBusy("manual");
    try {
      const added = await onBulkImport([{ lat, lng, name, depth: null, reason: "Coordenadas manuales" }]);
      if (!added) {
        setManualError("No se pudo guardar el waypoint. Inténtalo de nuevo.");
        return;
      }

      setMf((s) => ({ ...s, latD: "", latM: "", latS: "", lngD: "", lngM: "", lngS: "", name: "" }));
      setManualOpen(false);
      onFlyTo({
        id: "manual",
        lat,
        lng,
        name,
        score: 0,
        depth: null,
        reason: "Coordenadas manuales",
        savedAt: Date.now(),
      });
    } catch (error) {
      console.error("Error al guardar coordenadas manuales", error);
      setManualError(
        error instanceof Error && error.message
          ? `No se pudo guardar: ${error.message}`
          : "No se pudo guardar el waypoint. Inténtalo de nuevo.",
      );

    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setUserEmail(data.session?.user.email ?? null);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      setUserEmail(session?.user.email ?? null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const handleShare = async () => {
    if (waypoints.length === 0) {
      alert("No hay waypoints para exportar.");
      return;
    }
    setBusy("share");
    try {
      const result = await shareWaypointsGpx(waypoints);
      if (result === "failed") {
        alert("No se pudo compartir ni descargar el archivo GPX.");
      } else if (result === "downloaded") {
        alert("Este navegador no permite compartir archivos. El GPX se ha descargado en su lugar.");
      }
    } catch (error) {
      console.error("Error al compartir GPX", error);
      alert("No se pudo abrir el menú Compartir. Cierra cualquier ventana abierta e inténtalo de nuevo.");
    } finally {
      setBusy(null);
    }
  };

  const handleSave = async () => {
    if (waypoints.length === 0) {
      alert("No hay waypoints para guardar.");
      return;
    }
    setBusy("save");
    try {
      const result = await exportWaypointsGpx(waypoints);
      if (result === "downloaded") alert("GPX guardado. Búscalo en Archivos o Descargas.");
      else if (result !== "cancelled") alert("No se pudo guardar el archivo GPX.");
    } catch (error) {
      console.error("Error al guardar GPX", error);
      alert("No se pudo abrir el selector de Archivos. Cierra cualquier ventana abierta e inténtalo de nuevo.");
    } finally {
      setBusy(null);
    }
  };

  const handleImport = async () => {
    if (!onBulkImport) return;
    setBusy("import");
    try {
      const items = await pickAndParseWaypointsFile();
      if (items === null) return; // cancelado por el usuario
      if (items.length === 0) {
        alert("No se han encontrado waypoints en el archivo.");
        return;
      }
      const added = await onBulkImport(items);
      alert(
        `Importados ${added} waypoint(s).` +
          (added < items.length ? ` ${items.length - added} duplicado(s) omitido(s).` : ""),
      );
    } catch (error) {
      console.error("Error al importar GPX/KML", error);
      alert("No se pudo leer el archivo. Selecciona un GPX o KML guardado en Archivos.");
    } finally {
      setBusy(null);
    }
  };


  return (
    <div className="rounded-lg border border-border bg-card/40 p-1.5">
      <div className="mb-1.5 flex items-center gap-1.5">
        <span className="text-xs">📌</span>
        <span className="flex-1 text-[10px] font-semibold text-foreground">Waypoints fijos</span>
        <span className="text-[9px] tabular-nums text-muted-foreground">{waypoints.length}</span>
      </div>

      <div className="mb-1.5 flex items-center justify-between gap-1.5 rounded-md border border-border/60 bg-background/40 px-1.5 py-0.5">
        {cloudMode && userEmail ? (
          <>
            <span className="flex items-center gap-1 truncate text-[9px] text-foreground">
              <span>☁️</span>
              <span className="truncate">{userEmail}</span>
            </span>
            <button
              type="button"
              onClick={() => {
                void supabase.auth.signOut();
              }}
              className="rounded border border-border bg-secondary/60 px-1 py-0.5 text-[9px] text-foreground hover:bg-secondary"
            >
              Salir
            </button>
          </>
        ) : (
          <>
            <span className="flex items-center gap-1 text-[9px] text-muted-foreground">
              <span>💾</span>
              <span>Solo en este dispositivo</span>
            </span>
            <Link
              to="/auth"
              className="rounded border border-primary/60 bg-primary/10 px-1 py-0.5 text-[9px] font-semibold text-primary hover:bg-primary/20"
            >
              Sincronizar
            </Link>
          </>
        )}
      </div>

      <div className="mb-1.5 flex flex-col gap-1">
        {onToggleAddMode && (
          <button
            type="button"
            onClick={onToggleAddMode}
            className={`w-full rounded-md border px-1.5 py-1 text-[10px] font-semibold transition-colors ${
              addMode
                ? "border-red-400/70 bg-red-500/20 text-red-100"
                : "border-red-400/60 bg-red-500/10 text-red-100 hover:bg-red-500/20"
            }`}
            title="Activa el modo y toca el mapa donde quieras fijar el waypoint"
          >
            {addMode ? "✖ Cancelar (toca el mapa o aquí)" : "📌 Añadir waypoint (tocando el mapa)"}
          </button>
        )}

        {onAddAtGps && (
          <button
            type="button"
            onClick={onAddAtGps}
            className="w-full rounded-md border border-cyan-400/60 bg-cyan-500/10 px-1.5 py-1 text-[10px] font-semibold text-cyan-100 hover:bg-cyan-500/20"
            title="Crea un waypoint en tu posición GPS actual"
          >
            📍 Guardar mi posición GPS
          </button>
        )}

        {onBulkImport && (
          <button
            type="button"
            onClick={() => setManualOpen((v) => !v)}
            className="w-full rounded-md border border-violet-400/60 bg-violet-500/10 px-1.5 py-1 text-[10px] font-semibold text-violet-100 hover:bg-violet-500/20"
            title="Crear un waypoint escribiendo las coordenadas en grados, minutos y segundos"
          >
            {manualOpen ? "✖ Cerrar coordenadas" : "🎯 Introducir coordenadas (GMS)"}
          </button>
        )}

        {manualOpen && onBulkImport && (
          <div className="rounded-md border border-violet-400/40 bg-background/50 p-1.5">
            <p className="mb-1 text-[9px] leading-tight text-muted-foreground">
              Ejemplo: 40°00′00″ N, 003°18′40,9″ E
            </p>
            <div className="mb-1">
              <span className="text-[9px] font-semibold text-foreground">Latitud</span>
              <div className="mt-0.5 flex items-center gap-1">
                <input
                   aria-label="Grados de latitud"
                  inputMode="decimal"
                   autoComplete="off"
                  value={mf.latD}
                  onChange={(e) => setMf((s) => ({ ...s, latD: e.target.value }))}
                  placeholder="40"
                   className="w-[3.25rem] min-w-0 rounded border border-border bg-background/70 px-1 py-0.5 text-[10px] text-foreground"
                />
                <span className="text-[9px] text-muted-foreground">°</span>
                <input
                   aria-label="Minutos de latitud"
                  inputMode="decimal"
                   autoComplete="off"
                  value={mf.latM}
                  onChange={(e) => setMf((s) => ({ ...s, latM: e.target.value }))}
                  placeholder="00"
                   className="w-[3.25rem] min-w-0 rounded border border-border bg-background/70 px-1 py-0.5 text-[10px] text-foreground"
                />
                <span className="text-[9px] text-muted-foreground">′</span>
                <input
                   aria-label="Segundos de latitud"
                  inputMode="decimal"
                   autoComplete="off"
                  value={mf.latS}
                  onChange={(e) => setMf((s) => ({ ...s, latS: e.target.value }))}
                  placeholder="00,0"
                   className="w-[4rem] min-w-0 rounded border border-border bg-background/70 px-1 py-0.5 text-[10px] text-foreground"
                />
                <span className="text-[9px] text-muted-foreground">″</span>
                <select
                  value={mf.latH}
                  onChange={(e) => setMf((s) => ({ ...s, latH: e.target.value }))}
                  className="rounded border border-border bg-background/70 px-1 py-0.5 text-[10px] text-foreground"
                >
                  <option value="N">N</option>
                  <option value="S">S</option>
                </select>
              </div>
            </div>
            <div className="mb-1">
              <span className="text-[9px] font-semibold text-foreground">Longitud</span>
              <div className="mt-0.5 flex items-center gap-1">
                <input
                   aria-label="Grados de longitud"
                  inputMode="decimal"
                   autoComplete="off"
                  value={mf.lngD}
                  onChange={(e) => setMf((s) => ({ ...s, lngD: e.target.value }))}
                  placeholder="003"
                   className="w-[3.25rem] min-w-0 rounded border border-border bg-background/70 px-1 py-0.5 text-[10px] text-foreground"
                />
                <span className="text-[9px] text-muted-foreground">°</span>
                <input
                   aria-label="Minutos de longitud"
                  inputMode="decimal"
                   autoComplete="off"
                  value={mf.lngM}
                  onChange={(e) => setMf((s) => ({ ...s, lngM: e.target.value }))}
                  placeholder="18"
                   className="w-[3.25rem] min-w-0 rounded border border-border bg-background/70 px-1 py-0.5 text-[10px] text-foreground"
                />
                <span className="text-[9px] text-muted-foreground">′</span>
                <input
                   aria-label="Segundos de longitud"
                  inputMode="decimal"
                   autoComplete="off"
                  value={mf.lngS}
                  onChange={(e) => setMf((s) => ({ ...s, lngS: e.target.value }))}
                  placeholder="40,9"
                   className="w-[4rem] min-w-0 rounded border border-border bg-background/70 px-1 py-0.5 text-[10px] text-foreground"
                />
                <span className="text-[9px] text-muted-foreground">″</span>
                <select
                  value={mf.lngH}
                  onChange={(e) => setMf((s) => ({ ...s, lngH: e.target.value }))}
                  className="rounded border border-border bg-background/70 px-1 py-0.5 text-[10px] text-foreground"
                >
                  <option value="E">E</option>
                  <option value="O">O</option>
                </select>
              </div>
            </div>
            <input
              aria-label="Nombre del waypoint"
              value={mf.name}
              maxLength={60}
              onChange={(e) => setMf((s) => ({ ...s, name: e.target.value }))}
              placeholder="Nombre del waypoint"
              className="mb-1 w-full rounded border border-border bg-background/70 px-1.5 py-0.5 text-[10px] text-foreground"
            />
            {parsedManualCoordinates && (
              <div className="mb-1 rounded border border-emerald-400/40 bg-emerald-500/10 px-1.5 py-1 text-[9px] leading-snug text-emerald-100">
                <div className="font-semibold">Se guardará exactamente en:</div>
                <div className="font-mono">
                  {toDegMinSec(parsedManualCoordinates.lat, "lat")} · {toDegMinSec(parsedManualCoordinates.lng, "lng")}
                </div>
                <div className="font-mono text-emerald-100/75">
                  {parsedManualCoordinates.lat.toFixed(7)}, {parsedManualCoordinates.lng.toFixed(7)}
                </div>
              </div>
            )}
            {manualError && (
              <p className="mb-1 rounded border border-red-400/40 bg-red-500/10 px-1.5 py-0.5 text-[9px] text-red-100">
                {manualError}
              </p>
            )}
            <button
              type="button"
              onClick={() => void handleManualSave()}
              disabled={busy !== null}
              className="w-full rounded-md border border-violet-400/60 bg-violet-500/20 px-1.5 py-1 text-[10px] font-semibold text-violet-50 hover:bg-violet-500/30 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy === "manual" ? "⏳ Guardando…" : "💾 Guardar y mostrar en el mapa"}
            </button>
          </div>
        )}



        <div className="grid grid-cols-2 gap-1">
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={busy !== null || waypoints.length === 0}
            className="rounded-md border border-emerald-400/60 bg-emerald-500/10 px-1.5 py-1 text-[10px] font-semibold text-emerald-100 hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40"
            title="Guardar todos los waypoints como archivo GPX"
          >
            {busy === "save" ? "⏳ Guardando…" : "⬇ Guardar GPX"}
          </button>
          <button
            type="button"
            onClick={() => void handleShare()}
            disabled={busy !== null || waypoints.length === 0}
            className="rounded-md border border-emerald-400/60 bg-emerald-500/10 px-1.5 py-1 text-[10px] font-semibold text-emerald-100 hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-40"
            title="Compartir un archivo GPX con todos los waypoints"
          >
            {busy === "share" ? "⏳ Abriendo…" : "📤 Compartir GPX"}
          </button>
        </div>
        <div className="grid grid-cols-1 gap-1">
          {onBulkImport && (
            <button
              type="button"
              onClick={handleImport}
              disabled={busy !== null}
              className="rounded-md border border-sky-400/60 bg-sky-500/10 px-1.5 py-1 text-[10px] font-semibold text-sky-100 hover:bg-sky-500/20 disabled:cursor-not-allowed disabled:opacity-40"
              title="Importar waypoints desde un archivo GPX o KML"
            >
              {busy === "import" ? "⏳ Importando…" : "⬆️ Importar GPX"}
            </button>
          )}
        </div>

        {onClearAll && waypoints.length > 0 && (
          <button
            type="button"
            onClick={() => {
              if (window.confirm(`¿Borrar los ${waypoints.length} waypoints? Esta acción no se puede deshacer.`))
                onClearAll();
            }}
            className="w-full rounded-md border border-red-500/40 bg-red-500/5 px-1.5 py-0.5 text-[9px] font-semibold text-red-200 hover:bg-red-500/15"
          >
            🗑 Borrar todos
          </button>
        )}
      </div>


      {addMode && (
        <p className="mb-1.5 rounded border border-red-400/40 bg-red-500/10 px-1.5 py-0.5 text-[9px] leading-tight text-red-100">
          Toca cualquier punto del mapa para fijar el waypoint.
        </p>
      )}

      {waypoints.length === 0 ? (
        <p className="rounded bg-background/40 px-1.5 py-1.5 text-[9px] leading-tight text-muted-foreground">
          Aún no hay waypoints. Toca un Spot de pesca y pulsa “Guardar como waypoint”, o usa los
          botones de arriba.
        </p>
      ) : (
        <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto pr-0.5">
          {waypoints.map((w) => (
            <li key={w.id} className="rounded-md border border-border/60 bg-background/40 p-1">
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => onFlyTo(w)}
                  className="flex-1 truncate text-left text-[10px] font-semibold text-foreground hover:underline"
                  title="Ir al waypoint"
                >
                  📌 {w.name}
                </button>
                {onNavigate && (
                  <button
                    type="button"
                    onClick={() => onNavigate(w)}
                    className="rounded border border-amber-400/60 bg-amber-500/15 px-1 text-[9px] text-amber-100 hover:bg-amber-500/25"
                    title="Navegar hasta este waypoint"
                  >
                    🧭
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    const n = window.prompt("Nuevo nombre:", w.name);
                    if (n && n.trim()) onRename(w.id, n.trim());
                  }}
                  className="rounded border border-border bg-secondary/60 px-1 text-[9px] text-foreground hover:bg-secondary"
                  title="Renombrar"
                >
                  ✏️
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm(`¿Borrar "${w.name}"?`)) onRemove(w.id);
                  }}
                  className="rounded border border-red-500/40 bg-red-500/10 px-1 text-[9px] text-red-200 hover:bg-red-500/20"
                  title="Borrar"
                >
                  🗑
                </button>
              </div>
              <div className="mt-0.5 font-mono text-[8px] leading-tight text-muted-foreground">
                {toDegMinSec(w.lat, "lat")} · {toDegMinSec(w.lng, "lng")}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

