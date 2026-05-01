/**
 * epg.js — Grade de programação (EPG) para o TelaBrasil
 *
 * Formato XMLTV:
 *   <programme start="20240101120000 +0000" stop="20240101130000 +0000" channel="Globo.br">
 *     <title lang="pt">Jornal Nacional</title>
 *     <desc lang="pt">Principais notícias do Brasil...</desc>
 *     <category lang="pt">Jornalismo</category>
 *     <icon src="https://..." />
 *   </programme>
 *
 * Fontes EPG brasileiras públicas (XMLTV):
 *   1. iptv-org/epg  — EPG da comunidade, indexado por tvg-id
 *   2. Fallback local — grade gerada com programas típicos por faixa horária
 */

const express = require("express");
const axios = require("axios");
const NodeCache = require("node-cache");
const zlib = require("zlib");
const { XMLParser } = require("fast-xml-parser");

const router = express.Router();
const cache = new NodeCache({ stdTTL: 60 * 60 }); // 1 hora

// ── Fontes EPG (tentadas em ordem) ───────────────────────────────────────────
const EPG_SOURCES = [
  "https://epgshare01.online/epgshare01/epg_ripper_BR1.xml.gz",
  "https://iptv-org.github.io/epg/guides/br.xml",
  "https://raw.githubusercontent.com/iptv-org/epg/gh-pages/guides/br/programas.epg.xml.gz",
];

// ── Categorias → cores ────────────────────────────────────────────────────────
const CATEGORY_COLORS = {
  "jornalismo": "#3b82f6",   "news": "#3b82f6",     "notícias": "#3b82f6",
  "esporte": "#10b981",      "sports": "#10b981",   "futebol": "#10b981",
  "entretenimento": "#a855f7","entertainment": "#a855f7",
  "novela": "#ec4899",       "série": "#f59e0b",    "series": "#f59e0b",
  "filme": "#ef4444",        "movie": "#ef4444",    "cinema": "#ef4444",
  "infantil": "#84cc16",     "kids": "#84cc16",     "criança": "#84cc16",
  "documentário": "#06b6d4", "documentary": "#06b6d4",
  "religioso": "#f97316",    "música": "#6366f1",   "music": "#6366f1",
  "talk show": "#e879f9",    "variedades": "#e879f9",
};

function categoryColor(cat) {
  if (!cat) return "#475569";
  const key = cat.toLowerCase();
  for (const [k, v] of Object.entries(CATEGORY_COLORS)) {
    if (key.includes(k)) return v;
  }
  return "#475569";
}

// ── XMLTV Parser ──────────────────────────────────────────────────────────────
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  isArray: (name) => ["channel", "programme"].includes(name),
});

function parseXMLTV(xmlText) {
  let parsed;
  try {
    parsed = xmlParser.parse(xmlText);
  } catch (e) {
    throw new Error("XML inválido: " + e.message);
  }

  const tv = parsed.tv || {};
  const channels = {};
  const programs = {};

  // Index channels
  for (const ch of (tv.channel || [])) {
    const id = ch["@_id"];
    if (!id) continue;
    const displayName = Array.isArray(ch["display-name"])
      ? ch["display-name"][0]?.["#text"] || ch["display-name"][0]
      : ch["display-name"]?.["#text"] || ch["display-name"] || id;
    channels[id] = {
      id,
      name: typeof displayName === "string" ? displayName : String(displayName || id),
      icon: ch.icon?.["@_src"] || "",
    };
    programs[id] = [];
  }

  // Index programmes
  for (const prog of (tv.programme || [])) {
    const channelId = prog["@_channel"];
    if (!channelId) continue;

    const start = parseXMLTVDate(prog["@_start"]);
    const stop  = parseXMLTVDate(prog["@_stop"]);
    if (!start || !stop) continue;

    const title = extractText(prog.title);
    const desc  = extractText(prog.desc);
    const cat   = extractText(prog.category);
    const icon  = prog.icon?.["@_src"] || "";

    const program = { start, stop, title, desc, category: cat, icon, color: categoryColor(cat) };

    if (!programs[channelId]) programs[channelId] = [];
    programs[channelId].push(program);
  }

  // Sort programs by start time
  for (const id of Object.keys(programs)) {
    programs[id].sort((a, b) => a.start - b.start);
  }

  return { channels, programs };
}

function extractText(node) {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return extractText(node[0]);
  if (node["#text"]) return String(node["#text"]);
  return String(node);
}

function parseXMLTVDate(str) {
  if (!str) return null;
  // Format: "20240101120000 +0000" or "20240101120000 +0300"
  const match = str.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?/);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, tz = "+0000"] = match;
  const tzH = parseInt(tz.slice(0, 3));
  const tzM = parseInt(tz[0] + tz.slice(3));
  const utcMs = Date.UTC(+y, +mo - 1, +d, +h - tzH, +mi - tzM, +s);
  return new Date(utcMs);
}

