/**
 * websearch —— 多源聚合搜索。
 *
 * 为什么自己做一个：dsh 原生 web_search 走 DeepSeek 官方 API（余额不足就 402 全挂），
 * 而且用的是服务端搜索，我们控制不了搜哪些站点、搜多深。
 *
 * 这台机器没有代理，海外直连基本不通（实测 DuckDuckGo / Brave / SearX / Wikipedia 全超时）。
 * 能通的搜索源：
 *   Bing（RSS，中英都行，固定 10 条翻不了页）
 *   arXiv / CrossRef / PubMed（学术）
 *   Stack Overflow / HN Algolia（技术问答与讨论）
 *   npm / PyPI（包）
 * Mojeek / Sogou / Startpage 有 Captcha 或不通，不在列表里。
 *
 * 广度靠「多查询变体 + 多源合并」，不靠单源翻页。
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import {
  hasCJK,
  expandQueries,
  keywords,
  pickSources,
  isRelevant,
  dedupe,
  formatEmptyResult,
} from "./websearch-core.mjs";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const TIMEOUT_MS = 15000;

async function fetchText(url, { timeout = TIMEOUT_MS, headers = {} } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: { "user-agent": UA, accept: "*/*", ...headers },
      signal: ctrl.signal,
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function xmlTag(block, tag) {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  if (!m) return "";
  return m[1]
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Bing RSS：固定 10 条，count/first 参数实测无效。 */
async function bingRss(query, { lang = "both" } = {}) {
  const hosts =
    lang === "en" ? ["www.bing.com"] : lang === "zh" ? ["cn.bing.com"] : ["www.bing.com", "cn.bing.com"];
  const out = [];
  for (const host of hosts) {
    const url = `https://${host}/search?q=${encodeURIComponent(query)}&format=rss`;
    try {
      const xml = await fetchText(url);
      const items = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
      for (const it of items) {
        const link = xmlTag(it, "link");
        if (!link) continue;
        out.push({
          source: host === "cn.bing.com" ? "bing-zh" : "bing",
          title: xmlTag(it, "title"),
          url: link,
          snippet: xmlTag(it, "description").slice(0, 300),
        });
      }
    } catch {
      /* 这个 host 不通就跳 */
    }
  }
  return out;
}

async function arxiv(query, limit) {
  const url = `http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&max_results=${limit}&sortBy=relevance`;
  try {
    const xml = await fetchText(url);
    return (xml.match(/<entry>[\s\S]*?<\/entry>/g) || []).map((e) => ({
      source: "arxiv",
      title: xmlTag(e, "title"),
      url: xmlTag(e, "id"),
      snippet: xmlTag(e, "summary").slice(0, 320),
      published: xmlTag(e, "published").slice(0, 10),
    }));
  } catch {
    return [];
  }
}

async function crossref(query, limit) {
  const url = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${limit}&select=title,URL,abstract,issued`;
  try {
    const j = JSON.parse(await fetchText(url, { headers: { accept: "application/json" } }));
    return (j.message?.items || []).map((it) => ({
      source: "crossref",
      title: (it.title && it.title[0]) || "(无标题)",
      url: it.URL || "",
      snippet: (it.abstract || "").replace(/<[^>]+>/g, "").slice(0, 300),
      published: it.issued?.["date-parts"]?.[0]?.join("-") || "",
    }));
  } catch {
    return [];
  }
}

async function pubmed(query, limit) {
  try {
    const ids = await fetchText(
      `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(query)}&retmax=${limit}&retmode=json`,
      { headers: { accept: "application/json" } },
    );
    const idList = JSON.parse(ids).esearchresult?.idlist || [];
    if (!idList.length) return [];
    const sum = await fetchText(
      `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${idList.join(",")}&retmode=json`,
      { headers: { accept: "application/json" } },
    );
    const res = JSON.parse(sum).result || {};
    return idList.map((id) => {
      const r = res[id] || {};
      return {
        source: "pubmed",
        title: r.title || "",
        url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
        snippet: (r.source || "") + (r.pubdate ? " · " + r.pubdate : ""),
        published: r.pubdate || "",
      };
    });
  } catch {
    return [];
  }
}

async function stackoverflow(query, limit) {
  const url = `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=relevance&q=${encodeURIComponent(query)}&site=stackoverflow&pagesize=${limit}&filter=default`;
  try {
    const j = JSON.parse(await fetchText(url, { headers: { accept: "application/json" } }));
    return (j.items || []).map((it) => ({
      source: "stackoverflow",
      title: it.title || "",
      url: it.link || "",
      snippet:
        (it.is_answered ? "已回答" : "未回答") +
        ` · 评分 ${it.score} · ${it.answer_count || 0} 个回答` +
        (it.tags ? " · " + it.tags.slice(0, 5).join(",") : ""),
      published: it.creation_date ? new Date(it.creation_date * 1000).toISOString().slice(0, 10) : "",
    }));
  } catch {
    return [];
  }
}

async function hn(query, limit) {
  const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&hitsPerPage=${limit}`;
  try {
    const j = JSON.parse(await fetchText(url, { headers: { accept: "application/json" } }));
    return (j.hits || [])
      .filter((h) => h.title || h.story_title)
      .map((h) => ({
        source: "hackernews",
        title: h.title || h.story_title || "",
        url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
        snippet: `HN 讨论 · ${h.points || 0} 分 · ${h.num_comments || 0} 评论`,
        published: h.created_at ? h.created_at.slice(0, 10) : "",
      }));
  } catch {
    return [];
  }
}

