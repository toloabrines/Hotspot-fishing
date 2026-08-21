/**
 * BASE DE CONOCIMIENTO DE PESCA (Mediterráneo / Baleares + pesca de altura).
 *
 * Es la «biblioteca» que consulta el asistente antes de responder. Se combina
 * con los documentos añadidos por el administrador en la tabla
 * `public.ai_knowledge_docs`, de modo que se puede ampliar sin reconstruir la app.
 *
 * IMPORTANTE: aquí NO hay datos del mar en tiempo real. Son criterios generales
 * de pesca. Todo dato medido (temperatura, corriente, viento, profundidad…) lo
 * aporta la app, nunca este archivo ni la IA.
 */

export interface KnowledgeDoc {
  id: string;
  title: string;
  category:
    | "especie"
    | "tecnica"
    | "modalidad"
    | "comportamiento"
    | "normativa"
    | "seguridad";
  species: string[];
  modes: Array<"surface" | "bottom" | "squid" | "drift" | "any">;
  tags: string[];
  content: string;
  /** Fecha de última revisión del contenido (para avisar de vigencia). */
  reviewedOn: string;
  source?: string;
}

/** Fecha de revisión general de la base de conocimiento incluida en la app. */
export const KNOWLEDGE_REVIEWED_ON = "2026-08-17";