// ── Fallback EPG ──────────────────────────────────────────────────────────────
// Quando nenhuma fonte externa estiver disponível, gera uma grade simulada
// com programas típicos de TV aberta brasileira por faixa horária.
const FALLBACK_SCHEDULE = [
  { start: [0, 0],  end: [5, 30],  title: "Madrugada",            category: "Variedades" },
  { start: [5, 30], end: [7, 0],   title: "Bom Dia (Manhã)",      category: "Jornalismo" },
  { start: [7, 0],  end: [8, 0],   title: "Café com Notícias",    category: "Jornalismo" },
  { start: [8, 0],  end: [10, 0],  title: "Programa Matinal",     category: "Entretenimento" },
  { start: [10, 0], end: [12, 0],  title: "Show do Meio Dia",     category: "Variedades" },
  { start: [12, 0], end: [13, 0],  title: "Jornal do Meio Dia",   category: "Jornalismo" },
  { start: [13, 0], end: [14, 0],  title: "Sessão da Tarde",      category: "Filme" },
  { start: [14, 0], end: [17, 0],  title: "Programa da Tarde",    category: "Entretenimento" },
  { start: [17, 0], end: [18, 0],  title: "Jornal da Tarde",      category: "Jornalismo" },
  { start: [18, 0], end: [19, 0],  title: "Novela das 18h",       category: "Novela" },
  { start: [19, 0], end: [20, 0],  title: "Jornal Nacional",      category: "Jornalismo" },
  { start: [20, 0], end: [21, 0],  title: "Novela das 20h",       category: "Novela" },
  { start: [21, 0], end: [22, 0],  title: "Novela das 21h",       category: "Novela" },
  { start: [22, 0], end: [23, 0],  title: "Jornal da Noite",      category: "Jornalismo" },
  { start: [23, 0], end: [24, 0],  title: "Programa Noturno",     category: "Entretenimento" },
];

function buildFallbackPrograms(channelName, dateStr) {
  const base = new Date(dateStr || new Date().toDateString());
  return FALLBACK_SCHEDULE.map(s => {
    const start = new Date(base);
    start.setHours(s.start[0], s.start[1], 0, 0);
    const stop = new Date(base);
    stop.setHours(s.end[0] === 24 ? 0 : s.end[0], s.end[1], 0, 0);
    if (s.end[0] === 24) stop.setDate(stop.getDate() + 1);
    return {
      start,
      stop,
      title: s.title,
      desc: `${s.title} — ${channelName}`,
      category: s.category,
      icon: "",
      color: categoryColor(s.category),
      isFallback: true,
    };
  });
}

