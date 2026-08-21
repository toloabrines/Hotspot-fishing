/**
 * CONTENIDO DE LA GUÍA DE LA APLICACIÓN
 * =====================================
 *
 * Fuente ÚNICA del manual de usuario. La página `/guia` sólo renderiza estos
 * datos: buscador, índice e impresión salen de aquí.
 *
 * REGLA DE MANTENIMIENTO (obligatoria):
 * cada vez que se añada, cambie o elimine una función de Hotspot Fishing hay
 * que actualizar en el MISMO cambio:
 *   1. la sección correspondiente de este archivo,
 *   2. el glosario si aparece un término nuevo,
 *   3. una entrada nueva en `CHANGELOG` (fecha, versión, tipo de cambio).
 * Los pesos de los algoritmos NO se escriben a mano: se importan de
 * `scoring-weights.ts`, de modo que la guía nunca puede quedar desfasada
 * respecto al motor real.
 */

import {
  BOTTOM_BLOCK_WEIGHTS,
  SURFACE_BLOCK_WEIGHTS,
  SQUID_WEIGHTS,
  DRIFT_WEIGHTS,
  MIX_WEIGHTS,
  FSLE_WEIGHT_BY_MODE,
  FACTOR_LABELS,
} from "./scoring-weights";

// ─────────────────────────── Modelo de contenido ───────────────────────────

export interface TableBlock {
  kind: "table";
  head: string[];
  rows: string[][];
  caption?: string;
}
export interface TextBlock {
  kind: "text";
  text: string;
}
export interface ListBlock {
  kind: "list";
  ordered?: boolean;
  items: string[];
  title?: string;
}
export interface NoteBlock {
  kind: "note";
  tone: "info" | "warn" | "tip";
  title?: string;
  text: string;
}
export interface DiagramBlock {
  kind: "diagram";
  title: string;
  /** Esquema ASCII (se renderiza en monoespaciada). */
  art: string;
  legend?: string;
}
export interface FaqBlock {
  kind: "faq";
  items: { q: string; a: string }[];
}
export interface SubBlock {
  kind: "sub";
  title: string;
  blocks: Block[];
}

export type Block =
  | TextBlock
  | ListBlock
  | TableBlock
  | NoteBlock
  | DiagramBlock
  | FaqBlock
  | SubBlock;

export interface GuideSection {
  id: string;
  number: number;
  title: string;
  icon: string;
  summary: string;
  blocks: Block[];
}

// ───────────────────────── Utilidades de pesos ─────────────────────────────

const pct = (v: number) => `${Math.round(v * 1000) / 10} %`;
const label = (k: string) => FACTOR_LABELS[k] ?? k;

function weightRows(w: Record<string, number>): string[][] {
  return Object.entries(w)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => [label(k), k, pct(v)]);
}

const WEIGHT_HEAD = ["Variable", "Clave interna", "Peso"];

// ───────────────────────────── Secciones ───────────────────────────────────

const s0: GuideSection = {
  id: "primeros-pasos",
  number: 1,
  title: "Empezar: paso a paso pulsando",
  icon: "🚦",
  summary:
    "Instrucciones literales, botón por botón: qué abrir, qué pulsar y cuándo volver atrás, para cada modo de pesca.",
  blocks: [
    {
      kind: "note",
      tone: "tip",
      title: "Lee esto primero",
      text: "Cada paso es una acción real en pantalla. «Menú» es el botón ☰ arriba a la izquierda del mapa. «Volver» significa cerrar el panel con la ✕ o tocando fuera, y quedarte otra vez en el mapa.",
    },
    {
      kind: "sub",
      title: "Antes de cualquier modo (una sola vez)",
      blocks: [
        {
          kind: "list",
          ordered: true,
          items: [
            "Abre la app: entras directamente en el mapa.",
            "Pulsa el botón de GPS (icono de diana, columna derecha del mapa) y acepta el permiso de ubicación. Tu barco aparece como triángulo azul.",
            "Pulsa ☰ Menú (arriba a la izquierda).",
            "En el menú, despliega «Fecha» y deja HOY seleccionado.",
            "Pulsa ✕ para cerrar el menú y volver al mapa.",
            "Mueve el mapa y haz zoom hasta ver SOLO la zona a la que vas a salir hoy (unas 10–20 millas). Todo el cálculo se hace sobre lo que ves.",
          ],
        },
      ],
    },
    {
      kind: "sub",
      title: "Modo Fondo · paso a paso",
      blocks: [
        {
          kind: "list",
          ordered: true,
          items: [
            "Pulsa ☰ Menú.",
            "Despliega «Modo de pesca» y pulsa «Pesca de fondo».",
            "Despliega «Capas» y activa «Fondo marino» (relieve + isóbatas).",
            "En la misma sección, activa «T del fondo + corrientes».",
            "En el selector de profundidad de corrientes, pulsa «Fondo».",
            "Pulsa ✕ para volver al mapa.",
            "Centra el mapa sobre el veril o bajo que te interesa.",
            "Pulsa el botón «Área de búsqueda» (icono de triángulo/polígono) y toca 3 o 4 puntos en el mapa alrededor de esa zona; pulsa «Cerrar área».",
            "Pulsa «Calcular hotspots» y espera a que el indicador deje de girar.",
            "Toca el marcador «1» (Top 1): se abre la ficha con profundidad, pendiente, temperatura y corriente de fondo.",
            "Dentro de la ficha, pulsa «Guardar waypoint» y ponle nombre.",
            "Pulsa ✕ para volver al mapa.",
            "Opcional: pulsa «Vista 3D» para ver el relieve del punto antes de salir.",
            "Para llevarlo al plotter: ☰ Menú ▸ «Waypoints» ▸ «Exportar GPX» ▸ «Guardar en Archivos».",
          ],
        },
      ],
    },
    {
      kind: "sub",
      title: "Modo Deriva / Fluixa · paso a paso",
      blocks: [
        {
          kind: "list",
          ordered: true,
          items: [
            "Pulsa ☰ Menú.",
            "Despliega «Modo de pesca» y pulsa «Pesca a la deriva (Fluixa)».",
            "Comprueba en el panel de condiciones el viento y la ola: si la ola pasa de 1,2 m, no salgas a fluixa.",
            "Pulsa ✕ para volver al mapa.",
            "Haz zoom sobre la bahía o tramo de costa concreto (zoom de bahía, no de isla entera).",
            "Pulsa «Área de búsqueda» y marca 3 o 4 vértices alrededor de la bahía; pulsa «Cerrar área».",
            "Pulsa «Frentes productivos» ▸ «Calcular».",
            "Espera: aparecen líneas naranjas numeradas (FRENTE 1, 2, 3) y círculos pequeños de entrada.",
            "REGLA: navega hasta el círculo, pesca la LÍNEA naranja. El círculo no es el objetivo.",
            "En la tarjeta del frente pulsa «Línea del frente» si quieres el corredor con más detalle, o «Punto exacto» para el mejor punto concreto.",
            "Pulsa «Exportar PDF» o «Compartir enlace» para llevarlo o mandarlo al resto del barco.",
            "Pulsa ✕ para volver al mapa y salir a pescar: colócate a barlovento del inicio de la línea y déjate caer siguiéndola.",
          ],
        },
      ],
    },
    {
      kind: "sub",
      title: "Modo Calamar · paso a paso",
      blocks: [
        {
          kind: "list",
          ordered: true,
          items: [
            "Pulsa ☰ Menú.",
            "Despliega «Modo de pesca» y pulsa «Calamar».",
            "Despliega «Sol y luna» y mira la hora del ocaso: la mejor franja es ±90 minutos alrededor.",
            "Despliega «Capas» y activa «T del fondo + corrientes».",
            "Pulsa ✕ para volver al mapa.",
            "Haz zoom sobre la franja costera de 30–80 m (usa las isóbatas como referencia).",
            "Pulsa «Área de búsqueda», marca la zona y pulsa «Cerrar área».",
            "Pulsa «Calcular hotspots».",
            "Toca el marcador «1» y comprueba en la ficha que la temperatura de fondo está entre 13 y 16 °C y la corriente es floja.",
            "Pulsa «Guardar waypoint» y luego ✕ para volver al mapa.",
          ],
        },
      ],
    },
    {
      kind: "sub",
      title: "Modo Altura / Superficie · paso a paso",
      blocks: [
        {
          kind: "list",
          ordered: true,
          items: [
            "Pulsa ☰ Menú.",
            "Despliega «Modo de pesca» y pulsa «Pesca de altura».",
            "Despliega «Capas» y activa «Temperatura (SST)».",
            "Activa también «Clorofila» y «FSLE».",
            "Baja la opacidad de la capa de arriba al 50 % para ver dónde se cruzan.",
            "Pulsa ✕ para volver al mapa.",
            "Encuadra la zona de altura a la que puedes llegar (puede ser amplia).",
            "Pulsa «Área de búsqueda», marca la zona y pulsa «Cerrar área».",
            "Pulsa «Calcular hotspots».",
            "Toca el marcador «1»: te interesa que el frente sea una LÍNEA larga, no un punto suelto.",
            "Cambia la fecha a ayer y anteayer (☰ Menú ▸ Fecha) para comprobar que el frente lleva días en el mismo sitio.",
            "Vuelve a HOY, guarda el waypoint y exporta el GPX al plotter.",
          ],
        },
      ],
    },
    {
      kind: "note",
      tone: "warn",
      title: "Si algo no aparece",
      text: "Si al pulsar «Calcular hotspots» no sale nada: comprueba que has cerrado el área de búsqueda, que la fecha es de hoy y que el zoom no abarca toda Baleares. Si una capa sale en blanco, espera unos segundos: se está descargando el satélite.",
    },
  ],
};

