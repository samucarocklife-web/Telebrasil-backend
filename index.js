require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const NodeCache = require("node-cache");
const { createProxyMiddleware } = require("http-proxy-middleware");
const url = require("url");

const app = express();
const cache = new NodeCache({ stdTTL: parseInt(process.env.CACHE_TTL_SECONDS) || 900 });

const PORT = process.env.PORT || 3001;
const M3U_URL = process.env.M3U_BR_URL || "https://iptv-org.github.io/iptv/countries/br.m3u";

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: (origin, cb) => {
    const allowed = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim());
    if (!origin || allowed.includes(origin) || allowed.includes("*")) return cb(null, true);
    cb(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "OPTIONS"],
}));
app.use(express.json());

// ── M3U Parser ────────────────────────────────────────────────────────────────
function parseM3U(text) {
  const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
  const channels = [];
  let current = null;

  for (const line of lines) {
    if (line.startsWith("#EXTINF")) {
      const name   = (line.match(/,(.+)$/)              || [])[1]?.trim() || "Canal";
      const logo   = (line.match(/tvg-logo="([^"]*)"/)  || [])[1] || "";
      const group  = (line.match(/group-title="([^"]*)"/) || [])[1] || "Geral";
      const id     = (line.match(/tvg-id="([^"]*)"/)    || [])[1] || "";
      const lang   = (line.match(/tvg-language="([^"]*)"/) || [])[1] || "";
      current = { id, name, logo, group, lang, stream: "" };
    } else if (current && !line.startsWith("#")) {
      current.stream = line;
      channels.push(current);
      current = null;
    }
  }
  return channels;
}

// ── State detector ────────────────────────────────────────────────────────────
const STATE_MAP = {
  AC: ["acre"],
  AL: ["alagoas"],
  AM: ["amazonas"],
  AP: ["amapá","amapa"],
  BA: ["bahia","salvador"],
  CE: ["ceará","ceara","fortaleza"],
  DF: ["distrito federal","brasília","brasilia"],
  ES: ["espírito santo","espirito santo","vitória"],
  GO: ["goiás","goias","goiania","goiânia"],
  MA: ["maranhão","maranhao","são luís","sao luis"],
  MG: ["minas gerais","belo horizonte"],
  MS: ["mato grosso do sul","campo grande"],
  MT: ["mato grosso","cuiabá"],
  PA: ["pará","para","belém","belem"],
  PB: ["paraíba","paraiba","joão pessoa"],
  PE: ["pernambuco","recife"],
  PI: ["piauí","piaui","teresina"],
  PR: ["paraná","parana","curitiba"],
  RJ: ["rio de janeiro","carioca"],
  RN: ["rio grande do norte","natal"],
  RO: ["rondônia","rondonia","porto velho"],
  RR: ["roraima","boa vista"],
  RS: ["rio grande do sul","porto alegre","gaúcho","gaucho"],
  SC: ["santa catarina","florianópolis","florianopolis"],
  SE: ["sergipe","aracaju"],
  SP: ["são paulo","sao paulo","paulista","paulistano"],
  TO: ["tocantins","palmas"],
};

function detectState(name, group) {
  const text = (name + " " + group).toLowerCase();
  for (const [state, keywords] of Object.entries(STATE_MAP)) {
    if (keywords.some(k => text.includes(k))) return state;
  }
  return "Nacional";
}

// ── Routes ────────────────────────────────────────────────────────────────────

/**
 * GET /api/health
 * Health check
 */
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", cached: !!cache.get("channels"), ts: new Date().toISOString() });
});

/**
 * GET /api/channels
 * Retorna todos os canais brasileiros parseados do iptv-org
 * Query params:
 *   state=SP       filtra por estado
 *   group=News     filtra por categoria
 *   q=globo        busca por nome
 *   limit=50       limita resultados
 */
app.get("/api/channels", async (req, res) => {
  try {
    let channels = cache.get("channels");

    if (!channels) {
      console.log("[M3U] Buscando lista do iptv-org...");
      const { data } = await axios.get(M3U_URL, { timeout: 15000 });
      const parsed = parseM3U(data);
      channels = parsed.map(ch => ({
        ...ch,
        state: detectState(ch.name, ch.group),
      }));
      cache.set("channels", channels);
      console.log(`[M3U] ${channels.length} canais carregados e cacheados.`);
    }

    let result = [...channels];

    if (req.query.state && req.query.state !== "Todos")
      result = result.filter(c => c.state === req.query.state);

    if (req.query.group && req.query.group !== "Todos")
      result = result.filter(c => c.group === req.query.group);

    if (req.query.q)
      result = result.filter(c => c.name.toLowerCase().includes(req.query.q.toLowerCase()));

    if (req.query.limit)
      result = result.slice(0, parseInt(req.query.limit));

    res.json({
      total: channels.length,
      filtered: result.length,
      channels: result,
    });
  } catch (err) {
    console.error("[channels]", err.message);
    res.status(500).json({ error: "Falha ao carregar lista de canais.", detail: err.message });
  }
});