// ── Fetch & Parse EPG ─────────────────────────────────────────────────────────
async function fetchEPG() {
  const cached = cache.get("epg");
  if (cached) return cached;

  console.log("[EPG] Buscando grade de programação...");

  for (const source of EPG_SOURCES) {
    try {
      const resp = await axios.get(source, {
        responseType: "arraybuffer",
        timeout: 20000,
        headers: { "User-Agent": "Mozilla/5.0 (TelaBrasil EPG)" },
      });

      let xmlText;
      if (source.endsWith(".gz")) {
        xmlText = zlib.gunzipSync(Buffer.from(resp.data)).toString("utf-8");
      } else {
        xmlText = Buffer.from(resp.data).toString("utf-8");
      }

      const result = parseXMLTV(xmlText);
      const count = Object.keys(result.programs).length;
      console.log(`[EPG] ✓ ${count} canais com programação carregados de ${source}`);
      cache.set("epg", result);
      return result;
    } catch (err) {
      console.warn(`[EPG] ✗ Falha em ${source}: ${err.message}`);
    }
  }

  // Todas as fontes falharam → retorna objeto vazio (fallback por canal)
  console.warn("[EPG] Usando fallback local (grade simulada)");
  return { channels: {}, programs: {} };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function getNowAndNext(programs, now = new Date()) {
  const nowMs = now.getTime();
  const current = programs.find(p => p.start <= nowMs && p.stop > nowMs);
  const upcoming = programs.filter(p => p.start > nowMs).slice(0, 5);
  return { current: current || null, upcoming };
}

function programToJSON(p) {
  if (!p) return null;
  return {
    title:    p.title,
    desc:     p.desc,
    category: p.category,
    icon:     p.icon,
    color:    p.color,
    start:    p.start instanceof Date ? p.start.toISOString() : p.start,
    stop:     p.stop  instanceof Date ? p.stop.toISOString()  : p.stop,
    durationMin: Math.round((p.stop - p.start) / 60000),
    isFallback: !!p.isFallback,
  };
}

function progressPercent(program, now = new Date()) {
  const total = program.stop - program.start;
  const elapsed = now - program.start;
  return Math.min(100, Math.max(0, Math.round((elapsed / total) * 100)));
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET /api/epg/now
 * Retorna o programa atual e o próximo para todos os canais
 * Query: ids=Globo.br,SBT.br,...  (filtra canais)
 */
router.get("/now", async (req, res) => {
  try {
    const epg = await fetchEPG();
    const now = new Date();
    const requestedIds = req.query.ids ? req.query.ids.split(",") : null;
    const ids = requestedIds || Object.keys(epg.programs);

    const result = {};
    for (const id of ids) {
      const programs = epg.programs[id];
      if (!programs || programs.length === 0) {
        // Fallback
        const fallback = buildFallbackPrograms(id, now.toDateString());
        const { current, upcoming } = getNowAndNext(fallback, now);
        result[id] = {
          current: current ? { ...programToJSON(current), progress: progressPercent(current, now) } : null,
          next: upcoming[0] ? programToJSON(upcoming[0]) : null,
        };
      } else {
        const { current, upcoming } = getNowAndNext(programs, now);
        result[id] = {
          current: current ? { ...programToJSON(current), progress: progressPercent(current, now) } : null,
          next: upcoming[0] ? programToJSON(upcoming[0]) : null,
        };
      }
    }

    res.json({ ts: now.toISOString(), channels: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/epg/channel/:id
 * Grade completa de um canal para o dia (ou data especificada)
 * Query: date=2024-01-15  (opcional, default=hoje)
 */
router.get("/channel/:id", async (req, res) => {
  try {
    const epg = await fetchEPG();
    const channelId = req.params.id;
    const date = req.query.date ? new Date(req.query.date) : new Date();
    const now = new Date();

    const dayStart = new Date(date);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(date);
    dayEnd.setHours(23, 59, 59, 999);

    let programs = (epg.programs[channelId] || []).filter(
      p => p.stop >= dayStart && p.start <= dayEnd
    );

    if (programs.length === 0) {
      programs = buildFallbackPrograms(channelId, date.toDateString());
    }

    const result = programs.map(p => ({
      ...programToJSON(p),
      isLive: p.start <= now && p.stop > now,
      progress: p.start <= now && p.stop > now ? progressPercent(p, now) : 0,
    }));

    res.json({
      channelId,
      date: date.toISOString().split("T")[0],
      totalPrograms: result.length,
      programs: result,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/epg/grid
 * Grade completa de todos os canais (ou lista filtrada)
 * Query:
 *   ids=Globo.br,SBT.br  (filtra canais)
 *   hours=6              (janela de horas a partir de agora, default=4)
 */
router.get("/grid", async (req, res) => {
  try {
    const epg = await fetchEPG();
    const now = new Date();
    const hours = parseInt(req.query.hours) || 4;
    const windowEnd = new Date(now.getTime() + hours * 60 * 60 * 1000);
    const windowStart = new Date(now.getTime() - 60 * 60 * 1000); // 1h atrás

    const requestedIds = req.query.ids ? req.query.ids.split(",") : null;
    const allIds = requestedIds || Object.keys(epg.programs).slice(0, 50); // máx 50

    const grid = [];
    for (const id of allIds) {
      let programs = (epg.programs[id] || []).filter(
        p => p.stop >= windowStart && p.start <= windowEnd
      );
      if (programs.length === 0) {
        programs = buildFallbackPrograms(id, now.toDateString()).filter(
          p => p.stop >= windowStart && p.start <= windowEnd
        );
      }
      if (programs.length === 0) continue;

      grid.push({
        channelId: id,
        channelName: epg.channels[id]?.name || id,
        channelIcon: epg.channels[id]?.icon || "",
        programs: programs.map(p => ({
          ...programToJSON(p),
          isLive: p.start <= now && p.stop > now,
          progress: p.start <= now && p.stop > now ? progressPercent(p, now) : 0,
        })),
      });
    }

    res.json({
      ts: now.toISOString(),
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      hours,
      channels: grid,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/epg/sources
 * Lista as fontes EPG configuradas e status do cache
 */
router.get("/sources", (req, res) => {
  const cached = cache.get("epg");
  res.json({
    sources: EPG_SOURCES,
    cached: !!cached,
    channelCount: cached ? Object.keys(cached.programs).length : 0,
    ttlSeconds: cache.getTtl("epg") ? Math.round((cache.getTtl("epg") - Date.now()) / 1000) : 0,
  });
});

/**
 * GET /api/epg/cache/clear
 */
router.get("/cache/clear", (req, res) => {
  cache.del("epg");
  res.json({ message: "Cache EPG limpo." });
});

module.exports = router;