const s1: GuideSection = {
  id: "introduccion",
  number: 2,
  title: "Introducción",
  icon: "📘",
  summary: "Qué es Hotspot Fishing, para qué sirve y cómo se leen sus resultados.",
  blocks: [
    {
      kind: "text",
      text: "Hotspot Fishing es un visor oceanográfico para pesca deportiva y profesional en el Mediterráneo, con foco en Baleares. Descarga datos de satélite y de modelos numéricos, los combina en un mapa y los convierte en una puntuación (Score 0–100) que indica dónde hay más probabilidad de encontrar pescado en las próximas horas.",
    },
    {
      kind: "text",
      text: "No es un sonar ni un detector de peces: es un modelo de probabilidad. Trabaja sobre la física del mar (temperatura, corrientes, frentes, relieve del fondo) porque el pescado se concentra donde esa física crea comida y refugio.",
    },
    {
      kind: "list",
      title: "Para qué sirve",
      items: [
        "Decidir a qué zona salir antes de encender el motor, ahorrando combustible y horas.",
        "Localizar frentes térmicos, bordes de clorofila y líneas de convergencia (FSLE) donde se acumula la cadena trófica.",
        "Leer el relieve del fondo (veriles, bajos, cañones, mesetas) sin sonda y planificar arrastres o fondeos.",
        "Guardar, exportar y compartir puntos, tracks y frentes con el plotter o con otros pescadores.",
      ],
    },
    {
      kind: "list",
      title: "Modalidades soportadas",
      items: [
        "Pesca de fondo (demersales: dentón, mero, pargo, cabracho…).",
        "Pesca de calamar / cefalópodos (potera).",
        "Pesca de superficie y altura (pelágicos: llampuga, atún, bonito, emperador).",
        "Pesca a la deriva o «fluixa» (bahías y franja costera: anjova, sirvia, palometón, lubina).",
      ],
    },
    {
      kind: "sub",
      title: "Cómo se interpretan los resultados",
      blocks: [
        {
          kind: "table",
          head: ["Score", "Lectura", "Qué hacer"],
          rows: [
            ["80–100", "Excelente: varias capas coinciden en el mismo punto", "Zona prioritaria del día"],
            ["60–79", "Buena: señal clara pero con alguna variable floja", "Plan A o plan B según distancia"],
            ["40–59", "Media: sólo una o dos variables acompañan", "Zona de paso o de reserva"],
            ["20–39", "Floja: condiciones poco favorables", "Sólo si hay conocimiento local"],
            ["0–19", "Descartada por el motor", "No merece el viaje"],
          ],
        },
        {
          kind: "note",
          tone: "warn",
          title: "El Score es relativo al modo",
          text: "Un 85 en modo Fondo y un 85 en modo Superficie no significan lo mismo: cada modo usa su propio motor, sus propias variables y sus propios pesos. Compara siempre dentro del mismo modo y de la misma zona.",
        },
      ],
    },
    {
      kind: "sub",
      title: "Fuentes de datos",
      blocks: [
        {
          kind: "table",
          head: ["Fuente", "Qué aporta", "Actualización"],
          rows: [
            ["Copernicus Marine (CMEMS)", "SST, clorofila, altimetría (SLA/ADT), corrientes geostróficas, temperatura y corriente por profundidad", "Diaria (algunos productos, horaria)"],
            ["MEDSEA_ANALYSISFORECAST_PHY_006_013", "Modelo 3D del Mediterráneo: temperatura y corrientes a 0/10/20/30/50/100 m y fondo", "Diaria, con previsión"],
            ["AVISO/Copernicus FSLE", "Exponentes de Lyapunov de tiempo finito: líneas de convergencia", "Diaria"],
            ["EMODnet Bathymetry (DTM)", "Batimetría europea de alta resolución (~115 m)", "Anual (versión del producto)"],
            ["GEBCO", "Batimetría global de respaldo fuera de cobertura EMODnet", "Anual"],
            ["Open-Meteo Marine / Forecast", "Viento, racha, oleaje, presión atmosférica", "Horaria"],
            ["SunCalc (cálculo local)", "Sol, luna, iluminación lunar, crepúsculos, solunares", "En tiempo real"],
          ],
        },
      ],
    },
  ],
};

const s2: GuideSection = {
  id: "pantallas",
  number: 3,
  title: "Explicación de cada pantalla",
  icon: "🖥️",
  summary: "Mapa, panel de capas, menú, waypoints, tracks, frentes, cuenta, precios y exportador FSLE.",
  blocks: [
    {
      kind: "text",
      text: "Cada pantalla se describe con qué hace, cómo funciona, qué muestra, cómo usarla bien, casos prácticos y errores habituales.",
    },
    {
      kind: "sub",
      title: "Mapa principal (/)",
      blocks: [
        { kind: "text", text: "Qué hace: es el centro de la aplicación. Muestra el mar con las capas activas, la retícula central, los hotspots calculados y todas las herramientas." },
        { kind: "text", text: "Cómo funciona: al mover o hacer zoom el mapa recalcula el área visible, pide los datos de esa ventana y vuelve a puntuar. Cuanto más cerrado el zoom, más fina la rejilla de análisis." },
        {
          kind: "list",
          title: "Qué información muestra",
          items: [
            "Retícula central (crosshair) con profundidad, temperatura de superficie y de fondo, velocidad y rumbo de corriente del punto exacto del centro.",
            "Marcadores de hotspots numerados por puntuación, con el Top 1 destacado.",
            "Flecha de dirección de pesca sugerida, alineada con el vector de corriente real.",
            "Leyenda de color de la capa activa y selector de fecha.",
          ],
        },
        {
          kind: "list",
          title: "Cómo usarla correctamente",
          ordered: true,
          items: [
            "Elige primero el modo de pesca (Fondo, Calamar, Superficie/Altura, Deriva).",
            "Elige la fecha: hoy para pescar, días anteriores para estudiar la evolución.",
            "Encuadra SÓLO la zona a la que puedes llegar: el motor puntúa lo que ves.",
            "Activa las capas relevantes al modo y lee primero el Top 1.",
            "Toca el punto para abrir su ficha y ver el desglose de variables.",
          ],
        },
        { kind: "text", text: "Caso práctico: salida de fondo desde Palma. Modo Fondo, encuadre de 15 millas, batimetría + relieve activados; el Top 1 cae sobre un veril de 90 m con rugosidad alta: se planifica la deriva perpendicular al veril." },
        {
          kind: "note",
          tone: "warn",
          title: "Errores habituales",
          text: "Encuadrar toda Baleares (el motor reparte la rejilla y pierde detalle), dejar una fecha antigua seleccionada, o activar diez capas a la vez y no poder leer ninguna.",
        },
      ],
    },
    {
      kind: "sub",
      title: "Panel multicapa y selector de capas",
      blocks: [
        { kind: "text", text: "Qué hace: enciende y apaga capas, ajusta su opacidad y elige la profundidad de temperatura y corrientes (superficie, 10, 20, 30, 50, 100 m y fondo)." },
        { kind: "text", text: "Cómo usarlo: una capa base de color (SST o clorofila) + una capa de estructura (corrientes o FSLE) + batimetría de referencia. Más de tres capas simultáneas es ruido visual." },
        { kind: "note", tone: "tip", text: "La opacidad es la herramienta más infravalorada: baja la capa superior al 50 % para ver cómo se solapa un frente térmico con un veril." },
      ],
    },
    {
      kind: "sub",
      title: "Panel de fondo marino y vista 3D",
      blocks: [
        { kind: "text", text: "Qué hace: dibuja el relieve del fondo con sombreado solar (hillshade), curvas batimétricas por tramos, mapa de pendientes y de rugosidad, y detecta automáticamente estructuras (bajos, veriles, cimas, cañones, mesetas, agujeros)." },
        { kind: "text", text: "Incluye el perfil del fondo: se marcan dos puntos y se dibuja el corte del relieve con distancia, profundidad mínima y máxima y desnivel. La vista 3D abre un panel de perspectiva rotable e inclinable sobre la zona visible." },
        { kind: "note", tone: "info", text: "El mapa 2D no se puede inclinar (limitación técnica del motor de mapas): por eso el 3D es un panel aparte." },
      ],
    },
    {
      kind: "sub",
      title: "Ficha de punto (al tocar el mapa)",
      blocks: [
        {
          kind: "list",
          items: [
            "Profundidad, pendiente, rugosidad y curvatura del fondo.",
            "Tipo de estructura detectada (veril, bajo, cañón, meseta, llano).",
            "Temperatura de fondo y corriente de fondo (velocidad y rumbo).",
            "Score del modo activo con explicación en lenguaje natural.",
          ],
        },
      ],
    },
    {
      kind: "sub",
      title: "Waypoints y tracks GPS",
      blocks: [
        { kind: "text", text: "Qué hace: guarda puntos y grabaciones de ruta en el propio dispositivo (almacenamiento local), sin depender de la nube. Permite importar y exportar GPX." },
        { kind: "text", text: "Cómo funciona el grabador: al activarlo registra la posición cada pocos segundos mientras la app está abierta; el bloqueo de pantalla se evita con el «wake lock» del navegador." },
        { kind: "note", tone: "warn", title: "Error habitual", text: "Borrar los datos del navegador o desinstalar la app elimina waypoints y tracks. Exporta a GPX periódicamente." },
      ],
    },
    {
      kind: "sub",
      title: "Frentes productivos (/frentes)",
      blocks: [
        { kind: "text", text: "Qué hace: en vez de puntos sueltos, dibuja ZONAS continuas de gradiente fuerte (bandas frontales) con su área, longitud del eje, intensidad media y nivel de confianza." },
        { kind: "text", text: "Cuándo usarlo: para pesca de altura y curricán, donde interesa recorrer una línea, no clavarse en un punto." },
      ],
    },
    {
      kind: "sub",
      title: "Exportador FSLE (/fsle-export)",
      blocks: [
        { kind: "text", text: "Genera un GeoJSON con las líneas FSLE del área y la fecha elegidas, listo para cargarlo en TimeZero, Google Earth o QGIS." },
      ],
    },
    {
      kind: "sub",
      title: "Cuenta (/cuenta) y Precios (/precios)",
      blocks: [
        { kind: "text", text: "Cuenta: sesión, módulos activos, gestión de la suscripción y canje de códigos de invitación. Precios: catálogo de los módulos independientes y alta de suscripción." },
      ],
    },
    {
      kind: "sub",
      title: "Visor simple (/visor-simple)",
      blocks: [
        { kind: "text", text: "Versión aligerada del mapa para conexiones lentas o equipos antiguos: menos capas activas y menos cálculo en pantalla." },
      ],
    },
  ],
};