/**
 * GET /api/channels/states
 * Retorna lista de estados disponíveis com contagem de canais
 */
app.get("/api/channels/states", async (req, res) => {
  try {
    let channels = cache.get("channels");
    if (!channels) {
      const { data } = await axios.get(M3U_URL, { timeout: 15000 });
      channels = parseM3U(data).map(ch => ({ ...ch, state: detectState(ch.name, ch.group) }));
      cache.set("channels", channels);
    }
    const states = {};
    for (const ch of channels) {
      states[ch.state] = (states[ch.state] || 0) + 1;
    }
    const sorted = Object.entries(states)
      .sort((a, b) => b[1] - a[1])
      .map(([state, count]) => ({ state, count }));
    res.json(sorted);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/channels/groups
 * Retorna categorias disponíveis com contagem
 */
app.get("/api/channels/groups", async (req, res) => {
  try {
    let channels = cache.get("channels");
    if (!channels) {
      const { data } = await axios.get(M3U_URL, { timeout: 15000 });
      channels = parseM3U(data).map(ch => ({ ...ch, state: detectState(ch.name, ch.group) }));
      cache.set("channels", channels);
    }
    const groups = {};
    for (const ch of channels) {
      groups[ch.group] = (groups[ch.group] || 0) + 1;
    }
    res.json(Object.entries(groups).sort((a, b) => b[1] - a[1]).map(([group, count]) => ({ group, count })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/cache/clear
 * Limpa o cache (útil para forçar re-fetch da lista)
 */
app.get("/api/cache/clear", (req, res) => {
  cache.flushAll();
  res.json({ message: "Cache limpo com sucesso." });
});

// ── Stream Proxy ──────────────────────────────────────────────────────────────
/**
 * GET /proxy/stream?url=https://...
 * Faz proxy de qualquer stream HLS ou MPEG-TS,
 * adicionando os headers CORS necessários.
 * Também reescreve URLs dentro de playlists .m3u8
 * para manter o proxy em segmentos filhos.
 */
app.get("/proxy/stream", async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).json({ error: "Parâmetro 'url' obrigatório." });

  try {
    const response = await axios.get(targetUrl, {
      responseType: "stream",
      timeout: 20000,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; TelaBrasil/1.0)",
        "Referer": new url.URL(targetUrl).origin,
      },
    });

    const contentType = response.headers["content-type"] || "";
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Content-Type", contentType);

    // Se for uma playlist M3U8, reescreve as URLs dos segmentos
    if (
      contentType.includes("mpegurl") ||
      contentType.includes("x-mpegurl") ||
      targetUrl.includes(".m3u8")
    ) {
      let body = "";
      response.data.on("data", chunk => (body += chunk));
      response.data.on("end", () => {
        const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf("/") + 1);
        const rewritten = body
          .split("\n")
          .map(line => {
            line = line.trim();
            if (!line || line.startsWith("#")) return line;
            // URL absoluta
            if (line.startsWith("http")) return `/proxy/stream?url=${encodeURIComponent(line)}`;
            // URL relativa
            return `/proxy/stream?url=${encodeURIComponent(baseUrl + line)}`;
          })
          .join("\n");
        res.send(rewritten);
      });
    } else {
      // Para segmentos .ts e outros binários, só repassa o stream
      response.data.pipe(res);
    }
  } catch (err) {
    console.error("[proxy/stream]", err.message);
    res.status(502).json({ error: "Falha ao buscar stream.", detail: err.message });
  }
});

// ── EPG Routes ────────────────────────────────────────────────────────────────
const epgRouter = require("./epg");
app.use("/api/epg", epgRouter);

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 TelaBrasil Backend rodando em http://localhost:${PORT}`);
  console.log(`\nEndpoints disponíveis:`);
  console.log(`  GET /api/health`);
  console.log(`  GET /api/channels?state=SP&q=globo&limit=20`);
  console.log(`  GET /api/channels/states`);
  console.log(`  GET /api/channels/groups`);
  console.log(`  GET /proxy/stream?url=<stream_url>`);
  console.log(`  GET /api/cache/clear`);
  console.log(`  GET /api/epg/now              → programas ao vivo agora`);
  console.log(`  GET /api/epg/channel/:id      → grade de um canal`);
  console.log(`  GET /api/epg/grid             → grade completa (todos canais)\n`);
});
