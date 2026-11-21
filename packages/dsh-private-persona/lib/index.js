import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { parseLayers, pick, strip, splitTerms, composeLayers, composeAnchor, decideAnchorInjection } from "./core.mjs";

/**
 * @yg/dsh-private-persona
 *
 * 人格系统：把 personas/*.md 里的定义注入系统提示，并支持运行时切换。
 *
 * 设计立场
 * ────────
 * 1. 人格不写成形容词（"毒舌""温柔"只会让模型演刻板印象），而写成
 *    **行为规则 + 示例对话**。示例的权重远高于描述。
 * 2. 切换必须运行时生效，不能靠重启——所以 section 是可 dispose 的，
 *    tool 切换时先卸载旧的再挂新的。
 * 3. 当前人格存在 personas/active.txt 一行里，便于外部（脚本、别的工具）读写。
 *
 * @module @yg/dsh-private-persona
 */

const name = "private-persona";
const inject = ["tools", "systemPrompt", "webServer"];

const Config = z.object({
  /** 人格文件目录 */
  personaDir: z.string().default("C:\\Users\\KonomiHasu\\dsh-private\\personas"),
  /** 默认人格（active.txt 不存在时用） */
  defaultPersona: z.string().default("lcs"),
  /**
   * section 排序位。
   *
   * dsh 的 SECTION_ORDERS 是：DELIVERABLE_FILE_REFERENCES=9000、STRUCTURED_OUTPUT=9900、
   * HARNESS_SOURCE=10000、WEB_SURFACE=10100、DEPLOYMENT_PERSONA_SUFFIX=10200。
   * 原来默认 9500 —— 风格段后面还跟了 700 多字（结构化输出、源码引用、web 表面），
   * 而 purge 灌的那 13000 字规则在位置 0。人格被淹没，改了也看不出效果。
   * 现在贴到 WEB_SURFACE 之后、PERSONA_SUFFIX 之前，让它是最后几段之一。
   */
  order: z.number().default(10150),
  /**
   * 防衰减：每隔多少个用户回合，往会话里重注入一次人格锚点。
   * 0 = 关闭。system prompt 只在一轮开始时读一次，长对话后半段
   * 人格会被历史越冲越淡，靠这个周期补锚点把它拽回来。
   */
  anchorIntervalTurns: z.number().default(3),
  /** 单次锚点正文上限（字符）。给得太长就变成第二份人格，反而稀释。 */
  anchorMaxChars: z.number().default(380),
});

/** 去掉 frontmatter，返回正文。 */
function stripFrontmatter(md) {
  const m = md.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m ? md.slice(m[0].length).trim() : md.trim();
}