const s3: GuideSection = {
  id: "capas",
  number: 4,
  title: "Explicación de todas las capas",
  icon: "🗺️",
  summary: "Origen, resolución, frecuencia, interpretación, utilidad y limitaciones de cada capa.",
  blocks: [
    {
      kind: "table",
      caption: "Resumen técnico de las capas",
      head: ["Capa", "Fuente", "Resolución", "Actualización"],
      rows: [
        ["Temperatura superficial (SST)", "Copernicus SST L4 / MEDSEA", "~1–4 km", "Diaria"],
        ["Temperatura por profundidad (10–100 m y fondo)", "MEDSEA PHY 006_013", "~4 km (1/24°)", "Diaria + previsión"],
        ["Clorofila-a", "Copernicus Ocean Colour L4", "1–4 km", "Diaria / mensual"],
        ["Corrientes (superficie y por profundidad)", "MEDSEA PHY 006_013 (uo/vo)", "~4 km", "Diaria + previsión"],
        ["Altimetría SLA / ADT / EKE", "Copernicus SEALEVEL", "~7 km (1/12°)", "Diaria"],
        ["FSLE (líneas de convergencia)", "AVISO/Copernicus FSLE", "~4 km", "Diaria"],
        ["Batimetría", "EMODnet DTM / GEBCO", "~115 m / ~450 m", "Anual"],
        ["Relieve, pendiente, rugosidad, curvatura", "Derivado del DEM propio", "Igual que el DEM", "Al mover el mapa"],
        ["Viento, racha y oleaje", "Open-Meteo", "~11 km", "Horaria"],
        ["Salinidad", "MEDSEA (previsto)", "~4 km", "Pendiente de activación"],
      ],
    },
    {
      kind: "sub",
      title: "Temperatura superficial (SST)",
      blocks: [
        { kind: "text", text: "Qué representa: temperatura de la piel del mar medida por satélite infrarrojo y microondas, interpolada sin huecos (L4)." },
        { kind: "text", text: "Cómo interpretarla: lo importante NO es el valor absoluto sino el GRADIENTE. Un cambio de 0,5 °C en pocas millas es un frente térmico: ahí se acumula plancton, y detrás va todo lo demás. Colores contiguos muy juntos = frente fuerte." },
        { kind: "text", text: "Cuándo es útil: siempre en superficie y altura; en fondo sólo como contexto." },
        { kind: "note", tone: "warn", title: "Limitaciones", text: "El producto L4 rellena las zonas con nubes por interpolación: en días muy nublados los frentes pueden aparecer suavizados o desplazados. Muy cerca de costa la señal se contamina con el calentamiento de las bahías." },
      ],
    },
    {
      kind: "sub",
      title: "Temperatura por profundidad y de fondo",
      blocks: [
        { kind: "text", text: "Qué representa: temperatura modelada a 10, 20, 30, 50 y 100 m y en la capa más próxima al fondo, del modelo MEDSEA." },
        { kind: "text", text: "Interpretación: la termoclina es el escalón donde la temperatura cae rápido con la profundidad; muchos pelágicos cazan justo encima. Para calamar y demersales manda la temperatura de fondo (óptimo del calamar ≈ 13–16 °C)." },
        { kind: "note", tone: "warn", title: "Limitaciones", text: "Es un modelo, no una medida directa: en zonas muy someras o de relieve abrupto la celda de 4 km promedia demasiado." },
      ],
    },
    {
      kind: "sub",
      title: "Clorofila-a",
      blocks: [
        { kind: "text", text: "Qué representa: concentración de pigmento fotosintético, es decir, cantidad de fitoplancton: el primer eslabón de la cadena." },
        { kind: "text", text: "Interpretación: NO se pesca en el máximo de clorofila (agua verde, turbia, sin oxígeno a veces) sino en su BORDE, donde el agua limpia toca el agua rica. Ese borde suele coincidir con el frente térmico." },
        { kind: "note", tone: "warn", title: "Limitaciones", text: "Sensible a nubes, a la turbidez costera y a la resuspensión de sedimento tras temporal (falsos positivos junto a la costa y en desembocaduras)." },
      ],
    },
    {
      kind: "sub",
      title: "Corrientes",
      blocks: [
        { kind: "text", text: "Qué representa: vectores uo/vo del modelo MEDSEA a la profundidad elegida, dibujados como flechas y como líneas de flujo (streamlines) animadas, integradas con Runge-Kutta de 4º orden para que la trayectoria sea fiel al campo real." },
        { kind: "text", text: "Interpretación: interesan las convergencias (dos flujos que chocan y acumulan), los cizallamientos (velocidades muy distintas al lado) y la aceleración en puntas y canales. En fondo, corriente moderada (0,05–0,20 m/s) activa la pesca; corriente nula o excesiva la mata." },
        { kind: "note", tone: "warn", title: "Limitaciones", text: "El modelo no resuelve remolinos menores de unos pocos kilómetros ni el efecto local de una punta de 200 m." },
      ],
    },
    {
      kind: "sub",
      title: "Altimetría (SLA, ADT, EKE)",
      blocks: [
        { kind: "text", text: "Qué representa: altura de la superficie del mar. SLA es la anomalía respecto a la media; ADT la topografía dinámica absoluta; EKE la energía cinética de los remolinos." },
        { kind: "text", text: "Interpretación: un abombamiento (anticiclónico) suele traer agua limpia y caliente; una depresión (ciclónico) sube agua fría y nutrientes. El BORDE entre ambos es la zona de pesca; la corriente geostrófica corre paralela a las curvas de nivel del mar." },
        { kind: "note", tone: "warn", title: "Limitaciones", text: "Resolución gruesa (~7 km) y poca fiabilidad a menos de 20–30 km de la costa." },
      ],
    },
    {
      kind: "sub",
      title: "FSLE (Finite-Size Lyapunov Exponents)",
      blocks: [
        { kind: "text", text: "Qué representa: la tasa a la que dos partículas de agua vecinas se separan. Sus crestas dibujan las «estructuras lagrangianas coherentes» (LCS): las barreras y líneas de convergencia invisibles del mar." },
        { kind: "text", text: "La app usa cálculo hacia atrás (backward), que revela las líneas ATRACTORAS: allí donde el agua —y con ella el plancton, los restos flotantes y los peces— se está acumulando ahora mismo." },
        { kind: "text", text: "Interpretación: una línea FSLE larga, continua y persistente varios días es una autopista de pesca; se pesca a lo largo de ella y cruzándola, no lejos de ella." },
        { kind: "note", tone: "warn", title: "Limitaciones", text: "Resolución ~4 km: dentro de bahías cerradas (Palma, Alcúdia) el dato original está enmascarado y la app lo extrapola desde las celdas válidas más cercanas, por lo que ahí es orientativo." },
      ],
    },
    {
      kind: "sub",
      title: "Batimetría, relieve, pendiente y rugosidad",
      blocks: [
        { kind: "text", text: "Qué representa: la profundidad del fondo (DEM propio descargado por zona) y sus derivadas: pendiente en grados o m/km, rugosidad (variación local del relieve), curvatura (bajo, hoyo o llano) y orientación de la ladera." },
        { kind: "text", text: "Interpretación: la pendiente marca los veriles; la rugosidad separa la roca (alta) de la arena y el fango (baja); la curvatura localiza cimas de bajo y agujeros. El pescado de fondo vive en el borde entre dos texturas." },
        { kind: "note", tone: "warn", title: "Limitaciones", text: "EMODnet (~115 m) no ve una piedra de 20 m. La rugosidad es un INDICIO de sustrato, no una carta geológica: no distingue roca de cascajo compacto." },
      ],
    },
    {
      kind: "sub",
      title: "Viento y oleaje",
      blocks: [
        { kind: "text", text: "Qué representa: viento medio, racha y altura significativa de ola de Open-Meteo. Se usan para calcular la deriva real del barco (corriente + ~3 % del viento), el abrigo de la costa y la seguridad." },
        { kind: "text", text: "Interpretación: para la fluixa, deriva ideal 0,15–0,6 nudos y ola por debajo de 0,4 m; por encima de 1,5 m de ola o 28 nudos de racha el motor penaliza fuerte la zona." },
      ],
    },
    {
      kind: "sub",
      title: "Salinidad y capas futuras",
      blocks: [
        { kind: "text", text: "La salinidad del modelo MEDSEA está prevista como capa y como variable de frente salino (ya reservada en el motor de fondo con la clave «frenteSalino»). Cuando se active, esta sección detallará su resolución e interpretación, y el cambio quedará registrado en el Historial de cambios." },
        { kind: "note", tone: "info", text: "Cualquier capa nueva se documenta aquí con el mismo esquema: qué representa, origen, frecuencia, resolución, interpretación, utilidad y limitaciones." },
      ],
    },
  ],
};