/** 通用 JSON API 源（npm / PyPI）：只用来判断"这东西存不存在" */
async function packageLookup(query) {
  const out = [];
  const name = query.trim().split(/\s+/)[0];
  if (!/^[@a-z0-9._/-]{2,80}$/i.test(name)) return out;
  try {
    const j = JSON.parse(await fetchText(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
      headers: { accept: "application/json" },
      timeout: 8000,
    }));
    if (j.name) {
      out.push({
        source: "npm",
        title: `${j.name}@${j["dist-tags"]?.latest || "?"}`,
        url: `https://www.npmjs.com/package/${j.name}`,
        snippet: (j.description || "").slice(0, 200),
      });
    }
  } catch {
    /* 没有就算了 */
  }
  return out;
}

export function buildWebSearchTool(ctx) {
  return defineTool({
    name: "websearch",
    description:
      "多源联网搜索。覆盖 Bing（中英）、arXiv、CrossRef、PubMed、Stack Overflow、Hacker News、npm。" +
      "适合查资料、找讨论与评价、确认某项目/论文是否存在。返回结构化结果（标题/链接/摘要/来源/跨源命中）。" +
      "注意：本机无代理，海外站点直连不通，能用的就这几家；结果需要你自己过滤判断，工具不做质量排序。",
    parameters: {
      query: { type: "string", required: true, description: "搜索词" },
      queries: {
        type: "array",
        items: { type: "string" },
        description: "额外查询变体。不给就按 lang 自动扩（review/comparison/评价/讨论）",
      },
      sources: {
        type: "array",
        items: { type: "string" },
        description: "限定源：bing / bing-zh / arxiv / crossref / pubmed / stackoverflow / hackernews / npm。默认全开",
      },
      lang: {
        type: "string",
        enum: ["zh", "en", "both"],
        description: "语言倾向，默认 both（中英各搜一遍）",
      },
      limit: { type: "number", description: "每个 API 源返回条数，默认 5" },
      autoExpand: { type: "boolean", description: "是否自动扩查询变体，默认 true" },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean", required: true },
          text: { type: "string", required: true },
        },
      },
      render: (_a, v) => [{ type: "text", text: v.text }],
    },
    async execute(args) {
      const q = String(args.query || "").trim();
      if (!q) return { ok: false, text: "给个查询词" };

      const lang = args.lang || "both";
      const limit = Math.max(1, Math.min(20, args.limit ?? 5));
      const autoExpand = args.autoExpand !== false;

      const queries = [
        ...new Set([
          q,
          ...(Array.isArray(args.queries) ? args.queries.map((s) => String(s).trim()).filter(Boolean) : []),
          ...(autoExpand ? expandQueries(q, lang).slice(1) : []),
        ]),
      ].slice(0, 6);

      const sources = pickSources(q, args.sources);
      const all = sources;

      // 并发跑，但控制在 4 个以内 —— 这些站对并发敏感，打太狠会被拦
      const tasks = [];
      // 英文社区/学术 API 全文匹配，整句一定搜空，先用瘦身后的关键词
      const kw = keywords(q);
      const hasEnglish = kw.length > 0;

      for (const query of queries) {
        if (all.has("bing") || all.has("bing-zh")) {
          tasks.push(bingRss(query, { lang }));
        }
        // 学术/技术源只在第一个查询上跑，避免重复轰炸
        if (query === queries[0]) {
          if (hasEnglish) {
            if (all.has("arxiv")) tasks.push(arxiv(kw, limit));
            if (all.has("crossref")) tasks.push(crossref(kw, limit));
            if (all.has("stackoverflow")) tasks.push(stackoverflow(kw, limit));
            if (all.has("hackernews")) tasks.push(hn(kw, limit));
            // PubMed 只认英文：中文查询实测 0 条，别浪费一次往返
            if (all.has("pubmed") && !hasCJK(q)) tasks.push(pubmed(kw, limit));
          }
          if (all.has("npm") && hasEnglish) tasks.push(packageLookup(kw));
        }
      }

      const collected = [];
      const errors = [];
      const CONCURRENCY = 4;
      for (let i = 0; i < tasks.length; i += CONCURRENCY) {
        const batch = tasks.slice(i, i + CONCURRENCY);
        const settled = await Promise.allSettled(batch);
        for (const r of settled) {
          if (r.status === "fulfilled" && Array.isArray(r.value)) collected.push(...r.value);
          else if (r.status === "rejected") errors.push(String(r.reason?.message || r.reason));
        }
      }

      const kwList = kw ? kw.split(/\s+/) : [];
      const relevant = collected.filter((it) => isRelevant(it, kwList));
      const dropped = collected.length - relevant.length;
      const items = dedupe(relevant);

      // 排序：Bing 在前的优先（它自己做相关性排序），其次跨源命中，再次摘要长度
      const sourceRank = (s) => (s.startsWith("bing") ? 0 : s === "stackoverflow" || s === "hackernews" ? 1 : 2);
      items.sort((a, b) => {
        const sr = sourceRank(a.source) - sourceRank(b.source);
        if (sr) return sr;
        const cross = b.also.length - a.also.length;
        if (cross) return cross;
        return (b.snippet || "").length - (a.snippet || "").length;
      });

      if (!items.length) {
        return formatEmptyResult(q, errors);
      }

      const lines = [];
      lines.push(`「${q}」共 ${items.length} 条（去重后），查询变体 ${queries.length} 个${kw ? `，关键词「${kw}」` : ""}`);
      const bySource = {};
      for (const it of items) bySource[it.source] = (bySource[it.source] || 0) + 1;
      lines.push("来源分布：" + Object.entries(bySource).map(([k, v]) => `${k}:${v}`).join("  "));
      if (dropped > 0) lines.push(`已滤掉 ${dropped} 条不相关（关键词未命中）`);
      lines.push("");

      const MAX_SHOW = 40;
      for (const [i, it] of items.slice(0, MAX_SHOW).entries()) {
        const cross = it.also.length ? ` [+${it.also.join(",")}]` : "";
        lines.push(`${i + 1}. [${it.source}${cross}] ${it.title}`);
        lines.push(`   ${it.url}`);
        if (it.published) lines.push(`   ${it.published}`);
        if (it.snippet) lines.push(`   ${it.snippet}`);
        lines.push("");
      }
      if (items.length > MAX_SHOW) lines.push(`… 还有 ${items.length - MAX_SHOW} 条未显示`);

      return { ok: true, text: lines.join("\n") };
    },
    presentCall: (a) => ({
      card: "generic",
      title: `websearch ${String(a.query).slice(0, 30)}`,
      kind: "read",
      rawInput: a.query,
    }),
  });
}