export const FISHING_KNOWLEDGE: KnowledgeDoc[] = [
  /* ───────────── ESPECIES ───────────── */
  {
    id: "esp-calamar",
    title: "Calamar (Loligo vulgaris)",
    category: "especie",
    species: ["calamar", "loligo", "chipiron"],
    modes: ["squid"],
    tags: ["cefalopodo", "otoño", "invierno", "poteras"],
    content: `Hábitat: fondos de arena, cascajo y praderas de posidonia entre 15 y 90 m; en Baleares el grueso entre 25 y 60 m.
Temporada fuerte: de octubre a marzo, con picos tras los primeros temporales de otoño.
Temperatura: se mueve bien con agua de fondo entre 14 y 18 °C; por encima de 21 °C baja mucho la actividad y se profundiza.
Horario: mejor amanecer y atardecer, y noche con luz artificial. Luna nueva o cuarto creciente suele dar mejores jornadas de noche.
Corriente y viento: prefiere corriente floja (0,1-0,4 kn). Con más de 0,8 kn la potera no trabaja vertical y baja el rendimiento.
Aparejo: poteras de 2.0-3.5 según profundidad y corriente, línea fina, plomo justo, deriva lenta o fondeo sobre el veril.
Técnica: caída controlada, tirones cortos y pausas largas; el calamar entra en la pausa. Marcar el punto exacto donde entra: suelen estar agrupados.`,
    reviewedOn: "2026-08-17",
  },
  {
    id: "esp-sepia",
    title: "Sepia (Sepia officinalis)",
    category: "especie",
    species: ["sepia", "choco"],
    modes: ["squid", "bottom"],
    tags: ["cefalopodo", "primavera", "bahias"],
    content: `Hábitat: fondos de arena y alga cercanos a costa, entre 3 y 40 m; entra a bahías (Palma, Alcúdia, Pollença) a desovar.
Temporada: de febrero a mayo, con máximo cuando el agua de superficie sube de 14 a 17 °C.
Comportamiento: muy ligada al fondo; busca los bordes entre arena y roca/alga. Actividad alta con poca luz y agua algo turbia tras levante.
Aparejo: potera pesada o jibionera arrastrada muy despacio a 0,5-1,2 nudos, o al lanzado desde deriva.
Corriente: tolera menos corriente que el calamar; con más de 0,6 kn conviene buscar resguardo dentro de bahía.`,
    reviewedOn: "2026-08-17",
  },
  {
    id: "esp-denton",
    title: "Dentón (Dentex dentex)",
    category: "especie",
    species: ["denton", "dentex"],
    modes: ["bottom", "drift", "surface"],
    tags: ["depredador", "veril", "curricán", "jigging"],
    content: `Hábitat: veriles rocosos, secos, cabos y piedras aisladas entre 15 y 80 m; los grandes ejemplares patrullan el borde del veril.
Temperatura: activo entre 16 y 24 °C de superficie; en verano se refugia a más profundidad o busca corrientes frescas.
Comportamiento: caza en corriente, siempre a favor del borde estructural. Amanecer y atardecer son sus dos ventanas claras.
Técnicas: curricán de fondo con pez vivo o rapala a 2-3 nudos sobre el veril; jigging ligero de 60-150 g; fluixa con vivo (caballa, jurel pequeño, salpa).
Estructura clave: pendiente pronunciada (más de 8-10°), cambios bruscos de batimetría y piedra sobre arena.
Corriente: le favorece 0,3-0,8 kn; con corriente nula la actividad cae.`,
    reviewedOn: "2026-08-17",
  },
  {
    id: "esp-pagre",
    title: "Pagre (Pagrus pagrus)",
    category: "especie",
    species: ["pagre", "pagra", "pargo"],
    modes: ["bottom"],
    tags: ["esparido", "arena", "cascajo"],
    content: `Hábitat: fondos mixtos de arena, cascajo y piedra suelta entre 30 y 120 m.
Temperatura de fondo: cómodo entre 14 y 19 °C.
Comportamiento: gregario en tallas medias; busca comida arrastrada por la corriente al pie del veril y en llanos de cascajo.
Técnica: fondo con aparejo de dos anzuelos y plomo al fondo, cebo natural (gamba, sardina, calamar, cangrejo) o volantín; también jigs lentos e inchiku.
Mejor momento: corriente moderada y cambio de marea/pequeño repunte de corriente; amanecer.`,
    reviewedOn: "2026-08-17",
  },
  {
    id: "esp-jurel",
    title: "Jurel / sorell (Trachurus spp. y Seriola en pesca mayor)",
    category: "especie",
    species: ["jurel", "sorell", "seriola"],
    modes: ["surface", "drift", "bottom"],
    tags: ["pelagico", "banco", "vivo"],
    content: `Jurel común: bancos pelágicos sobre veriles y bajos, entre 20 y 150 m. Sube a media agua con corriente y presencia de carnada.
Excelente cebo vivo para dentón, seriola y llampuga.
Seriola (verderol): estructuras y bajos con corriente clara, 20-80 m, activa en otoño; jigging rápido y vivo.
Señales: pájaros trabajando, manchas de carnada en sonda entre 15 y 40 m, agua con clorofila moderada (0,1-0,4 mg/m³).`,
    reviewedOn: "2026-08-17",
  },
  {
    id: "esp-gallo",
    title: "Gallo de San Pedro (Zeus faber)",
    category: "especie",
    species: ["gallo de san pedro", "san pedro", "zeus", "gall"],
    modes: ["bottom", "drift"],
    tags: ["fondo", "vivo", "invierno"],
    content: `Hábitat: fondos de arena y fango junto a estructura, entre 30 y 150 m.
Temporada: otoño e invierno, con agua de fondo entre 13 y 17 °C.
Comportamiento: cazador lento y solitario; se acerca mucho al vivo y lo aspira. Requiere deriva muy lenta.
Técnica: aparejo de fondo con vivo pequeño (jurel, caramel) o jig lento; deriva de 0,3-0,8 nudos. Clavar sin prisa.`,
    reviewedOn: "2026-08-17",
  },
  {
    id: "esp-atun",
    title: "Atún rojo (Thunnus thynnus)",
    category: "especie",
    species: ["atun", "atun rojo", "bluefin"],
    modes: ["surface"],
    tags: ["pelagico", "altura", "normativa"],
    content: `Hábitat: mar abierto, frentes térmicos y de corriente, bordes de remolinos y líneas FSLE marcadas.
Temperatura: caza entre 17 y 24 °C de superficie; busca gradientes de 0,3 °C o más en pocas millas.
Señales: pájaros, saltos, manchas de carnada, línea de convergencia con basurilla o espuma.
Técnicas: curricán a 6-8 nudos con señuelos de superficie, spinning al cardumen, vivo a la deriva en frente.
NORMATIVA: especie muy regulada (cuotas, tallas, periodos y autorización específica). Antes de salir hay que verificar la norma vigente del año en curso.`,
    reviewedOn: "2026-08-17",
  },
  {
    id: "esp-albacora-listado",
    title: "Albacora (bonito del norte), listado y bonito",
    category: "especie",
    species: ["albacora", "bonito", "listado", "bacoreta", "melva"],
    modes: ["surface"],
    tags: ["pelagico", "curricán", "altura"],
    content: `Albacora: aguas de 16-20 °C, prefiere frentes y aguas algo más frías y limpias; curricán a 6-7 nudos con plumas y minnows pequeños, a menudo lejos de costa y sobre grandes profundidades.
Listado y bacoreta: 20-26 °C, cazan en superficie en cardúmenes rápidos; spinning con lápices y jigs de 20-40 g, o curricán rápido con plumas pequeñas.
Todos siguen la carnada: buscar clorofila moderada, frentes térmicos y convergencias FSLE.`,
    reviewedOn: "2026-08-17",
  },
  {
    id: "esp-lampuga",
    title: "Llampuga / lampuga (Coryphaena hippurus)",
    category: "especie",
    species: ["lampuga", "llampuga", "dorado", "mahi"],
    modes: ["surface", "drift"],
    tags: ["pelagico", "otoño", "cañizo", "objetos flotantes"],
    content: `Temporada en Baleares: de finales de agosto a noviembre (temporada tradicional con "caps de llampuga").
Temperatura: 22-27 °C de superficie; muy ligada a objetos flotantes, palangres, boyas y sombras.
Técnica: curricán lento 3-5 nudos con plumas y minnows de colores, spinning con lápices, y vivo o tira de calamar a la deriva junto al objeto flotante.
Comportamiento: llega en grupo; si se engancha una, mantener otra línea en el agua para retener al grupo.`,
    reviewedOn: "2026-08-17",
  },

  /* ───────────── MODALIDADES ───────────── */
  {
    id: "mod-fondo",
    title: "Pesca de fondo: criterio de zona",
    category: "modalidad",
    species: [],
    modes: ["bottom"],
    tags: ["veril", "pendiente", "temperatura de fondo"],
    content: `Lo que manda es la estructura del fondo y la temperatura de fondo, no la superficie.
Buscar: veriles con pendiente marcada, cambios de arena a roca, plataformas y cabeceras de cañón.
Profundidad práctica en Baleares: 40-150 m para pagre, besugo, gallo y dentón grande.
Corriente: 0,2-0,6 kn permite plomar bien; por encima de 1 kn hay que aumentar plomo o cambiar de zona.
Deriva: mantener 0,5-1 nudo sobre la estructura; si la deriva es más rápida, fondear o usar motor.`,
    reviewedOn: "2026-08-17",
  },
  {
    id: "mod-altura",
    title: "Pesca de altura / superficie",
    category: "modalidad",
    species: [],
    modes: ["surface"],
    tags: ["frentes", "fsle", "clorofila", "curricán"],
    content: `Se pesca la masa de agua, no el fondo. Prioridad: frentes térmicos (gradiente de SST), líneas FSLE de convergencia y bordes de clorofila.
Señales buenas: gradiente de SST superior a 0,2-0,3 °C por milla, clorofila de 0,1 a 0,5 mg/m³ en el borde (no dentro de la mancha verde densa), pájaros y carnada.
Velocidades de curricán: 2-3 nudos con vivo o rapala; 5-7 nudos con plumas para túnidos; 3-5 nudos para llampuga.
Horario: primera y última luz; con luna llena la actividad nocturna reduce la matinal.`,
    reviewedOn: "2026-08-17",
  },
  {
    id: "mod-deriva",
    title: "Pesca a la deriva (fluixa) en bahías y costa",
    category: "modalidad",
    species: [],
    modes: ["drift"],
    tags: ["fluixa", "vivo", "bahia", "viento"],
    content: `La deriva la genera la suma de viento y corriente. Deriva ideal: 0,5-1,2 nudos.
Con más de 1,5 nudos hay que fondear a medias, usar ancla flotante o cambiar a resguardo.
Zonas: bordes de bahía, cabos, bajos y veriles poco profundos (10-60 m), con posidonia y arena alternadas.
Cebo: vivo pequeño (jurel, caramel, salpa), tira de calamar, gamba viva.
Rumbo de la pasada: siempre presentando el cebo por delante de la estructura, no arrastrándolo por detrás.
Repetir la pasada exacta que dio pique: la fluixa se pesca por corredores, no por puntos sueltos.`,
    reviewedOn: "2026-08-17",
  },
  {
    id: "mod-jigging-curri",
    title: "Jigging, inchiku y curricán: aparejos y velocidades",
    category: "tecnica",
    species: [],
    modes: ["bottom", "surface", "drift"],
    tags: ["jig", "señuelo", "velocidad"],
    content: `Jigging vertical: jig de 1,5-2 g por metro de profundidad ajustado a corriente; recuperación rápida para seriola, lenta (slow jig / inchiku) para pagre, dentón y gallo.
Curricán de fondo: 2-3 nudos, plomo o downrigger para mantener el señuelo a 2-5 m del fondo sobre el veril.
Curricán de superficie: 5-7 nudos túnidos, 3-5 nudos llampuga y bonito.
Líneas: trenzado fino para reducir la panza con corriente; bajo de fluorocarbono de 0,40-0,80 según especie.
Cebos naturales: sardina, calamar, gamba, cangrejo, vivo de la zona. El vivo local siempre supera al cebo importado.`,
    reviewedOn: "2026-08-17",
  },

  /* ───────────── COMPORTAMIENTO ───────────── */
  {
    id: "com-condiciones",
    title: "Cómo leen los peces la corriente, la temperatura, el viento y la luna",
    category: "comportamiento",
    species: [],
    modes: ["any"],
    tags: ["corriente", "presion", "luna", "termoclina"],
    content: `Corriente: es el motor de la pesca. Los depredadores se colocan a sotacorriente de la estructura esperando la comida. Corriente nula = pesca lenta; corriente fuerte (>1,2 kn) = difícil presentar el cebo.
Temperatura: cada especie tiene su rango. Los saltos de temperatura (frentes y termoclina) concentran vida; la termoclina marca la profundidad donde suele estar el pescado activo.
Viento: cambia la deriva y remueve el agua. Levante suele enturbiar y activar la costa; tramontana fuerte cierra las zonas norte. Por encima de 18-20 nudos, seguridad primero.
Presión: bajadas rápidas antes de un frente suelen dar actividad; presión muy baja y estable, jornada floja. Subida tras temporal: los primeros días son buenos en costa.
Luna: creciente y llena favorecen actividad nocturna; nueva concentra la actividad al amanecer y atardecer.
Estructura: pendiente, cambio de sustrato y piedras aisladas valen más que la profundidad por sí sola.`,
    reviewedOn: "2026-08-17",
  },
  {
    id: "com-fsle-clorofila",
    title: "FSLE, clorofila y altimetría: qué significan para pescar",
    category: "comportamiento",
    species: [],
    modes: ["surface", "drift"],
    tags: ["fsle", "clorofila", "altimetria", "frentes"],
    content: `FSLE (líneas de convergencia): marcan dónde el agua se junta y acumula plancton, huevos y carnada. Las líneas más marcadas y persistentes varios días son las mejores.
Clorofila: indica alimento. El pescado grande no está dentro de la mancha densa, sino en su borde, donde el agua limpia toca la verde.
Altimetría: los bordes de remolino (anticiclónico/ciclónico) crean corriente estable y concentran carnada.
Combinación ideal para altura: frente de SST + línea FSLE + borde de clorofila coincidiendo en pocas millas.`,
    reviewedOn: "2026-08-17",
  },

  /* ───────────── NORMATIVA Y SEGURIDAD ───────────── */
  {
    id: "norm-tallas",
    title: "Tallas mínimas orientativas (Mediterráneo español) — VERIFICAR VIGENCIA",
    category: "normativa",
    species: [],
    modes: ["any"],
    tags: ["tallas", "normativa", "licencia"],
    content: `Referencia orientativa habitual en el Mediterráneo español (cm):
dentón 30, pagre 18, sargo 23, dorada 20, lubina 25, corvina 45, mero 45, serviola/seriola 45, caballa 18, jurel 15, boquerón 9, sardina 11, salmonete 15, merluza 20, llampuga sin talla estatal general, calamar y sepia sin talla estatal general (pueden tener límites autonómicos).
Además: licencia de pesca recreativa en vigor, cupos diarios por pescador, prohibición de venta de la captura, restricciones en reservas marinas (por ejemplo el Parque Nacional de Cabrera) y regulación específica para atún rojo.
AVISO OBLIGATORIO: estas cifras son orientativas y con fecha de revisión ${"2026-08-17"}. Antes de pescar hay que comprobar la normativa vigente de la comunidad autónoma (Baleares) y del Estado, porque cambia cada temporada.`,
    reviewedOn: "2026-08-17",
    source: "Resumen orientativo; verificar BOE / BOIB vigentes",
  },
  {
    id: "seg-mar",
    title: "Seguridad a bordo",
    category: "seguridad",
    species: [],
    modes: ["any"],
    tags: ["seguridad", "viento", "oleaje"],
    content: `Con viento sostenido por encima de 18-20 nudos o rachas superiores a 25, no salir en embarcación pequeña.
Corriente superior a 1,5 kn junto a cabos genera mar corta y peligrosa con viento en contra.
Comprobar siempre la previsión de las próximas 6 horas, no solo la actual, y tener zona de resguardo a barlovento.
Chalecos, VHF y aviso de la hora de regreso en tierra.`,
    reviewedOn: "2026-08-17",
  },
];

/** Palabras clave normalizadas de un texto (sin acentos, minúsculas). */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