const s4: GuideSection = {
  id: "algoritmo",
  number: 5,
  title: "Explicación completa del algoritmo",
  icon: "🧮",
  summary: "Cómo se calculan los hotspots: rejilla, normalización, pesos, penalizaciones y orden.",
  blocks: [
    {
      kind: "diagram",
      title: "Cadena de cálculo (motor v4)",
      art: `Área visible
     │
     ▼
 1. Rejilla adaptativa (según zoom)
     │
     ▼
 2. Muestreo de capas por celda
    SST · CHL · ALT · FSLE · DEM · MEDSEA(T,uo,vo) · viento/ola
     │
     ▼
 3. Normalización 0..1 por variable (curvas de aptitud)
     │
     ▼
 4. Score ponderado del motor del MODO activo
    score = Σ(peso_i · factor_i) / Σ(peso_i presentes)
     │
     ▼
 5. Penalizaciones duras (profundidad imposible, mar rompiente…)
     │
     ▼
 6. Filtro: tierra, celdas sin datos, score < umbral
     │
     ▼
 7. Orden descendente + separación mínima entre puntos
     │
     ▼
 Top N  →  Top 1 destacado`,
    },
    {
      kind: "sub",
      title: "1. Rejilla y muestreo",
      blocks: [
        { kind: "text", text: "El área visible se divide en una rejilla cuya densidad depende del zoom. En cada celda se muestrean todas las capas disponibles. Si una capa no cubre esa celda (nube, máscara costera, fuera de dominio), esa variable queda ausente." },
      ],
    },
    {
      kind: "sub",
      title: "2. Normalización: de dato físico a factor 0..1",
      blocks: [
        { kind: "text", text: "Ninguna variable entra en bruto. Cada una pasa por una curva de aptitud que devuelve 0 (inútil) a 1 (óptimo). Las curvas no son lineales: son tramos calibrados con conocimiento de pesca." },
        {
          kind: "table",
          caption: "Ejemplos reales de curvas implementadas",
          head: ["Variable", "Curva"],
          rows: [
            ["Profundidad (calamar)", "<12 m → 0,10 · 12–30 m → sube 0,35→0,90 · 30–150 m → 1,00 · 150–260 m → baja · >260 m → 0,05"],
            ["Profundidad (fluixa)", "<3 m → 0,05 · 3–8 m → sube · 8–45 m → 1,00 · 45–80 m → baja · >140 m → 0,05"],
            ["Fondo mixto (calamar)", "rugosidad ponderada <0,8 m → 0,15 · 2–7 m → 1,00 · >14 m → 0,20"],
            ["Velocidad de deriva", "<0,05 kn → 0,15 · 0,15–0,6 kn → 1,00 · >1,2 kn → 0,10"],
            ["Oleaje (fluixa)", "≤0,4 m → 1,00 · 0,8 m → 0,50 · >1,5 m → 0,05"],
            ["Luz lunar (calamar)", "luna nueva → 1,00 · llena y alta → ≈0,25"],
            ["Veril costero", "<5 m/km → 0,15 · 25–120 m/km → 1,00 · >120 m/km → baja (pared no pescable)"],
          ],
        },
      ],
    },
    {
      kind: "sub",
      title: "3. Ponderación y renormalización",
      blocks: [
        { kind: "text", text: "El score bruto es la media ponderada de los factores presentes. La clave está en el denominador: sólo se suman los pesos de las variables que SÍ tienen dato. Si falta la clorofila, su peso se reparte proporcionalmente entre las demás en lugar de contar como cero. Así un día nublado no hunde artificialmente todas las puntuaciones." },
        { kind: "text", text: "Fórmula: score = Σ(wᵢ · fᵢ) / Σ(wᵢ), para toda variable i con dato." },
        {
          kind: "table",
          caption: "Mezcla bloque fondo / bloque superficie por modo",
          head: ["Modo", "Peso bloque fondo", "Peso bloque superficie"],
          rows: Object.entries(MIX_WEIGHTS).map(([m, v]) => [m, pct(v.fondo), pct(v.superficie)]),
        },
        { kind: "note", tone: "info", text: "El modo Deriva (fluixa) NO usa esa mezcla: tiene motor propio de una sola pasada con sus quince variables." },
      ],
    },
    {
      kind: "sub",
      title: "4. Penalizaciones duras",
      blocks: [
        { kind: "text", text: "Después de ponderar se restan penalizaciones que no admiten compensación, porque describen situaciones en las que sencillamente no se pesca:" },
        {
          kind: "list",
          items: [
            "Calamar: −0,20 si la profundidad es menor de 10 m; −0,25 si supera los 400 m.",
            "Fluixa: −0,25 con ola superior a 1,5 m; −0,20 con rachas superiores a 28 nudos; −0,20 con menos de 4 m de fondo; −0,10 a más de 8 km de costa.",
            "Todos los modos: la celda se descarta si cae en tierra o si no hay ninguna variable con dato.",
          ],
        },
      ],
    },
    {
      kind: "sub",
      title: "5. Descarte y ordenación",
      blocks: [
        {
          kind: "list",
          ordered: true,
          items: [
            "Se eliminan celdas en tierra mediante máscara costera y polígono de costa de alta resolución.",
            "Se eliminan celdas con calidad de datos insuficiente (sin batimetría y sin ninguna capa oceanográfica).",
            "Se eliminan las que quedan por debajo del umbral mínimo de puntuación.",
            "Se ordenan de mayor a menor score.",
            "Se aplica separación mínima entre puntos para no devolver diez marcas pegadas dentro del mismo veril.",
            "Se numeran: el primero es el Top 1.",
          ],
        },
      ],
    },
    {
      kind: "sub",
      title: "6. Aprendizaje adaptativo",
      blocks: [
        { kind: "text", text: "Cuando el usuario registra capturas, la app guarda una foto de los factores de ese punto y ajusta un vector de pesos personal. `getWeights()` devuelve la mezcla entre los pesos base y los aprendidos, y el peso del aprendizaje crece con el número de muestras. Los pesos base nunca se pierden: si el usuario no reporta nada, el motor funciona exactamente igual que de fábrica." },
      ],
    },
  ],
};

