import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  expandQueries,
  keywords,
  pickSources,
  isRelevant,
  dedupe,
  formatEmptyResult,
} from "../lib/websearch-core.mjs";

describe("keywords：英文全文 API 瘦身", () => {
  it("去掉停用词与中文，最多保留 3 个关键词", () => {
    assert.equal(keywords("tokio vs async-std performance benchmark"), "tokio async-std");
  });

  it("纯中文返回空串，避免打英文学术/社区源", () => {
    assert.equal(keywords("阿尔茨海默病 早期诊断"), "");
  });

  it("超长查询截断到 max 词数", () => {
    assert.equal(keywords("rust tokio hyper tower tonic axum", 3), "rust tokio hyper");
  });
});

describe("expandQueries：多语种查询扩展", () => {
  it("both 模式同时扩中英文评价变体且去重", () => {
    const qs = expandQueries("sqlite", "both");
    assert.ok(qs.includes("sqlite"));
    assert.ok(qs.some((q) => q.includes("review")));
    assert.ok(qs.some((q) => q.includes("评价")));
    assert.ok(qs.length <= 5);
  });

  it("zh 模式不扩英文 review 变体", () => {
    const qs = expandQueries("播放器", "zh");
    assert.ok(!qs.some((q) => q.includes("review")));
    assert.ok(qs.some((q) => q.includes("评价")));
  });

  it("空串返回空数组", () => {
    assert.deepEqual(expandQueries("   ", "both"), []);
  });
});

describe("pickSources：领域选源与降噪", () => {
  it("医学查询不带 npm，带 pubmed 和 crossref", () => {
    const s = pickSources("alzheimer disease early diagnosis");
    assert.ok(s.has("pubmed"));
    assert.ok(s.has("crossref"));
    assert.ok(!s.has("npm"));
  });

  it("纯中文查询不带 stackoverflow/hackernews/npm", () => {
    const s = pickSources("数据库性能优化");
    assert.ok(s.has("bing"));
    assert.ok(!s.has("stackoverflow"));
    assert.ok(!s.has("hackernews"));
    assert.ok(!s.has("npm"));
  });

  it("显式指定 sources 时原样采用", () => {
    const s = pickSources("rust", ["bing", "arxiv"]);
    assert.deepEqual([...s], ["bing", "arxiv"]);
  });
});

describe("isRelevant：相关性过滤", () => {
  it("Bing 结果直接放行", () => {
    assert.equal(
      isRelevant({ source: "bing", title: "无关标题", url: "https://a.com" }, ["tokio"]),
      true,
    );
  });

  it("学术/社区噪音（关键词均未命中）被滤掉", () => {
    assert.equal(
      isRelevant(
        { source: "arxiv", title: "Limits and Singularities of Normal Functions", snippet: "", url: "" },
        ["tokio", "async-std"],
      ),
      false,
    );
  });

  it("标题或摘要命中关键词即保留", () => {
    assert.equal(
      isRelevant(
        { source: "hackernews", title: "Async Rust with Tokio", snippet: "", url: "" },
        ["tokio"],
      ),
      true,
    );
  });
});

describe("dedupe：URL 归一化与跨源标记", () => {
  it("同 URL（含 http/https/www/query/尾部斜杠差异）合并，保留更长摘要", () => {
    const res = dedupe([
      { source: "bing", title: "A", url: "http://www.example.com/post/?utm=1", snippet: "短" },
      { source: "bing-zh", title: "A", url: "https://example.com/post", snippet: "这是一段更长的摘要内容" },
    ]);
    assert.equal(res.length, 1);
    assert.equal(res[0].source, "bing-zh");
    assert.equal(res[0].snippet, "这是一段更长的摘要内容");
    assert.deepEqual(res[0].also, ["bing"]);
  });

  it("缺少 url 的条目被忽略", () => {
    assert.equal(dedupe([{ source: "bing", title: "no url" }]).length, 0);
  });
});

describe("formatEmptyResult：空结果与错误语义分离", () => {
  it("所有源正常返回空时 ok 为 true，不误触发降级熔断", () => {
    const r = formatEmptyResult("不存在的词", []);
    assert.equal(r.ok, true);
    assert.match(r.text, /所有源都返回空/);
  });

  it("存在源报错且无结果时 ok 为 false，并输出错误信息", () => {
    const r = formatEmptyResult("tokio", ["HTTP 502", "HTTP 502", "Timeout"]);
    assert.equal(r.ok, false);
    assert.match(r.text, /HTTP 502; Timeout/);
  });
});
