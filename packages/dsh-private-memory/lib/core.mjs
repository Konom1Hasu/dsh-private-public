import { createHash } from "node:crypto";

/**
 * workspace → 库文件名的哈希。
 * 必须先归一化分隔符、合并连续斜杠、去尾斜杠、转小写再 hash，
 * 避免同一个 workspace 因为写法差异裂成多个库。
 */
export function projectKey(cwd) {
  const norm = String(cwd || ".")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
  return createHash("sha1").update(norm).digest("hex").slice(0, 12);
}

/**
 * 先排序再去重：让当前库（__cur = true）先入表，去重时才能保留当前库那条，
 * 避免自家记录被标成「← 来自其他 workspace」。
 */
export function rankAndDedupe(collected, limit = 10) {
  const sorted = [...collected].sort((a, b) => (b.__cur - a.__cur) || (b.hits - a.hits));
  const seen = new Set();
  const unique = [];
  for (const r of sorted) {
    const sig = [
      String(r.project || ""),
      String(r.title || ""),
      String(r.body || "").slice(0, 120),
    ].join("\u0001");
    if (seen.has(sig)) continue;
    seen.add(sig);
    unique.push(r);
  }
  return unique.slice(0, limit);
}

/** trigram 分词器要求查询至少 3 个字符（按码点计，防代理对误算）。 */
export function shouldUseFts(query) {
  return [...String(query || "").trim()].length >= 3;
}