const s5: GuideSection = {
  id: "modos",
  number: 6,
  title: "Modos de pesca",
  icon: "🎯",
  summary: "Un apartado por modalidad con sus variables, pesos y rangos recomendados.",
  blocks: [
    {
      kind: "note",
      tone: "info",
      text: "Todas las tablas de pesos de esta sección se generan directamente desde el código del motor: si mañana cambia un peso, cambia aquí solo.",
    },
    {
      kind: "sub",
      title: "Pesca de fondo (demersales)",
      blocks: [
        {
          kind: "list",
          ordered: true,
          title: "Paso a paso",
          items: [
            "Menú ▸ Modo de pesca ▸ «Pesca de fondo».",
            "Activa la capa «Fondo marino» (hillshade + isóbatas) y, si quieres el dato térmico, «T del fondo + corrientes».",
            "Selecciona la profundidad de corrientes en «fondo» para que las flechas representen la corriente real donde vas a pescar.",
            "Sitúa el mapa sobre el veril o bajo que te interesa (zoom suficiente para ver las isóbatas).",
            "Dibuja el área de búsqueda alrededor de ese veril.",
            "Pulsa «Calcular hotspots» y espera a que terminen de cargar las capas.",
            "Abre la ficha del punto: comprueba profundidad (40–200 m), pendiente, rugosidad y corriente de fondo (0,05–0,20 m/s).",
            "Usa el visor 3D para ver el relieve del punto y localizar el cambio de orientación del veril o el cabezo.",
            "Guarda el punto como waypoint y expórtalo a GPX para el plotter.",
            "En el mar: fondea o deriva corta justo en el borde roca–arena, con el barco encarado a la corriente.",
          ],
        },
        { kind: "table", head: WEIGHT_HEAD, rows: weightRows(BOTTOM_BLOCK_WEIGHTS), caption: "Bloque de fondo (70 % del score del modo)" },
        { kind: "table", head: WEIGHT_HEAD, rows: weightRows(SURFACE_BLOCK_WEIGHTS), caption: "Bloque de superficie (30 % del score del modo)" },
        {
          kind: "list",
          title: "Rangos de referencia",
          items: [
            "Profundidad: 40–200 m según especie; el veril de 80–120 m es el clásico de dentón y pargo.",
            "Corriente de fondo: 0,05–0,20 m/s. Con calma total el pez no come; con más de 0,4 m/s no se aguanta el fondo.",
            "Temperatura de fondo: estable, sin saltos bruscos entre días.",
            "Tipo de fondo: borde entre roca y arena; rugosidad media-alta.",
            "Estructura: veriles, cabezos, cimas de bajo y cañones. La pendiente marcada pesa un 25 %.",
            "Frentes y FSLE: influyen poco (FSLE sólo " + pct(FSLE_WEIGHT_BY_MODE.bottom) + " del bloque de superficie) pero desempatan entre dos veriles parecidos.",
          ],
        },
        { kind: "note", tone: "tip", title: "Consejo", text: "Busca el punto donde el veril cambia de orientación: la corriente choca ahí y crea una zona de remanso donde se pone el pez grande." },
      ],
    },
    {
      kind: "sub",
      title: "Pesca a la deriva (Fluixa)",
      blocks: [
        { kind: "text", text: "Motor completamente independiente, pensado para bahías y franja costera. No busca el gran frente oceánico: busca el punto donde la deriva natural del barco pasa por encima de un borde productivo." },
        {
          kind: "list",
          ordered: true,
          title: "Paso a paso",
          items: [
            "Menú ▸ Modo de pesca ▸ «Pesca a la deriva (Fluixa)».",
            "Activa el GPS para que la app calcule rumbo y distancia desde tu posición.",
            "Comprueba viento y oleaje en el panel: por encima de 1,2 m de mar la deriva no es pescable.",
            "Acércate en el mapa a la bahía o tramo de costa donde vas a pescar (zoom de bahía, no de isla).",
            "Dibuja el área de búsqueda sobre esa bahía.",
            "Pulsa «Frentes productivos» ▸ «Calcular» para generar los corredores de deriva.",
            "En el mapa: el círculo numerado es solo el punto de entrada; la línea naranja es el corredor donde se pesca.",
            "Si quieres más precisión, pulsa «Línea del frente» (detalle) o «Punto exacto» en la tarjeta del frente.",
            "Exporta el corredor a PDF o GPX, o compártelo por enlace con el resto del barco.",
            "En el mar: sitúate a barlovento del inicio del corredor, apaga motor y déjate caer siguiendo la línea; repite la pasada desplazándote 50–100 m en paralelo.",
          ],
        },
        { kind: "table", head: WEIGHT_HEAD, rows: weightRows(DRIFT_WEIGHTS), caption: "Pesos del motor de fluixa (Σ = 100 %)" },
        {
          kind: "list",
          title: "Rangos de referencia",
          items: [
            "Profundidad: 8–45 m es la franja de oro; hasta 80 m aceptable.",
            "Deriva (corriente + 3 % del viento): 0,15–0,6 nudos.",
            "Oleaje: hasta 0,4 m ideal; inviable por encima de 1,2–1,5 m.",
            "Distancia a costa: entre 200 m y 2,5 km.",
            "Estructura: fondo mixto piedra–arena, rugosidad ponderada 1,5–6 m.",
            "Veril costero: 25–120 m/km.",
            "Geometría: puntas, cabos y bocanas de ensenada, donde la corriente acelera.",
          ],
        },
        { kind: "text", text: "Además del score por punto, este modo dibuja «corredores de deriva»: líneas que trazan los tres mejores frentes de deriva de la zona, con flechas de sentido, exportables a PDF y compartibles por enlace." },
        { kind: "note", tone: "tip", title: "Consejo", text: "Empieza la deriva a barlovento del punto marcado y déjate caer sobre él; nunca arranques justo encima." },
      ],
    },
    {
      kind: "sub",
      title: "Frentes de deriva vs Zona caliente",
      blocks: [
        { kind: "text", text: "Aunque ambas herramientas señalan zonas con más probabilidad de pesca, parten de preguntas distintas. El modo Deriva responde a «¿por dónde se va a mover mi barco?»; la Zona caliente responde a «¿dónde se concentra la física del mar?». Para pescar a la deriva conviene saber cuándo lidera cada una." },
        {
          kind: "table",
          head: ["Criterio", "Frentes de deriva (Fluixa)", "Zona caliente / Hotspots"],
          rows: [
            ["Qué calcula", "Corredores donde la deriva natural del barco pasa sobre estructuras productivas", "Puntos donde coinciden frentes térmicos, clorofila, altimetría, FSLE y fondo"],
            ["Salida en pantalla", "Líneas con flechas de sentido y tres frentes numerados", "Marcadores numerados con porcentaje de confianza"],
            ["Datos principales", "Viento, corriente, oleaje, profundidad, veril costero, distancia a costa", "SST, clorofila, ADT/SLA, FSLE, batimetría, corriente geostrófica"],
            ["Escala espacial", "Bahías, ensenadas y franja costera (cientos de metros a pocas millas)", "Área abierta, puntas, cabos y montes submarinos (millas a decenas de millas)"],
            ["Técnica asociada", "Fluixa, embarque a la deriva sobre veriles y bajos", "Curricán, jigging de altura, pesca de superficie y fondo en puntos exactos"],
            ["Mejor uso", "Planificar el recorrido: dónde empezar la deriva y hacia dónde caer", "Elegir el día y la zona general antes de salir"],
          ],
        },
        {
          kind: "list",
          title: "Recomendaciones según el tipo de deriva",
          items: [
            "Deriva en bahía (anjova, sirvia, lubina, dorada): usa Frentes de deriva. La Zona caliente puede servirte para validar que el corredor cruza un borde productivo, pero no para decidir el rumbo.",
            "Deriva de altura o curricán sobre frente oceánico: usa Zona caliente. Los frentes de deriva están pensados para costa y bahía; en alta mar el recorrido del barco depende de corrientes y viento a gran escala, no de veriles.",
            "Deriva mixta cerca de cabos o puntas (palometón, emperador, bonito): combina ambos. El frente marca el recorrido desde barlovento y la zona caliente confirma el borde donde vale la pena parar o repetir pasadas.",
          ],
        },
        {
          kind: "note",
          tone: "tip",
          title: "Regla práctica",
          text: "Empieza la deriva a barlovento del punto marcado, déjate caer sobre la estructura y recoge antes de que el viento te empuje demasiado al este o a sotavento. Nunca arranques justo encima del hotspot.",
        },
      ],
    },
    {
      kind: "sub",
      title: "Calamar",
      blocks: [
        { kind: "text", text: "Motor dedicado: el calamar no responde a las mismas señales que los demersales." },
        {
          kind: "list",
          ordered: true,
          title: "Paso a paso",
          items: [
            "Menú ▸ Modo de pesca ▸ «Calamar».",
            "Ajusta la hora de salida: el motor premia la franja de ±90 minutos del orto y del ocaso.",
            "Consulta el panel solunar/luna: con luna llena alta baja la expectativa o busca más fondo.",
            "Activa la capa «T del fondo + corrientes» y comprueba que la temperatura de fondo está en 13–16 °C.",
            "Dibuja el área de búsqueda sobre la franja de 30–150 m (bahías, bocanas y veriles suaves).",
            "Pulsa «Calcular hotspots» y revisa los puntos: busca transición arena–roca con corriente 0,05–0,20 m/s.",
            "Guarda 3–4 puntos como waypoints para poder rotar entre ellos durante la noche.",
            "En el mar: fondea o mantente en deriva muy lenta sobre el punto y ajusta la profundidad de la potera hasta encontrar la capa activa.",
          ],
        },
        { kind: "table", head: WEIGHT_HEAD, rows: weightRows(SQUID_WEIGHTS), caption: "Pesos del motor de calamar (Σ = 100 %)" },
        {
          kind: "list",
          title: "Rangos de referencia",
          items: [
            "Profundidad: 30–150 m (óptimo pleno).",
            "Temperatura de fondo: óptimo 13–16 °C, centrado en 14,5 °C.",
            "Corriente de fondo: moderada, 0,05–0,20 m/s.",
            "Fondo: transición arena–roca; ni fango liso ni roca escarpada.",
            "Luna: cuanto menos iluminación lunar sobre el horizonte, mejor.",
            "Hora: ±90 minutos del orto y del ocaso; la noche cerrada sigue siendo pescable pero rinde menos que el crepúsculo.",
          ],
        },
        { kind: "note", tone: "tip", title: "Consejo", text: "Con luna llena alta, baja la potera y busca más fondo o zonas con corriente algo más viva." },
      ],
    },
    {
      kind: "sub",
      title: "Superficie y altura (pelágicos)",
      blocks: [
        {
          kind: "list",
          ordered: true,
          title: "Paso a paso",
          items: [
            "Menú ▸ Modo de pesca ▸ «Pesca de altura / superficie».",
            "Elige la fecha (hoy o día anterior) en el selector de fecha; si el dato del día aún no está publicado, la app cae al último disponible.",
            "Activa las capas SST y Clorofila, y añade FSLE para ver las líneas de frente.",
            "Aleja el mapa hasta ver toda la zona de salida (10–30 millas).",
            "Dibuja el área de búsqueda (triángulo/polígono) sobre la zona a la que puedes llegar.",
            "Pulsa «Calcular hotspots» y espera a que las capas terminen de cargar (el cálculo es determinista con las teselas ya cargadas).",
            "Revisa T1/T2/T3 y quédate con el que tenga mejor confianza y distancia razonable.",
            "Activa «Zona caliente» para confirmar que el punto cae sobre el borde del frente, no en el centro de la mancha.",
            "Guarda el punto como waypoint y expórtalo a GPX o compártelo al plotter.",
            "En el mar: recorre la línea del frente en zigzag cruzándola cada pocas millas; no pesques un punto fijo.",
          ],
        },
        { kind: "table", head: WEIGHT_HEAD, rows: weightRows(SURFACE_BLOCK_WEIGHTS), caption: "Bloque de superficie (70 % del score en modo superficie)" },
        {
          kind: "list",
          title: "Rangos de referencia",
          items: [
            "Frente térmico: salto de 0,3–1,0 °C en pocas millas.",
            "Clorofila: pescar en el borde del gradiente, no en el máximo.",
            "Altimetría: borde entre un remolino cálido y uno frío; corriente geostrófica clara.",
            "FSLE: peso " + pct(FSLE_WEIGHT_BY_MODE.surface) + " del bloque; línea larga y persistente 2–3 días.",
            "Batimetría: los grandes desniveles y los montes submarinos concentran también en superficie.",
            "Persistencia: un frente que lleva tres días en el mismo sitio vale más que uno que apareció hoy.",
          ],
        },
        { kind: "note", tone: "tip", title: "Consejo", text: "En altura, pesca la línea, no el punto: recorre el frente en zigzag cruzándolo cada pocas millas." },
      ],
    },
    {
      kind: "sub",
      title: "Modalidades futuras",
      blocks: [
        { kind: "text", text: "Cualquier modalidad nueva se documentará aquí con la misma plantilla: variables usadas, tabla de pesos generada desde el motor, profundidades, corrientes, temperaturas, salinidad, batimetría, tipo de fondo, estructuras, veriles, frentes, FSLE y consejos prácticos." },
      ],
    },
  ],
};

const s6: GuideSection = {
  id: "top1",
  number: 7,
  title: "Explicación del Top 1",
  icon: "🥇",
  summary: "Qué es el punto destacado, por qué está donde está y cuándo puede cambiar.",
  blocks: [
    { kind: "text", text: "El Top 1 es simplemente la celda con la puntuación más alta del área visible, en el modo y la fecha activos, tras aplicar penalizaciones, filtros y separación mínima entre puntos." },
    {
      kind: "list",
      title: "Qué significa y qué no",
      items: [
        "Sí significa: «de todo lo que estás viendo ahora, aquí coinciden más variables favorables».",
        "No significa: «aquí hay peces garantizados» ni «aquí hay más peces que en cualquier otro sitio del Mediterráneo».",
        "Es relativo al encuadre: si mueves el mapa, el Top 1 puede cambiar de sitio porque cambia el conjunto de candidatos.",
      ],
    },
    { kind: "text", text: "Por qué aparece en una zona concreta: al abrir su ficha se muestra el desglose de factores con su valor 0..1 y las razones en lenguaje natural («veril costero pescable a la deriva», «temperatura de fondo ideal (14,3 °C)», «línea de convergencia FSLE cerca»). La primera razón de la lista es la que más ha empujado la puntuación." },
    {
      kind: "sub",
      title: "Nivel de confianza",
      blocks: [
        { kind: "text", text: "Junto al score se calcula una confianza que depende de la calidad de los datos: origen de la batimetría (EMODnet vale más que GEBCO), número de capas oceanográficas con dato real, disponibilidad de viento, ola y corriente, y coincidencia entre capas." },
        {
          kind: "table",
          head: ["Confianza", "Situación típica"],
          rows: [
            ["Alta", "EMODnet + tres capas oceanográficas + meteorología completa; varias capas señalan lo mismo"],
            ["Media", "Falta una capa (nubes en clorofila) o batimetría GEBCO"],
            ["Baja", "Sólo una variable con dato, zona enmascarada o extrapolada (interior de bahía en FSLE)"],
          ],
        },
      ],
    },
    {
      kind: "list",
      title: "Qué puede hacer que cambie",
      items: [
        "Cambiar el encuadre o el zoom (cambian los candidatos y la resolución de la rejilla).",
        "Cambiar de modo de pesca: cada motor puntúa distinto.",
        "Cambiar de fecha: los frentes se mueven varias millas al día.",
        "Actualización diaria de Copernicus (los productos entran a lo largo de la mañana).",
        "Un cambio de viento u oleaje: afecta directamente a los modos deriva y superficie.",
        "Tus propios reportes de captura, que reajustan los pesos aprendidos.",
      ],
    },
  ],
};