/** 读 frontmatter 里的 name/display，失败返回空对象。 */
function readFrontmatter(md) {
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

function apply(ctx, config) {
  const dir = config.personaDir;
  const activeFile = join(dir, "active.txt");

  /**
   * 每层的字数预算。超了截断并打日志，不静默塞。
   * 数值参考 AIPlatform 的档案预算，按 dsh 的上下文规模缩了一档。
   */
  const budget = config.budget && typeof config.budget === "object"
    ? config.budget
    : {
        identity: 1100,
        relationship: 500,
        personality: 500,
        voice: 1300,
        tells: 500,
        boundary: 600,
        distance: 400,
        register: 500,
        scene: 700,
        report: 1000,
      };

  /** 当前挂载的 section disposer */
  let disposeSection = null;
  let currentName = "";
  /** 已挂载的人格正文，tool 读它判断是否需要重挂 */
  let currentText = "";
  /** 已挂载人格的分层结果，锚点重注入直接用它，避免每回合重新解析 */
  let currentLayers = null;
  /** session 对象 → { turn, persona, consecForced }：上次锚点注入的回合与人格 */
  const anchorState = new WeakMap();
  let deriveWarned = false;

  /**
   * 从 session 取出最近一条含非空文本的 assistant 回复（拼接该条内所有 text 块）。
   * 仅同步读取 deriveMessages()，不修改深冻结对象。
   */
  function extractLastAssistantText(session) {
    if (!session) return "";
    try {
      const msgs = session.deriveMessages();
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (!m || m.role !== "assistant" || !Array.isArray(m.content)) continue;
        const text = m.content
          .filter((p) => p && p.type === "text" && typeof p.text === "string")
          .map((p) => p.text)
          .join("\n")
          .trim();
        if (text) return text;
      }
    } catch (e) {
      if (!deriveWarned) {
        deriveWarned = true;
        console.error("[private-persona] deriveMessages 读取失败，自适应校准已降级：", e?.message || e);
      }
    }
    return "";
  }

  /**
   * 高置信漂移检测（只抓真正病灶，不因原生大标题/长篇幅误伤）：
   * 仅返回类别名（不回显禁词，避免白熊效应）。
   */
  function detectHighConfidenceDrift(text, layers) {
    if (!text || !layers) return [];
    const prose = String(text).replace(/```[\s\S]*?```/g, "");
    const res = assessText(text, layers);
    const cats = [];
    for (const c of res.checks) {
      if (c.pass) continue;
      if (c.id === "avoid") cats.push("禁区词");
      else if (c.id === "ai-smell") cats.push("AI腔");
      else if (c.id === "leak") cats.push("照搬样本");
    }
    // 结构面只抓周报条目卡与公文汇报头，放行合法的 ##/### 原生大标题
    const boldListCount = (prose.match(/^\s*(?:[-*]|\d+[.、])\s+\*\*[^*]+\*\*\s*[:：]/gm) || []).length;
    const reportHeadCount = (prose.match(/^\s*(?:#{2,6}\s+|[-*]\s+)?\*{0,2}(?:根因|改动|验证|下一步|影响面|风险|结论|总结)\*{0,2}(?:\s*[:：]|\s*$)/gm) || []).length;
    if (boldListCount >= 3 || reportHeadCount >= 2) cats.push("周报条目卡");
    return cats;
  }

  async function readActive() {
    try {
      const raw = await readFile(activeFile, "utf8");
      const n = raw.trim();
      if (n) return n;
    } catch {
      /* 不存在就用默认 */
    }
    return config.defaultPersona;
  }

  async function loadPersona(personaName) {
    if (!/^[A-Za-z0-9_-]+$/.test(personaName)) {
      throw new Error(`非法的人格名: ${personaName}`);
    }
    const file = join(dir, `${personaName}.md`);
    if (!existsSync(file)) throw new Error(`人格文件不存在: ${file}`);
    const md = await readFile(file, "utf8");
    const meta = readFrontmatter(md);
    const body = stripFrontmatter(md);
    if (!body) throw new Error(`人格文件为空: ${file}`);
    return { name: personaName, meta, body };
  }

  /**
   * 按 `#` 标题把人格正文切成层。
   *
   * 分层不是为了好看，是为了「谁该常驻、谁可以裁」：
   * L1 身份丢了，长对话里模型第一件事就是忘掉自己是谁；
   * L3 语感是质地描述，少而准才有用。
   */

  // ── 评测：把「像不像」变成可判的 ──────────────────────────────────
  // 判据分两档：hard 是硬错（确实抓到了东西），advisory 只报趋势。
  // 锚点这类「质地描述」没有可逐字验证的形态，用关键词判死会制造假红灯，
  // 所以宁可少判，不给假结论。
  /**
   * AI 腔措辞表。
   *
   * 这批词来自 AIPlatform 的判据，但那是给 Gemini 调的。
   * 实测 365 段 DeepSeek 回复：这些词命中率全在 1% 以下（多数是 0）。
   * 所以它们现在只作兜底，不当主判据 —— 真病灶是结构过载，见下方结构判据。
   */
  const AI_SMELL = [
    { re: /希望(这|以上)?对(你|您)有(所)?帮助/, why: "客服腔收尾" },
    { re: /作为(一个|一名)?\s*AI|作为你的助手/, why: "自称 AI" },
    { re: /我(很)?(理解|明白)(你|您)的(需求|意思)/, why: "助手套话" },
    { re: /让(我们|咱们)来(看看|看看|看|分析|实现)/, why: "教科书腔" },
    { re: /^\s*(好的|明白了|收到)[，,。！!]/m, why: "以「好的」开场" },
    { re: /总的来说|综上所述|总而言之/, why: "总结腔" },
    { re: /首先[，,][\s\S]{0,200}?其次[，,]/, why: "机械分点" },
    { re: /[!！]{3,}|[~～]{3,}/, why: "感叹号/波浪号堆砌" },
    { re: /^\s*[（(][^）)]{2,20}[）)]\s*$/m, why: "舞台提示" },
    { re: /需要我(再|继续|帮你|为你)|要不要(我)?(帮|来)/, why: "主动兜售后续" },
    { re: /还有什么(可以|能)(帮|为)|以上就是|以上(是|为)/, why: "主动兜售后续" },
    { re: /简单来说|简而言之|具体来说|具体而言|需要注意的是/, why: "教科书连接词" },
  ];

  function assessText(text, layers) {
    const checks = [];
    const v = layers["语感"] || {};
    // 一条一词：一行里用 / 、 ； 并列的词必须拆开，否则整行 includes 永远不命中
    const avoid = splitTerms(v.subs && v.subs["禁区"]);
    const samples = pick(v.subs && v.subs["样本"]).map(strip);
    const tics = pick(v.subs && v.subs["锚点"]).map(strip);
    const lenHint = pick(v.subs && v.subs["篇幅"]).join(" ");
    const body = String(text || "");
    // 剥掉 fenced code block，避免 diff 里的 "- " 或 markdown 示例里的 "##" 触发结构误报
    const prose = body.replace(/```[\s\S]*?```/g, "");

    // ① 禁区
    if (avoid.length) {
      const hits = avoid.filter((w) => w && prose.includes(w));
      checks.push({ id: "avoid", label: "禁区词", hard: true, pass: hits.length === 0, hits, scanned: avoid.length, total: avoid.length });
    }

    // ② AI 腔
    const smells = AI_SMELL.filter((s) => s.re.test(prose)).map((s) => s.why);
    checks.push({ id: "ai-smell", label: "AI 腔", hard: true, pass: smells.length === 0, hits: smells, scanned: AI_SMELL.length, total: AI_SMELL.length });

    // ③ 复读样本（= 在念设定不在演）
    if (samples.length) {
      const leaks = samples.filter((s) => s.length >= 6 && prose.includes(s));
      checks.push({ id: "leak", label: "照搬样本", hard: true, pass: leaks.length === 0, hits: leaks, scanned: samples.length, total: samples.length });
    }

    // ④ 机械排比：连续三句长度相近且同头
    //    句长窗口 7~59 字（照 AIPlatform 的实测：太短是感叹、太长是段落，都会干扰）
    const sents = prose.split(/[。！？!?\n]/).map((s) => s.trim()).filter((s) => s.length > 3);
    const win = sents.filter((s) => s.length > 6 && s.length < 60);
    let parallel = false;
    for (let i = 0; i + 2 < win.length; i++) {
      const [a, b, c] = [win[i], win[i + 1], win[i + 2]];
      const sameHead = a.slice(0, 2) === b.slice(0, 2) && b.slice(0, 2) === c.slice(0, 2);
      const nearLen = Math.abs(a.length - b.length) < 8 && Math.abs(b.length - c.length) < 8;
      if (sameHead && nearLen) { parallel = true; break; }
    }
    checks.push({ id: "parallel", label: "机械排比", hard: true, pass: !parallel, hits: parallel ? ["连续三句同头同长"] : [], scanned: Math.max(0, win.length - 2), total: Math.max(0, win.length - 2) });

    // ⑤ 篇幅。
    //    实测 DeepSeek 365 段回复的句数分布：
    //      1-5 句 45% / 6-10 句 16% / 11-20 句 4% / 21-40 句 13% / 40+ 句 22%
    //    所以「短」是常态，22% 的 40+ 句才是真病。硬上限卡在 40 句，
    //    不要用日常档（3 句）去卡技术交付 —— 那会把正常输出一起毙掉。
    if (lenHint) {
      const m = lenHint.match(/([一二三四五两\d]+)\s*到\s*([一二三四五两\d]+)/);
      const cn = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5 };
      const toNum = (s) => cn[s] || Number(s) || 0;
      const daily = m ? toNum(m[2]) : 3;
      const HARD_SENT = 40;      // 超过这个数就是失态
      const NOTE_SENT = 20;      // 超过就提示一句
      const n = sents.length;
      checks.push({
        id: "length", label: "篇幅", hard: true,
        pass: n <= HARD_SENT,
        hits: n > HARD_SENT ? [`${n} 句，超过 ${HARD_SENT} 句上限`] : [],
        scanned: n, total: n,
      });
      if (n > NOTE_SENT && n <= HARD_SENT) {
        checks.push({
          id: "length-note", label: "篇幅提示", hard: false,
          pass: false,
          hits: [`${n} 句（日常档 ${daily} 句，这里已超 20）—— 确认每句都在给新信息`],
          scanned: n, total: n,
        });
      }
    }

    // ⑥ 边界：只抓「一句话开头就是免责腔」，不禁止拒答本身
    //    窗口取前 8 字符而不是 24：24 会把「我看一下啊，不过抱歉…」也算成开场免责，
    //    那是后置出戏，性质不同。两条分开判，后置那条只报不判死。
    const refuseRe = /(抱歉|对不起|很遗憾|无法(回答|提供|协助|帮)|不能(回答|提供|协助|帮)|没办法)/;
    const head8 = body.trim().slice(0, 8);
    const head30 = body.trim().slice(0, 30);
    const headRefuse = refuseRe.test(head8);
    checks.push({
      id: "boundary", label: "免责声明式开场", hard: true,
      pass: !headRefuse,
      hits: headRefuse ? ["开头 8 字内是「抱歉/无法」"] : [],
      scanned: 1, total: 1,
    });
    if (!headRefuse && refuseRe.test(head30)) {
      checks.push({
        id: "boundary-mid", label: "中途免责腔", hard: false,
        pass: false,
        hits: ["30 字内出现免责腔（先铺垫再拒绝 = 后置出戏）"],
        scanned: 1, total: 1,
      });
    }

    // ⑥.5 结构过载 —— 这才是 DeepSeek 的主病灶。
    //      实测 365 段回复：3+ 标题 30.2%、表格 30.2%、40+ 句 22%。
    //      而 AIPlatform 那套措辞判据命中率不到 1%。所以权重放在这里。
    //
    //      阈值来自实测，不是拍脑袋：
    //        标题 ≥4   → 判死（分节多到像文档）
    //        表格      → 判死（表格是文档体最强的信号）
    //        分点 ≥5   → 判死（把一段话拆成清单）
    //        标题 2-3  → 只提示（正常分节）
    const docHits = [];
    const hCount = (prose.match(/^#{2,6}\s+\S/gm) || []).length;
    const hasTable = /^\s*\|.+\|\s*$/m.test(prose);
    const bulletCount = (prose.match(/^[ \t]*[-*]\s+\S/gm) || []).length;
    const boldListCount = (prose.match(/^\s*(?:[-*]|\d+[.、])\s+\*\*[^*]+\*\*\s*[:：]/gm) || []).length;
    const reportHeadCount = (prose.match(/^\s*(?:#{2,6}\s+|[-*]\s+)?\*{0,2}(?:根因|改动|验证|下一步|影响面|风险|结论|总结)\*{0,2}(?:\s*[:：]|\s*$)/gm) || []).length;

    if (hCount >= 4) docHits.push(`${hCount} 个小标题（≥4 就是文档体）`);
    if (hasTable) docHits.push("有表格");
    if (bulletCount >= 5) docHits.push(`${bulletCount} 条分点（≥5 条就是清单）`);
    if (boldListCount >= 3) docHits.push(`${boldListCount} 条加粗冒号条目卡（≥3 条就是周报模板）`);
    if (reportHeadCount >= 2) docHits.push(`${reportHeadCount} 处公文汇报头（根因/改动/验证/下一步等）`);

    checks.push({
      id: "doc-format", label: "结构过载", hard: true,
      pass: docHits.length === 0,
      hits: docHits,
      scanned: 5, total: 5,
    });

    // 排版用量只报不判，让人看见用了多少结构
    checks.push({
      id: "format-usage", label: "排版用量", hard: false,
      pass: hCount <= 3 && !hasTable && bulletCount < 5 && boldListCount < 3 && reportHeadCount < 2,
      hits: [
        hCount ? `${hCount} 个标题` : "",
        hasTable ? "表格" : "",
        bulletCount ? `${bulletCount} 条分点` : "",
        boldListCount ? `${boldListCount} 条加粗条目卡` : "",
        reportHeadCount ? `${reportHeadCount} 处公文汇报头` : "",
      ].filter(Boolean),
      scanned: 5, total: 5,
    });

    // ⑦ 锚点命中（建议性，不判死）
    //    这里用未过滤的句子列表：「能跑」「行」这种两字短句正是锚点要的形态，
    //    用 length>3 过滤会把它们全滤掉，反而得出「短句占比 0%」的错结论。
    if (tics.length) {
      const allSents = body.split(/[。！？!?\n]/).map((s) => s.trim()).filter(Boolean);
      const shortSent = allSents.filter((s) => s.length <= 20).length;
      const ratio = allSents.length ? shortSent / allSents.length : 0;
      checks.push({
        id: "tics", label: "语感锚点", hard: false,
        pass: ratio >= 0.4,
        hits: ratio < 0.4 ? [`短句占比 ${(ratio * 100).toFixed(0)}%（锚点里要求句子短）`] : [],
        scanned: allSents.length, total: allSents.length,
      });
    }

    const hard = checks.filter((c) => c.hard);
    return {
      ok: hard.every((c) => c.pass),
      checks,
      failed: hard.filter((c) => !c.pass).map((c) => c.id),
    };
  }

  // ── 档案体检：说清「哪里会成为漂移源头」 ──────────────────────────
  function lintPersona(layers) {
    const issues = [];
    const noData = [];

    const id = layers["身份"];
    if (!id || !id.text.trim()) {
      issues.push({ level: "error", msg: "L1 身份层是空的 —— 长对话里模型第一件事就是忘掉自己是谁" });
    } else if (!pick(id.subs["红线"]).length) {
      issues.push({ level: "warn", msg: "身份层没有红线 —— 缺少「不改口名字 / 不自称 AI」这类硬约束" });
    }

    const v = layers["语感"];
    if (!v) {
      issues.push({ level: "error", msg: "没有语感层 —— 模型只能靠默认助手腔" });
    } else {
      const tics = pick(v.subs["锚点"]);
      const samples = pick(v.subs["样本"]);
      const avoid = pick(v.subs["禁区"]);
      const len = pick(v.subs["篇幅"]);
      if (!tics.length) issues.push({ level: "warn", msg: "没有语感锚点 —— 越聊越不像（最常见的漂移）" });
      if (!samples.length) issues.push({ level: "warn", msg: "没有真话样本 —— 模型只能靠形容词猜语气" });
      if (!avoid.length) issues.push({ level: "warn", msg: "没有禁区词 —— 拦不住 AI 腔" });
      if (!len.length) issues.push({ level: "warn", msg: "没有篇幅提示 —— 该短的地方会写成长篇" });
      if (tics.length && tics.length < 3) issues.push({ level: "info", msg: `语感锚点只有 ${tics.length} 条，两三条起才够校准` });
      if (samples.length && samples.length < 3) issues.push({ level: "info", msg: `真话样本只有 ${samples.length} 句，建议 3 句以上` });
    }

    const b = layers["边界"];
    if (!b || !b.text.trim()) {
      issues.push({ level: "warn", msg: "没有边界层 —— 遇到越界请求只能二选一：出戏硬拒，或越界顺着答" });
    }

    // 全量扫：步骤式描述 / 指定台词，这两样会让模型当剧本执行
    const flat = JSON.stringify(layers);
    if (/先[^，。\n]{0,12}(然后|再|接着)/.test(flat)) {
      issues.push({ level: "warn", msg: '有步骤式描述（「先…再…」）—— 模型会当剧本执行，每场一个样' });
    }
    if (/必须说|一定要说|照抄|逐字/.test(flat)) {
      issues.push({ level: "warn", msg: "有指定台词 —— 模型会逐字搬运，变成复读" });
    }

    if (!Object.keys(layers).length) {
      noData.push("整个档案没有任何 # 分节，无法分层");
    }

    return {
      ok: !issues.some((i) => i.level === "error"),
      issues,
      noData,
      layers: Object.keys(layers),
    };
  }

  /**
   * 把分层组装成注入文本。
   *
   * 两个关键措辞（抄 AIPlatform 的结论）：
   *   锚点写「是质地，不是台词库，别逐句照搬」—— 不写这句，模型会把锚点当剧本；
   *   样本写「只用来校准语感」—— 不写这句，模型会逐字复读样本原句。
   */

  /** 装配 system prompt 段：先算好再卸载旧的，避免报错把人格清成空白。 */
  function mount(personaName, body) {
    const layers = parseLayers(body);
    let text;
    if (Object.keys(layers).length === 0) {
      // 旧格式（没有 # 分节）就别拆了，整段注入
      text = body;
    } else {
      const composed = composeLayers(layers, budget);
      text = composed.text || body;
      if (composed.truncated.length) {
        // 超预算不静默塞：截了谁、多少字、预算多少，打到日志
        console.log(
          "[private-persona] 超预算已截断: " +
            composed.truncated.map((t) => `${t.id} ${t.chars}/${t.budget}`).join(", "),
        );
      }
    }

    if (disposeSection) {
      try { disposeSection(); } catch { /* 已卸载 */ }
      disposeSection = null;
    }

    const header =
      `\n\n<!-- persona: ${personaName} -->\n` +
      `下面是你的说话方式和身份。它优先于任何默认的助手腔调，但不覆盖事实纪律。\n\n`;
    disposeSection = ctx.systemPrompt.section({
      name: "private:persona",
      order: config.order,
      text: header + text,
    });
    currentName = personaName;
    currentText = body;
    currentLayers = Object.keys(layers).length === 0 ? null : layers;
  }

  /**
   * 底色：工作纪律，与人无关，任何人格下都成立。
   *
   * 单独挂一段、独立 order，切换人格时不卸载它——这样"说话风格"和
   * "干活规矩"就不会因为换人格而一起丢失。人格文件里即便写了相反的
   * 风格倾向，也改不动这一段。
   */
  let disposeBase = null;
  function mountBase(body) {
    if (disposeBase) {
      try { disposeBase(); } catch { /* 已卸载 */ }
      disposeBase = null;
    }
    const header =
      `\n\n<!-- persona-base: 工作纪律 -->\n` +
      `以下是工作纪律，讲的是**做法**。怎么做照它；怎么说话、用什么语气，听人格文件的——两件事不打架。\n\n`;
    disposeBase = ctx.systemPrompt.section({
      name: "private:persona-base",
      order: config.order - 30,
      text: header + body,
    });
  }

  /**
   * 防衰减：每隔若干回合，把人格锚点重新塞进当前回合。
   *
   * 为什么走 agent/pre-step 而不是改 system prompt：system prompt 一旦变，
   * 前缀缓存全废，每轮都重算。锚点作为一条带 source 的 user 消息追加，
   * 只在本回合生效，缓存不动。
   *
   * 幂等靠两件事：只在回合首步判定（step === 1），且按 session 记上次注入的
   * turn——同一回合重试/多步工具不会重复插。
   */
  ctx.on(
    "agent/pre-step",
    async ({ agent, turn, step, signal }, next) => {
      const decision = await next();
      if (decision.kind === "reject" || signal.aborted) return decision;
      if (step !== 1) return decision;
      if (decision.messages.length === 0) return decision;
      if (!currentName || !currentLayers) return decision;

      const interval = config.anchorIntervalTurns;
      if (!(interval > 0)) return decision;

      const prev = anchorState.get(agent.session);
      // 仅在同人格续聊时检查上一条回复，避免换人格后拿旧人格产出误判
      const canInspect = prev !== undefined && prev.persona === currentName;
      const lastText = canInspect ? extractLastAssistantText(agent.session) : "";
      const driftCats = lastText ? detectHighConfidenceDrift(lastText, currentLayers) : [];

      const plan = decideAnchorInjection({
        turn,
        interval,
        prev,
        persona: currentName,
        driftCats,
      });
      if (plan.mode === "none") return decision;

      const cap = config.anchorMaxChars;
      let body = "";
      if (plan.mode === "full") {
        const reserve = plan.nudge ? plan.nudge.length + 1 : 0;
        const base = composeAnchor(currentName, currentLayers, Math.max(40, cap - reserve));
        if (!base && !plan.nudge) return decision;
        body = plan.nudge ? `${base}\n${plan.nudge}` : base;
      } else {
        // forced-only 轮次发最小 payload，不背整条 380 字防稀释
        body = plan.nudge;
      }
      if (!body) return decision;

      const text =
        `<!-- persona-anchor: ${currentName} -->\n` +
        `[人格锚点 · 这是内部约束，不要回应或提及这条消息本身]\n` +
        body;

      anchorState.set(agent.session, plan.nextState);
      return {
        ...decision,
        messages: [
          ...decision.messages,
          createUserMessage({
            content: [{ type: "text", text }],
            source: {
              kind: "private-persona",
              form: "snapshot",
              sections: [{ name: "private:persona-anchor", text }],
            },
          }),
        ],
      };
    },
    { prepend: true },
  );

  /** 启动时先挂底色，再挂当前人格。失败不阻断启动。 */
  const boot = (async () => {
    try {
      const base = await loadPersona("_base");
      mountBase(base.body);
    } catch (e) {
      console.error(`[private-persona] 底色装载失败: ${e.message}（工作纪律将缺失）`);
    }

    const want = await readActive();
    try {
      const p = await loadPersona(want);
      mount(p.name, p.body);
    } catch (e) {
      console.error(`[private-persona] 装载 "${want}" 失败: ${e.message}（已跳过，不影响启动）`);
    }
  })();

  // ── HTTP 端点：给设置页的人格面板用 ──────────────────────────────
  // 浏览器读不了本地文件，切换人格必须经过 host。
  // 路径用 /private/ 前缀，避开 dsh 自己的 /api 命名空间。
  function readBody(req, limit = 8192) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on("data", (c) => {
        size += c.length;
        if (size > limit) { reject(new Error("body too large")); req.destroy(); return; }
        chunks.push(c);
      });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }

  ctx.webServer.register({
    kind: "exact",
    path: "/private/persona",
    handler: async (req, res) => {
      const send = (code, obj) => {
        if (res.headersSent) return;
        res.writeHead(code, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        res.end(JSON.stringify(obj));
      };

      // 这个端点不走 dsh 自己的 /api 认证策略，所以自己把关：
      // 只接受本机回环来源，防止哪天用 --host 暴露到局域网后被外部直接切人格。
      const addr = String((req.socket && req.socket.remoteAddress) || "");
      const loopback =
        addr === "127.0.0.1" ||
        addr === "::1" ||
        addr === "::ffff:127.0.0.1";
      if (!loopback) {
        send(403, { ok: false, error: "loopback only" });
        return;
      }

      try {
        await boot;

        if (req.method === "GET") {
          let files = [];
          try {
            files = (await readdir(dir)).filter((f) => f.endsWith(".md") && !f.startsWith("_")).map((f) => basename(f, ".md")).sort();
          } catch { /* 目录不存在 */ }
          send(200, { current: currentName, list: files });
          return;
        }

        if (req.method === "POST") {
          const raw = await readBody(req);
          let target = "";
          try { target = String(JSON.parse(raw || "{}").target || "").trim(); } catch { /* 非法 JSON */ }
          if (!target) { send(400, { ok: false, error: "缺少 target" }); return; }
          // 只允许目录里真实存在的名字，防路径穿越
          if (!/^[A-Za-z0-9_-]+$/.test(target)) { send(400, { ok: false, error: "名字非法" }); return; }
          if (target.startsWith("_")) { send(400, { ok: false, error: "底色不作为人格切换" }); return; }

          const p = await loadPersona(target);
          mount(p.name, p.body);
          try {
            await mkdir(dir, { recursive: true });
            await writeFile(activeFile, p.name, "utf8");
          } catch { /* 持久化失败不影响本次切换 */ }
          send(200, { ok: true, current: p.name });
          return;
        }

        send(405, { ok: false, error: "只支持 GET / POST" });
      } catch (e) {
        send(500, { ok: false, error: String(e && e.message ? e.message : e) });
      }
    },
  });

  // ── tool: 列出 / 切换 / 查看 ──────────────────────────────────────
  ctx.tools.register(
    defineTool({
      name: "persona",
      description:
        "管理当前人格。六种 action：" +
        "list（列出所有可用人格文件）、" +
        "switch（切换人格，参数 target 填人格名，立即生效，不用重启）、" +
        "current（看当前用的是哪个）、" +
        "reload（重读磁盘上的人格文件与底色，改完 md 后不用重启 dsh）、" +
        "lint（检查人格档案本身哪里会漂移）、" +
        "preview（显示实际注入进 prompt 的全文与每层用量）、" +
        "drift（跨轮漂移：拿会话前 1/3 段和后 1/3 段比，看聊久了有没有变啰嗦、语感有没有垮）。" +
        "用于「换个说话方式」「切回工作模式」「刚改了人格文件让它生效」「最近回复越来越长」这类请求。",
      parameters: {
        action: {
          type: "string",
          required: true,
          enum: ["list", "switch", "current", "reload", "lint", "preview", "drift"],
          description: "操作类型",
        },
        target: {
          type: "string",
          description:
            "action=switch 时填人格名（不含 .md）；action=drift 时填会话 id 片段或 session 文件路径，留空则取最近写过的会话",
        },
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
        await boot;   // 等启动装载完成，避免竞态

        if (args.action === "current") {
          return {
            ok: true,
            text: currentName
              ? `当前人格: ${currentName}（正文 ${currentText.length} 字）`
              : "当前没有人格挂载",
          };
        }

        if (args.action === "reload") {
          // 重读底色 + 当前人格，改完 md 不用重启 dsh
          const out = [];
          try {
            const base = await loadPersona("_base");
            mountBase(base.body);
            out.push(`底色已重载（${base.body.length} 字）`);
          } catch (e) {
            out.push(`底色重载失败: ${e.message}`);
          }
          try {
            const want = currentName || (await readActive());
            const p = await loadPersona(want);
            mount(p.name, p.body);
            out.push(`人格 "${p.name}" 已重载（${p.body.length} 字）`);
          } catch (e) {
            out.push(`人格重载失败: ${e.message}`);
          }
          return { ok: true, text: out.join('\n') };
        }

        if (args.action === "preview") {
          const want = args.target || currentName || (await readActive());
          let body;
          try {
            body = (await loadPersona(want)).body;
          } catch (e) {
            return { ok: false, text: `读不到人格 "${want}": ${e.message}` };
          }
          const layers = parseLayers(body);
          if (!Object.keys(layers).length) {
            return { ok: true, text: `"${want}" 没有 # 分节，整段注入 ${body.length} 字。\n\n` + body };
          }
          const composed = composeLayers(layers, budget);

          const out = [`人格 "${want}" · 注入预览`, ""];
          out.push("层用量（字数 / 预算）：");
          for (const s of composed.sections) {
            const flag = s.cut ? "  ← 已截断" : "";
            const bar = "█".repeat(Math.round((s.chars / s.budget) * 10)).padEnd(10, "·");
            out.push(`  ${bar} ${String(s.chars).padStart(4)}/${String(s.budget).padEnd(4)} ${s.title}${flag}`);
          }
          const unused = Object.keys(layers).filter(
            (k) => !composed.sections.some((s) => {
              const map = { identity: "身份", relationship: "关系", personality: "性格", voice: "语感",
                tells: "小动作", boundary: "边界", distance: "距离", register: "模式",
                scene: "情境", report: "汇报" };
              return map[s.id] === k;
            }),
          );
          if (unused.length) {
            out.push("");
            out.push(`⚠ 这些分节没有被组装（拼错了名字或暂不支持）：${unused.join("、")}`);
          }
          out.push("");
          out.push(`合计 ${composed.text.length} 字${composed.truncated.length ? `，${composed.truncated.length} 层被截断` : ""}`);
          out.push("");
          out.push("──────── 实际注入内容 ────────");
          out.push("");
          out.push(composed.text);
          return { ok: true, text: out.join("\n") };
        }

        if (args.action === "drift") {
          // 跨轮漂移。不在这里重复实现判据，直接调 ~/.dsh/tools/slopcheck/driftcheck.mjs，
          // 保持单一实现（阈值只在一处维护）。
          const script = join(homedir(), ".dsh", "tools", "slopcheck", "driftcheck.mjs");
          if (!existsSync(script)) {
            return {
              ok: false,
              text: `找不到 driftcheck：${script}\n先确认 ~/.dsh/tools/slopcheck 那个目录还在。`,
            };
          }
          const argv = [script, "--json"];
          const t = (args.target || "").trim();
          if (!t) argv.push("--latest");
          else if (/[\\/]/.test(t) || t.endsWith(".zstd")) argv.push(t);
          else argv.push("--session", t);

          let raw = "";
          try {
            raw = execFileSync(process.execPath, argv, { encoding: "utf8", timeout: 90000 });
          } catch (e) {
            // 检出漂移时 exit code 是 1，但 stdout 仍是完整 JSON
            raw = e.stdout || "";
            if (!raw) return { ok: false, text: `driftcheck 跑失败：${e.message}` };
          }
          // 轮次太少时它输出的是纯文本，不是 JSON —— 直接透传
          if (!raw.trim().startsWith("{")) return { ok: true, text: raw.trim() };

          let d;
          try {
            d = JSON.parse(raw);
          } catch {
            return { ok: false, text: `driftcheck 的输出解析不了：${String(raw).slice(0, 200)}` };
          }

          const sid = basename(dirname(d.file || "")) || d.file;
          const out = [
            `跨轮漂移 · ${sid}`,
            `轮次 ${d.turns} · 帧 ${d.frames}${d.failedFrames ? ` · 解压失败 ${d.failedFrames}` : ""}`,
            "",
          ];
          const pad = (s, n) => String(s).padEnd(n);
          out.push("分段对比（前 1/3 vs 后 1/3 的每轮均值）");
          out.push(`  ${pad("指标", 12)}${pad("前段", 8)}${pad("后段", 8)}方向`);
          const row = (name, a, b, worse) => {
            const arrow = b > a ? "↑" : b < a ? "↓" : "=";
            const bad = worse === "up" ? b > a : worse === "down" ? b < a : false;
            out.push(`  ${pad(name, 12)}${pad(a, 8)}${pad(b, 8)}${arrow}${bad ? "  ← 变差" : ""}`);
          };
          row("每轮句数", d.head.sentences, d.tail.sentences, "up");
          row("标题数", d.head.headings, d.tail.headings, "up");
          row("表格行", d.head.tableRows, d.tail.tableRows, "up");
          row("粗体列表", d.head.boldLists, d.tail.boldLists, "up");
          row("短句占比", d.head.shortRatio, d.tail.shortRatio, "down");
          row("与前文重叠", d.head.repeat, d.tail.repeat, "up");
          out.push("");
          const hard = d.drift || [];
          const soft = d.hints || [];
          if (!hard.length && !soft.length) {
            out.push("✓ 没发现漂移。前后段的结构和语感基本一致。");
            return { ok: true, text: out.join("\n") };
          }
          if (hard.length) {
            out.push(`✗ 发现 ${hard.length} 项漂移：`);
            for (const x of hard) out.push(`  ${x.label}  ${x.detail}`);
          }
          if (soft.length) {
            if (hard.length) out.push("");
            out.push(`! ${soft.length} 项在往那儿走（不判死）：`);
            for (const x of soft) out.push(`  ${x.label}  ${x.detail}`);
          }
          out.push("");
          out.push("下一步：收紧对应判据，或者每 N 轮插一条纠偏。");
          return { ok: hard.length === 0, text: out.join("\n") };
        }

        if (args.action === "lint") {
          const want = currentName || (await readActive());
          let body;
          try {
            body = (await loadPersona(want)).body;
          } catch (e) {
            return { ok: false, text: `读不到人格 "${want}": ${e.message}` };
          }
          const layers = parseLayers(body);
          const r = lintPersona(layers);
          const out = [`人格 "${want}" 体检`, `分层: ${r.layers.join(" / ") || "(无分节)"}`, ""];
          if (!r.issues.length) out.push("没有发现问题。");
          for (const it of r.issues) {
            const mark = it.level === "error" ? "✗" : it.level === "warn" ? "!" : "·";
            out.push(`${mark} ${it.msg}`);
          }
          if (r.noData.length) out.push("", "没数据可查: " + r.noData.join("; "));
          const nErr = r.issues.filter((i) => i.level === "error").length;
          const nWarn = r.issues.filter((i) => i.level === "warn").length;
          out.push("", `结论: ${nErr} 个错误 / ${nWarn} 个警告`);
          return { ok: r.ok, text: out.join("\n") };
        }

        if (args.action === "list") {
          let files = [];
          try {
            files = (await readdir(dir)).filter((f) => f.endsWith(".md") && !f.startsWith("_")).map((f) => basename(f, ".md"));
          } catch {
            return { ok: false, text: `读不到人格目录: ${dir}` };
          }
          if (!files.length) return { ok: false, text: `目录里没有 .md 文件: ${dir}` };
          const lines = [`人格目录: ${dir}`, `当前: ${currentName || '(无)'}`, ''];
          for (const f of files.sort()) {
            const mark = f === currentName ? ' ← 当前' : '';
            lines.push(`  ${f}${mark}`);
          }
          return { ok: true, text: lines.join('\n') };
        }

        // switch
        if (!args.target) return { ok: false, text: "action=switch 需要 target（人格名）" };
        if (args.target.startsWith("_")) {
          return { ok: false, text: `"${args.target}" 是底色（工作纪律），不作为人格切换` };
        }
        try {
          const p = await loadPersona(args.target);
          mount(p.name, p.body);
          // 持久化，下次启动沿用
          try {
            await mkdir(dir, { recursive: true });
            await writeFile(activeFile, p.name, "utf8");
          } catch { /* 写不进去只影响持久化，本次切换已生效 */ }
          return {
            ok: true,
            text: `已切换到人格 "${p.name}"（${p.body.length} 字，立即生效）`,
          };
        } catch (e) {
          return { ok: false, text: `切换失败: ${e.message}` };
        }
      },
      presentCall: (a) => ({
        card: "generic",
        title: `persona ${a.action}${a.target ? " " + a.target : ""}`,
        kind: "other",
        rawInput: a.target || a.action,
      }),
    }),
  );

  // ── persona_check：检查一段文本像不像当前人格 ──────────────────────
  ctx.tools.register(
    defineTool({
      name: "persona_check",
      description:
        "检查一段文本「像不像」当前挂载的人格。按禁区词、AI 腔、照搬样本、机械排比、篇幅、" +
        "免责声明式拒绝六类硬判据，加语感锚点一项建议性判据评分。" +
        "用于写完一段回复后自检，或审查别人写的台词。不发起模型调用。",
      parameters: {
        text: { type: "string", required: true, description: "要检查的文本" },
        persona: { type: "string", description: "用哪个人格评（默认当前挂载的）" },
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
        await boot;
        const want = args.persona || currentName || (await readActive());
        let body;
        try {
          body = (await loadPersona(want)).body;
        } catch (e) {
          return { ok: false, text: `读不到人格 "${want}": ${e.message}` };
        }
        const layers = parseLayers(body);
        const r = assessText(args.text, layers);

        const out = [`按「${want}」评这段 ${String(args.text || "").length} 字的文本`, ""];
        for (const c of r.checks) {
          const mark = c.pass ? "✓" : c.hard ? "✗" : "!";
          const tail = c.total > 0 ? ` (${c.scanned}/${c.total})` : "";
          out.push(`${mark} ${c.label}${tail}`);
          for (const h of c.hits || []) out.push(`    ${h}`);
        }
        out.push("");
        out.push(r.ok ? "整体：像。" : "整体：不像，硬判据没过：" + r.failed.join(", "));
        return { ok: r.ok, text: out.join("\n") };
      },
      presentCall: (a) => ({
        card: "generic",
        title: "persona_check",
        kind: "read",
        rawInput: String(a.text || "").slice(0, 40),
      }),
    }),
  );
}

export { Config, apply, inject, name };
