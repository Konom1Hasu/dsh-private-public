/**
 * websearch 纯逻辑层：查询扩展、关键词瘦身、源选择、相关性过滤、去重、排序与空结果语义。
 * 抽成独立模块以便在不触网的情况下做回归测试。
 */

export const CJK = /[\u4e00-\u9fff]/;
export const hasCJK = (s) => CJK.test(s);

/** 针对「找评论/评价」自动扩查询变体。 */
export function expandQueries(query, lang) {
  const q = String(query || "").trim();
  if (!q) return [];
  const out = [q];
  const has = (s) => q.toLowerCase().includes(s);
  if (lang !== "zh") {
    if (!has("review") && !has("評") && !has("测")) {
      out.push(`${q} review`);
      out.push(`${q} vs alternative comparison`);
    }
    if (!has("reddit") && !has("hacker news")) out.push(`${q} reddit discussion`);
  }
  if (lang !== "en") {
    if (!has("评价") && !has("怎么样") && !has("值得")) out.push(`${q} 评价 优缺点`);
  }
  return [...new Set(out)].slice(0, 5);
}

const STOP = new Set([
  "vs", "versus", "and", "or", "the", "a", "an", "of", "for", "with", "in", "on", "to",
  "how", "what", "why", "which", "is", "are", "do", "does", "can", "best", "good",
  "performance", "benchmark", "comparison", "compare", "review", "discussion",
  "alternative", "alternatives", "recommend", "should", "use", "using", "about",
]);

/** 提取英文关键词（全文匹配 API 需先瘦身，最多取 max 个词）。 */
export function keywords(query, max = 3) {
  const words = String(query || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#.\-\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w) && !CJK.test(w));
  const picked = words.slice(0, max);
  return picked.length ? picked.join(" ") : "";
}

/** 领域判定：决定该跑哪些专用源，避免 PubMed 去搜 Rust 这种噪音。 */
export function pickSources(query, explicit) {
  if (Array.isArray(explicit) && explicit.length) return new Set(explicit);

  const q = String(query || "").toLowerCase();
  const set = new Set(["bing"]);

  const cjk = hasCJK(query);
  const englishish = !cjk || /[a-z]{3,}/i.test(query);
  if (englishish) {
    set.add("stackoverflow");
    set.add("hackernews");
  }

  const medical = /病|症|药|临床|治疗|癌|免疫|disease|syndrome|therapy|cancer|clinical|pathogen|vaccine|protein|gene/i.test(q);
  const academic = /论文|研究|综述|paper|study|survey|preprint|arxiv|文献/i.test(q);

  if (!medical && englishish) set.add("npm");

  if (medical) {
    set.add("pubmed");
    set.add("crossref");
  }
  if (academic) {
    set.add("arxiv");
    set.add("crossref");
  }
  if (!medical && !academic && englishish && /^[\x00-\x7f\s]+$/.test(query) && query.trim().split(/\s+/).length >= 2) {
    set.add("arxiv");
  }
  return set;
}

/** 相关性过滤：关键词瘦身后丢掉泛泛的噪音结果（Bing 自身排序保留）。 */
export function isRelevant(item, kwList) {
  if (!kwList || !kwList.length) return true;
  if (item.source && item.source.startsWith("bing")) return true;
  const text = `${item.title || ""} ${item.snippet || ""} ${item.url || ""}`.toLowerCase();
  return kwList.some((k) => k.length > 2 && text.includes(k));
}

/** 去重：按 URL 归一化，保留更长摘要并记录跨源命中。 */
export function dedupe(items) {
  const seen = new Map();
  for (const it of items) {
    if (!it || !it.url) continue;
    const key = it.url
      .replace(/^https?:\/\//i, "")
      .replace(/^www\./i, "")
      .replace(/[?#].*$/, "")
      .replace(/\/+$/, "")
      .toLowerCase();
    const prev = seen.get(key);
    if (!prev) {
      seen.set(key, { ...it, also: [] });
    } else {
      if ((it.snippet || "").length > (prev.snippet || "").length) {
        seen.set(key, { ...it, also: [...prev.also, prev.source] });
      } else {
        prev.also.push(it.source);
      }
    }
  }
  return [...seen.values()].map((it) => ({
    ...it,
    also: [...new Set(it.also)].filter((s) => s !== it.source),
  }));
}

/**
 * 空结果语义判定：
 * - 所有源都正常返回空（errors 为空）：ok = true，属于「正常空结果」而非源故障
 * - 有源报错且最终无结果：ok = false，暴露错误信息
 */
export function formatEmptyResult(query, errors) {
  const hasErr = Array.isArray(errors) && errors.length > 0;
  return {
    ok: !hasErr,
    text:
      `没有搜到「${query}」的结果。\n` +
      (hasErr ? `错误：${[...new Set(errors)].slice(0, 3).join("; ")}` : "所有源都返回空"),
  };
}