const s7: GuideSection = {
  id: "configuracion",
  number: 8,
  title: "Configuración",
  icon: "⚙️",
  summary: "Todos los parámetros ajustables y dónde se guardan.",
  blocks: [
    {
      kind: "table",
      head: ["Parámetro", "Dónde está", "Qué hace"],
      rows: [
        ["Modo de pesca", "Menú y panel principal", "Selecciona el motor de puntuación (Fondo, Calamar, Superficie/Altura, Deriva)"],
        ["Fecha", "Selector de fecha del mapa", "Día de los productos oceanográficos; permite retroceder para ver la evolución"],
        ["Capas activas", "Panel multicapa / selector de capas", "Enciende y apaga cada capa por separado"],
        ["Opacidad / transparencia", "Panel multicapa", "Deslizador por capa, para superponer sin tapar"],
        ["Profundidad de temperatura", "Chips «Profundidad de T»", "Superficie, 10, 20, 30, 50, 100 m y fondo"],
        ["Profundidad de corrientes", "Chips «Profundidad de las corrientes»", "Cambia flechas y streamlines a esa capa del modelo"],
        ["Escala y paleta de color", "Leyenda de color", "Paleta clásica o paleta de pesca (arena clara / roca oscura)"],
        ["Densidad de isolíneas", "Ajustes de isolíneas", "De 5 a 14 bandas; realce opcional de convergencias"],
        ["Isolíneas por variable", "Ajustes de isolíneas", "SST, clorofila y altimetría de forma independiente"],
        ["Intensidad y ángulo del hillshade", "Panel de fondo marino", "Iluminación del relieve del fondo"],
        ["GPS y seguimiento", "Control de GPS", "Centrar en la posición, seguir el barco, grabar track"],
        ["Wake lock", "Automático al grabar", "Impide que la pantalla se apague durante la grabación"],
        ["Modo bajo consumo", "Automático / visor simple", "Reduce animaciones y frecuencia de cálculo"],
        ["Unidades", "Fijas del sistema", "Profundidad en metros, temperatura en °C, corriente en m/s y nudos, distancia en km y millas náuticas"],
        ["Idioma", "Fijo", "Español. La estructura permite añadir más idiomas en el futuro"],
        ["Filtros de resultados", "Panel de hotspots", "Número de puntos y umbral mínimo de score"],
      ],
    },
    { kind: "note", tone: "info", title: "Dónde se guardan", text: "Las preferencias, waypoints y tracks se guardan en el almacenamiento local del dispositivo. La sesión y la suscripción se guardan en la nube asociadas a tu cuenta." },
  ],
};

const s8: GuideSection = {
  id: "exportaciones",
  number: 9,
  title: "Exportaciones",
  icon: "📤",
  summary: "Formatos disponibles, contenido, compatibilidad y limitaciones.",
  blocks: [
    {
      kind: "table",
      head: ["Formato", "Qué contiene", "Compatible con", "Limitaciones"],
      rows: [
        ["GPX", "Waypoints (nombre, lat/lon, comentario) y tracks grabados con marca de tiempo", "Garmin, Raymarine, Lowrance, Simrad, OpenCPN, Navionics, TimeZero, Google Earth", "No lleva colores ni estilos; algunos plotters limitan la longitud del nombre"],
        ["GeoJSON", "Líneas FSLE y frentes con sus atributos (intensidad, fecha)", "QGIS, TimeZero, Google Earth Pro, herramientas web", "Archivos grandes si el área es muy amplia"],
        ["KML", "Puntos y líneas para visualización", "Google Earth, Google Maps", "No es formato de plotter náutico"],
        ["PDF", "Ficha de pesca del corredor de deriva: mapa, coordenadas y condiciones", "Cualquier lector de PDF", "Documento de lectura, no importable a plotter"],
        ["Enlace compartido", "URL con zona, modo y fecha reproducibles en la app", "Cualquier navegador", "El destinatario necesita el módulo si la capa es de pago"],
      ],
    },
    {
      kind: "sub",
      title: "Cómo exportar",
      blocks: [
        {
          kind: "list",
          ordered: true,
          items: [
            "En el panel de waypoints o tracks, pulsa «Guardar GPX» para archivar el fichero en el dispositivo, o «Compartir GPX» para abrir el menú del sistema (AirDrop, correo, WhatsApp, Archivos, Drive).",
            "En iPhone, «Guardar GPX» abre la app Archivos; elige iCloud Drive o «En mi iPhone».",
            "En Android se escribe en la caché y se abre la hoja de compartir del sistema.",
            "En navegador de escritorio se descarga directamente a la carpeta de descargas.",
          ],
        },
        { kind: "note", tone: "info", text: "Si el sistema rechaza el tipo application/gpx+xml, la app reintenta automáticamente con tipos XML equivalentes y, en último caso, descarga el archivo con un enlace oculto. Nunca navega fuera de la página (eso provocaba pantallas en blanco en iPhone)." },
      ],
    },
    {
      kind: "sub",
      title: "Cómo importar",
      blocks: [
        {
          kind: "list",
          items: [
            "En la app: panel de waypoints → «Importar». Acepta GPX (wpt, rtept, trkpt) y KML (Placemark), incluso con XML poco estricto o sin espacios de nombres.",
            "En un plotter: copia el GPX a la tarjeta SD y usa la opción de importar del menú de usuario.",
            "En TimeZero: File → Import, seleccionando GPX o GeoJSON.",
            "En Google Earth Pro: Archivo → Abrir, seleccionando KML o GeoJSON.",
            "En QGIS: arrastra el archivo a la ventana de capas.",
          ],
        },
      ],
    },
    {
      kind: "note",
      tone: "info",
      title: "Formatos no disponibles",
      text: "Shapefile y CSV no están implementados hoy. El Shapefile requiere generar varios ficheros y empaquetarlos en ZIP; si se añaden, se documentarán aquí y en el historial de cambios.",
    },
  ],
};

const s9: GuideSection = {
  id: "interpretacion",
  number: 10,
  title: "Interpretación de mapas",
  icon: "🔍",
  summary: "Cómo leer el mapa paso a paso hasta decidir dónde pescar.",
  blocks: [
    {
      kind: "diagram",
      title: "Anatomía de un frente térmico",
      art: `  AGUA FRÍA          FRENTE          AGUA CÁLIDA
   18,2 °C      ░▒▓█ 19,4 °C █▓▒░      20,1 °C
      ·  ·  ·   │││││││││││││   ·  ·  ·
   nutrientes   ▲ acumulación   agua limpia
                │ de plancton
                └── aquí se pesca (±1 milla)`,
      legend: "Las bandas de color muy juntas indican un salto rápido de temperatura: eso es el frente. La franja pescable es el borde, no el centro del agua caliente ni el de la fría.",
    },
    {
      kind: "sub",
      title: "Cómo localizar un frente",
      blocks: [
        {
          kind: "list",
          ordered: true,
          items: [
            "Activa SST y sube el contraste con las isolíneas.",
            "Busca zonas donde las isolíneas se juntan: ahí el gradiente es fuerte.",
            "Cambia a clorofila y comprueba si el borde verde coincide con el térmico.",
            "Activa FSLE: si una línea corre paralela al frente, la señal es sólida.",
            "Retrocede uno y dos días con el selector de fecha: si el frente sigue ahí, es persistente.",
          ],
        },
      ],
    },
    {
      kind: "sub",
      title: "Cómo interpretar las FSLE",
      blocks: [
        {
          kind: "list",
          items: [
            "Línea larga y continua = estructura estable; línea corta y aislada = ruido, ignórala.",
            "Cruces de dos líneas = punto de acumulación máxima; es el mejor sitio de la zona.",
            "Líneas que abrazan un remolino = borde del remolino, la zona clásica de altura.",
            "Dentro de bahías cerradas el dato es extrapolado: úsalo como indicio, no como certeza.",
          ],
        },
      ],
    },
    {
      kind: "sub",
      title: "Cómo combinar capas",
      blocks: [
        {
          kind: "table",
          head: ["Objetivo", "Combinación recomendada"],
          rows: [
            ["Altura / pelágicos", "SST (base) + FSLE + altimetría al 50 % de opacidad"],
            ["Fondo", "Batimetría + relieve/pendiente + corriente de fondo"],
            ["Calamar", "Batimetría + rugosidad + temperatura de fondo, con la hora en crepúsculo"],
            ["Fluixa", "Batimetría de costa + corrientes de superficie + viento"],
          ],
        },
        { kind: "note", tone: "tip", text: "Regla de las tres capas: una de color de fondo, una de estructura y una de referencia. Más capas simultáneas restan en vez de sumar." },
      ],
    },
    {
      kind: "sub",
      title: "Cómo decidir dónde pescar",
      blocks: [
        {
          kind: "list",
          ordered: true,
          items: [
            "Filtra por autonomía real: no mires lo que no puedes alcanzar.",
            "Descarta por seguridad: viento y ola primero, pesca después.",
            "Compara los tres primeros hotspots y mira su desglose de factores.",
            "Prioriza el que tenga coincidencia de varias capas y confianza alta, aunque su score sea un par de puntos menor.",
            "Guarda el punto como waypoint y exporta a GPX antes de salir.",
          ],
        },
      ],
    },
    {
      kind: "note",
      tone: "info",
      title: "Sobre las capturas de pantalla",
      text: "Los ejemplos de esta sección se muestran como esquemas para que la guía funcione también sin conexión y no dependa de imágenes que caducan al cambiar el diseño. Cada esquema reproduce fielmente lo que verás en el mapa.",
    },
  ],
};

const s10: GuideSection = {
  id: "faq",
  number: 11,
  title: "Preguntas frecuentes",
  icon: "❓",
  summary: "Las dudas más habituales, respondidas sin rodeos.",
  blocks: [
    {
      kind: "faq",
      items: [
        { q: "¿La app garantiza capturas?", a: "No. Calcula probabilidad a partir de la física del mar. Reduce mucho la búsqueda, pero la pesca sigue dependiendo de la técnica, el momento y la suerte." },
        { q: "¿Cada cuánto se actualizan los datos?", a: "Los productos de Copernicus entran una vez al día (a lo largo de la mañana, hora peninsular); viento y oleaje son horarios; la batimetría es fija." },
        { q: "¿Por qué el Top 1 cambia si muevo el mapa?", a: "Porque el motor puntúa el área visible. Al cambiar el encuadre cambia el conjunto de celdas candidatas y la densidad de la rejilla." },
        { q: "¿Puedo usarla sin cobertura en el mar?", a: "Las capas ya cargadas quedan en caché y se siguen viendo, pero no podrá descargar datos nuevos ni recalcular zonas no visitadas. Prepara la salida en puerto." },
        { q: "¿Por qué no veo FSLE dentro de la bahía de Palma?", a: "El producto original enmascara las bahías pequeñas. La app extrapola desde las celdas válidas más próximas, así que ahí la línea es orientativa." },
        { q: "¿Por qué la temperatura de la app no coincide con la de mi sonda?", a: "El satélite mide la piel del mar y el modelo promedia celdas de kilómetros. Diferencias de algunas décimas son normales; lo que importa es el gradiente." },
        { q: "¿Qué diferencia hay entre modo Superficie y modo Altura?", a: "Comparten motor y bloque de superficie; el uso práctico cambia: superficie trabaja más cerca de costa y altura recorre frentes largos mar adentro." },
        { q: "¿Se guardan mis waypoints en la nube?", a: "No. Se guardan en tu dispositivo. Exporta a GPX para tener copia de seguridad." },
        { q: "¿Qué incluye cada módulo de suscripción?", a: "Cada módulo (Superficie, Fondo, Calamar, Deriva) cuesta 5 €/mes y desbloquea su motor de puntuación y sus capas específicas. El mapa básico nunca se bloquea." },
        { q: "¿Los reportes de captura son públicos?", a: "No. Se usan para ajustar tus propios pesos aprendidos." },
        { q: "¿Funciona fuera del Mediterráneo?", a: "Las capas globales (SST, clorofila, altimetría, GEBCO) sí; el modelo MEDSEA de alta resolución y las estructuras finas de fondo están calibrados para el Mediterráneo y Baleares." },
        { q: "¿Puedo instalarla como app?", a: "Sí, es una PWA instalable desde el navegador, y existen compilaciones nativas para iOS y Android." },
      ],
    },
  ],
};

const s11: GuideSection = {
  id: "problemas",
  number: 12,
  title: "Solución de problemas",
  icon: "🛠️",
  summary: "Síntoma, causa probable y solución.",
  blocks: [
    {
      kind: "table",
      head: ["Síntoma", "Causa probable", "Solución"],
      rows: [
        ["El mapa carga pero las capas salen vacías", "El producto del día aún no está publicado o hay máscara de nubes", "Retrocede un día con el selector de fecha"],
        ["La capa se queda cargando indefinidamente", "Servidor de Copernicus lento o caído", "Espera un minuto, apaga y enciende la capa; prueba otra capa para confirmar"],
        ["Los datos parecen antiguos", "Caché del navegador", "Recarga forzando la actualización o cierra y abre la app"],
        ["No aparecen hotspots", "Área totalmente en tierra, zoom demasiado abierto o umbral alto", "Encuadra sólo mar, acerca el zoom y baja el umbral"],
        ["El GPS no centra", "Permiso de ubicación denegado o navegador sin HTTPS", "Concede el permiso en los ajustes del sistema y del navegador"],
        ["El GPS salta o pierde precisión", "Cobertura pobre bajo cubierta o modo de ahorro de energía", "Sal a cubierta y desactiva el ahorro de energía"],
        ["La exportación no hace nada", "El navegador bloquea la hoja de compartir en vista previa o iframe", "Usa la app instalada; si no, la app cae automáticamente a descarga directa"],
        ["El GPX no se importa", "Archivo de otro formato o corrupto", "Comprueba que contiene etiquetas wpt/trkpt; la app también acepta KML"],
        ["La app va lenta", "Demasiadas capas activas, animación de corrientes y zoom muy abierto", "Deja tres capas, apaga los streamlines o usa el visor simple"],
        ["Se apaga la pantalla grabando track", "Bloqueo automático del sistema", "La app pide wake lock, pero algunos sistemas lo ignoran en segundo plano: mantén la app en primer plano"],
        ["Pantalla en blanco tras compartir en iPhone", "Comportamiento antiguo ya corregido", "Actualiza a la última versión de la app"],
        ["Pagué y no tengo acceso", "La confirmación del pago tarda unos segundos", "Recarga la pantalla de cuenta; si persiste, escribe a soporte con el correo de la compra"],
      ],
    },
  ],
};

const s12: GuideSection = {
  id: "glosario",
  number: 13,
  title: "Glosario",
  icon: "📖",
  summary: "Todos los términos técnicos que aparecen en la app.",
  blocks: [
    {
      kind: "table",
      head: ["Término", "Definición"],
      rows: [
        ["ADT", "Topografía dinámica absoluta: altura real de la superficie del mar respecto al geoide. Sus curvas indican la dirección de la corriente geostrófica."],
        ["Altimetría", "Medición satelital de la altura de la superficie del mar."],
        ["Anticiclónico", "Remolino que gira en sentido horario (hemisferio norte), con abombamiento del mar, agua cálida y limpia."],
        ["Batimetría", "Medida y representación de la profundidad del fondo marino."],
        ["Ciclónico", "Remolino que gira en sentido antihorario (hemisferio norte), con depresión del mar y ascenso de agua fría y nutrientes."],
        ["Clorofila-a", "Pigmento del fitoplancton; indica la cantidad de vida vegetal microscópica."],
        ["Corriente geostrófica", "Corriente derivada del equilibrio entre el gradiente de presión (pendiente del mar) y la fuerza de Coriolis."],
        ["Crepúsculo", "Franja de luz alrededor del orto y el ocaso; ventana de máxima actividad de muchas especies."],
        ["Curvatura", "Segunda derivada del relieve del fondo: distingue cimas, depresiones y llanos."],
        ["DEM", "Modelo digital de elevaciones; aquí, la rejilla de profundidad descargada por zona."],
        ["Deriva", "Movimiento del barco sin motor, suma de corriente y arrastre del viento (≈3 % de su velocidad)."],
        ["EKE", "Energía cinética de los remolinos: cuánta actividad turbulenta hay en la zona."],
        ["EMODnet", "Red europea de datos marinos; su modelo batimétrico tiene ~115 m de resolución."],
        ["Fluixa", "Pesca a la deriva en bahías y costa, dejándose llevar sobre estructuras productivas."],
        ["Frente", "Zona estrecha de transición entre dos masas de agua distintas."],
        ["FSLE", "Finite-Size Lyapunov Exponent: tasa de separación de partículas de agua; sus crestas dibujan las líneas de convergencia."],
        ["GEBCO", "Batimetría global de respaldo, resolución más gruesa que EMODnet."],
        ["GPX", "Formato estándar de intercambio de waypoints, rutas y tracks GPS."],
        ["Gradiente", "Ritmo de cambio de una variable en el espacio; cuanto mayor, más marcado el frente."],
        ["Hillshade", "Sombreado del relieve simulando iluminación solar, para ver el fondo en 3D."],
        ["Isóbata", "Línea que une puntos de igual profundidad."],
        ["Isolínea", "Línea que une puntos de igual valor de una variable (temperatura, clorofila…)."],
        ["LCS", "Estructuras lagrangianas coherentes: las «barreras» y «autopistas» invisibles del flujo marino."],
        ["MEDSEA", "Modelo numérico del Mediterráneo de Copernicus con 3D de temperatura, salinidad y corrientes."],
        ["Pendiente", "Inclinación del fondo, en grados o en metros por kilómetro; los valores altos marcan veriles."],
        ["Raster", "Dato en forma de rejilla de píxeles (por ejemplo, una imagen de temperatura)."],
        ["Resolución", "Tamaño de la celda de un dato; 4 km significa que cada valor representa un cuadrado de 4×4 km."],
        ["RK4", "Integración de Runge-Kutta de 4º orden, usada para dibujar líneas de corriente fieles al campo real."],
        ["Rugosidad", "Variación local del relieve; alta en roca, baja en arena y fango."],
        ["SLA", "Anomalía del nivel del mar: diferencia respecto a la media histórica."],
        ["SST", "Sea Surface Temperature: temperatura superficial del mar."],
        ["Termoclina", "Capa donde la temperatura cae rápidamente con la profundidad."],
        ["Upwelling", "Afloramiento de agua profunda, fría y rica en nutrientes."],
        ["Vector", "Dato con dirección y magnitud (por ejemplo, la corriente) o geometría de puntos y líneas."],
        ["Veril", "Cambio brusco de profundidad; borde de la plataforma o pared submarina."],
        ["Waypoint", "Punto geográfico guardado con nombre y coordenadas."],
        ["WMTS", "Servicio web de teselas de mapa, el sistema con el que se sirven las capas."],
      ],
    },
  ],
};

export interface ChangelogEntry {
  date: string;
  version: string;
  changes: { type: "nuevo" | "mejora" | "corrección"; text: string }[];
}

export const CHANGELOG: ChangelogEntry[] = [
  {
    date: "2026-08-13",
    version: "4.7",
    changes: [
      { type: "mejora", text: "Nueva sección 1 «Empezar: paso a paso pulsando»: instrucciones literales botón por botón (abrir menú, pulsar, volver) para Fondo, Fluixa, Calamar y Altura." },
    ],
  },
  {

    date: "2026-08-13",
    version: "4.6",
    changes: [
      { type: "mejora", text: "Cada modo de pesca de la guía incluye ahora un «Paso a paso» operativo: qué activar, en qué orden y cómo pescar el resultado." },
    ],
  },
  {
    date: "2026-08-11",
    version: "4.5",
    changes: [
      { type: "mejora", text: "Comparativa entre Frentes de deriva y Zona caliente añadida a la guía, con recomendaciones por tipo de pesca a la deriva." },
    ],
  },
  {
    date: "2026-08-05",
    version: "4.4",
    changes: [
      { type: "nuevo", text: "Guía de la aplicación reescrita como manual completo con 17 secciones, buscador e índice interactivo." },
      { type: "nuevo", text: "Las tablas de pesos de la guía se generan directamente desde el motor de puntuación, por lo que nunca quedan desfasadas." },
    ],
  },
  {
    date: "2026-08-04",
    version: "4.3",
    changes: [
      { type: "corrección", text: "Exportar y compartir GPX unificado: nativo en iOS y Android, Web Share con reintento de tipos XML y descarga oculta como último recurso." },
      { type: "corrección", text: "Importador de waypoints tolerante a GPX/KML poco estrictos y con detección de cancelación." },
    ],
  },
  {
    date: "2026-08-02",
    version: "4.2",
    changes: [
      { type: "nuevo", text: "Modo Pesca a la deriva (Fluixa) con motor propio y corredores de deriva exportables a PDF." },
      { type: "nuevo", text: "Suscripciones por módulos independientes y códigos de invitación." },
    ],
  },
  {
    date: "2026-07-31",
    version: "4.1",
    changes: [
      { type: "nuevo", text: "Fondo marino profesional: hillshade, isóbatas por tramos, pendiente, rugosidad, detección de estructuras, perfil del fondo y vista 3D." },
      { type: "nuevo", text: "Guardado de tracks GPS y exportación a GPX." },
    ],
  },
  {
    date: "2026-07-30",
    version: "4.0",
    changes: [
      { type: "mejora", text: "Motor de puntuación v4: motores dedicados de calamar y superficie, tabla única de pesos y aprendizaje adaptativo por capturas." },
      { type: "mejora", text: "Líneas FSLE en modo backward con refinamiento sub-píxel y relleno de bahías." },
      { type: "mejora", text: "Corrientes con integración RK4, menos líneas y dirección fiel al dato real." },
    ],
  },
];

const s13: GuideSection = {
  id: "historial",
  number: 14,
  title: "Historial de cambios",
  icon: "🗓️",
  summary: "Registro de versiones con novedades, mejoras y correcciones.",
  blocks: [
    { kind: "text", text: "Cada versión publicada deja aquí su rastro. Las entradas se añaden en el mismo cambio que introduce la función, de modo que la guía y la app siempre van a la par." },
    {
      kind: "table",
      head: ["Fecha", "Versión", "Tipo", "Cambio"],
      rows: CHANGELOG.flatMap((e) =>
        e.changes.map((c, i) => [i === 0 ? e.date : "", i === 0 ? e.version : "", c.type, c.text]),
      ),
    },
  ],
};

const s14: GuideSection = {
  id: "visual",
  number: 15,
  title: "Guía visual",
  icon: "🎨",
  summary: "Esquemas y diagramas de los conceptos clave.",
  blocks: [
    {
      kind: "diagram",
      title: "Perfil de un veril y dónde se pone el pez",
      art: ` 0 m ────────────────── superficie ──────────────────
            barco →→→ deriva
 40 m ▁▁▁▁▁▁▁▁▁▁▁▁╲
                    ╲   ← pendiente fuerte (veril)
 90 m                ╲▁▁▁▁▂▂▃  ← cabezo / roca
                          ●  pez grande al abrigo
150 m ▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁▁ llano de fango`,
      legend: "El motor puntúa alto el borde superior del veril y el pie de la pared, no la pared vertical en sí.",
    },
    {
      kind: "diagram",
      title: "Estructura de un remolino y sus bordes",
      art: `        ╭──────────────╮
      ╭─┤   CÁLIDO     ├─╮   ← anticiclónico, agua limpia
      │ ╰──────────────╯ │
      │      ↻↻↻↻        │
      ╰──────┬───────────╯
   ~~~~ BORDE ~~~~  ← aquí se pesca (frente + FSLE)
      ╭──────┴───────────╮
      │      ↺↺↺↺        │   ← ciclónico, agua fría
      ╰──────────────────╯      y rica en nutrientes`,
      legend: "Los bordes de remolino concentran comida; el centro de cada remolino suele ser pobre.",
    },
    {
      kind: "diagram",
      title: "Flujo de decisión de una salida",
      art: `Elegir modo ──► Elegir fecha ──► Encuadrar la zona alcanzable
                                        │
                                        ▼
                       Activar 3 capas (color + estructura + fondo)
                                        │
                                        ▼
                    Leer Top 1 ──► ¿Coinciden varias capas?
                          │                 │
                       sí │                 │ no
                          ▼                 ▼
                 Guardar waypoint     Revisar Top 2 y 3
                          │
                          ▼
                Comprobar viento y ola ──► Exportar GPX ──► Salir`,
    },
    {
      kind: "diagram",
      title: "Escala de color de profundidad (paleta de pesca)",
      art: `  0 m  ░░░  arena clara
 20 m  ▒▒▒  fondo somero
 50 m  ▓▓▓  transición
100 m  ███  veril
200 m  ▓▓▓  talud
500 m+ ░░░  llanura profunda`,
    },
    {
      kind: "diagram",
      title: "Combinar frente de deriva con zona caliente",
      art: `  barco →→→ →→→ →→→  ← viento/corriente
              ↘
               ↘  corredor de deriva
                ↘
    ~~~~ BORDE PRODUCTIVO ~~~~  ← zona caliente (frente térmico + veril)
         ●  ●  ●
           punto de pesca`,
      legend: "El corredor de deriva indica por dónde cae el barco; la zona caliente marca el borde donde parar o repetir la pasada.",
    },
  ],
};

const s15: GuideSection = {
  id: "mantenimiento",
  number: 16,
  title: "Buscador, índice y actualización permanente",
  icon: "🔄",
  summary: "Cómo se usa esta guía y bajo qué compromiso se mantiene.",
  blocks: [
    {
      kind: "list",
      title: "Cómo usar esta guía",
      items: [
        "Buscador: escribe cualquier palabra (por ejemplo «FSLE», «veril», «GPX» o «rugosidad») y se filtran las secciones y los párrafos que la contienen.",
        "Índice interactivo: la columna de secciones lleva directamente a cualquier apartado; en móvil aparece como lista desplegable.",
        "«Ver todo» muestra el manual completo de corrido, apto para leer o imprimir.",
      ],
    },
    {
      kind: "sub",
      title: "Compromiso de actualización permanente",
      blocks: [
        { kind: "text", text: "Toda función nueva, modificada o eliminada de Hotspot Fishing se documenta en el mismo cambio que la introduce. La regla está escrita en la cabecera del archivo de contenido para que nadie pueda saltársela." },
        {
          kind: "list",
          title: "Qué se documenta de cada función nueva",
          ordered: true,
          items: [
            "Descripción: qué es y qué problema resuelve.",
            "Funcionamiento: cómo opera por dentro y qué muestra.",
            "Variables utilizadas y, si afecta al Score, su peso (tomado del motor, no escrito a mano).",
            "Casos de uso reales.",
            "Consejos prácticos.",
            "Limitaciones conocidas.",
            "Entrada en el Historial de cambios con fecha y versión.",
          ],
        },
        { kind: "note", tone: "info", title: "Autoactualización real", text: "Los pesos, la mezcla fondo/superficie y las etiquetas de las variables se importan del código del motor de puntuación. Si un desarrollador cambia un peso, esta guía muestra el valor nuevo sin que nadie tenga que editarla." },
      ],
    },
  ],
};

export const GUIDE_SECTIONS: GuideSection[] = [s0, s1, s2, s3, s4, s5, s6, s7, s8, s9, s10, s11, s12, s13, s14, s15];

// ─────────────────────────── Buscador ───────────────────────────

function blockText(b: Block): string {
  switch (b.kind) {
    case "text":
      return b.text;
    case "list":
      return `${b.title ?? ""} ${b.items.join(" ")}`;
    case "table":
      return `${b.caption ?? ""} ${b.head.join(" ")} ${b.rows.map((r) => r.join(" ")).join(" ")}`;
    case "note":
      return `${b.title ?? ""} ${b.text}`;
    case "diagram":
      return `${b.title} ${b.art} ${b.legend ?? ""}`;
    case "faq":
      return b.items.map((i) => `${i.q} ${i.a}`).join(" ");
    case "sub":
      return `${b.title} ${b.blocks.map(blockText).join(" ")}`;
  }
}

export function sectionText(s: GuideSection): string {
  return `${s.title} ${s.summary} ${s.blocks.map(blockText).join(" ")}`;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

export interface SearchHit {
  section: GuideSection;
  /** Fragmentos de texto donde aparece el término. */
  snippets: string[];
}

export function searchGuide(query: string): SearchHit[] {
  const q = norm(query.trim());
  if (q.length < 2) return [];
  const hits: SearchHit[] = [];
  for (const s of GUIDE_SECTIONS) {
    const snippets: string[] = [];
    const collect = (blocks: Block[]) => {
      for (const b of blocks) {
        if (b.kind === "sub") {
          collect(b.blocks);
          if (norm(b.title).includes(q)) snippets.push(b.title);
          continue;
        }
        const t = blockText(b).replace(/\s+/g, " ").trim();
        const i = norm(t).indexOf(q);
        if (i >= 0) snippets.push(t.slice(Math.max(0, i - 70), i + 160));
      }
    };
    collect(s.blocks);
    if (snippets.length > 0 || norm(`${s.title} ${s.summary}`).includes(q)) {
      hits.push({ section: s, snippets: snippets.slice(0, 3) });
    }
  }
  return hits;
}

