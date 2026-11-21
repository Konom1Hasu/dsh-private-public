/**
 * 人格解析与组装的回归测试。
 *
 * 这层决定人格最终注入成什么样，改错一个字模型就跑偏，
 * 所以测的是「给定 layers，输出文本长什么样」——具体到措辞。
 *
 * 跑：node --test packages/dsh-private-persona/test/
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { parseLayers, pick, strip, splitTerms, composeLayers, composeAnchor, decideAnchorInjection } from "../lib/core.mjs";

const budget = { identity: 1100, relationship: 500, personality: 500, voice: 1300, tells: 500, boundary: 600, distance: 400, register: 500, scene: 700, report: 1000 };

describe("parseLayers：按 # 和 ## 切分", () => {
  test("一级标题变成层，二级变成子节", () => {
    const md = `# 身份

你是某人。

## 红线

- 不自称 AI

# 语感

## 锚点

- 句子短`;
    const L = parseLayers(md);
    assert.deepEqual(Object.keys(L), ["身份", "语感"]);
    assert.match(L["身份"].text, /你是某人/);
    assert.deepEqual(pick(L["身份"].subs["红线"]), ["- 不自称 AI"]);
    assert.deepEqual(pick(L["语感"].subs["锚点"]), ["- 句子短"]);
  });

  test("没有标题的内容被忽略（不进任何层）", () => {
    const L = parseLayers("这段没有标题\n\n# 身份\n\n有标题了");
    assert.equal(Object.keys(L).length, 1);
    assert.match(L["身份"].text, /有标题了/);
    assert.doesNotMatch(L["身份"].text, /没有标题/);
  });

  test("空文本返回空对象", () => {
    assert.deepEqual(parseLayers(""), {});
  });

  test("同级标题多次出现时后者覆盖前者", () => {
    const L = parseLayers("# 身份\n\n第一段\n\n# 身份\n\n第二段");
    assert.match(L["身份"].text, /第二段/);
    assert.doesNotMatch(L["身份"].text, /第一段/);
  });
});

describe("pick / strip：清洗列表项", () => {
  test("pick 去掉空行和首尾空白", () => {
    assert.deepEqual(pick(["  a  ", "", "   ", "b"]), ["a", "b"]);
  });

  test("pick 对 undefined 返回空数组", () => {
    assert.deepEqual(pick(undefined), []);
  });

  test("strip 去掉列表符号和引号", () => {
    assert.equal(strip("- 一句"), "一句");
    assert.equal(strip("· 一点"), "一点");
    assert.equal(strip("「有引号」"), "有引号");
  });
});

describe("composeLayers：注入文本的关键措辞", () => {
  const base = parseLayers(`# 身份

你是某人。

## 红线

- 不自称 AI

# 语感

## 锚点

- 句子短

## 样本

- 能跑。

## 禁区

- 希望这对你有帮助

## 篇幅

日常一到三句。`);

  test("身份层带红线，标题是 L1", () => {
    const { text } = composeLayers(base, budget);
    assert.match(text, /L1 身份红线/);
    assert.match(text, /红线：/);
    assert.match(text, /不自称 AI/);
  });

  test("锚点必须标「是质地，不是台词库」", () => {
    const { text } = composeLayers(base, budget);
    assert.match(text, /语感锚点（是质地，不是台词库，别逐句照搬）/);
    assert.match(text, /· 句子短/);
  });

  test("样本必须标「只用来校准语感」并加引号", () => {
    const { text } = composeLayers(base, budget);
    assert.match(text, /真话样本（只用来校准语感）/);
    assert.match(text, /「能跑。」/);
  });

  test("禁区单独成段", () => {
    const { text } = composeLayers(base, budget);
    assert.match(text, /禁区（出现即失格）/);
    assert.match(text, /希望这对你有帮助/);
  });

  test("篇幅保留换行，不被压成一行", () => {
    const multi = parseLayers("# 语感\n\n## 篇幅\n\n日常一到三句。\n交付技术可以长。\n代码块随便用。");
    const { text } = composeLayers(multi, budget);
    const seg = text.split("篇幅：")[1];
    assert.ok(seg.includes("\n"), "篇幅应保留换行");
    assert.ok(!/日常一到三句。 交付/.test(seg), "不该被空格拼成一行");
  });

  test("空层不出现在结果里", () => {
    const only = parseLayers("# 身份\n\n只有身份");
    const { text, sections } = composeLayers(only, budget);
    assert.equal(sections.length, 1);
    assert.doesNotMatch(text, /L2 关系/);
    assert.doesNotMatch(text, /L3 语感/);
  });
});

describe("composeLayers：预算截断", () => {
  test("超预算被截断并记录", () => {
    const long = "很长的一段话。".repeat(100);
    const L = parseLayers(`# 身份\n\n${long}`);
    const { text, truncated, sections } = composeLayers(L, { identity: 50 });
    assert.equal(truncated.length, 1);
    assert.equal(truncated[0].id, "identity");
    assert.ok(truncated[0].chars > 50);
    assert.ok(text.length < long.length, "文本应该变短");
    assert.equal(sections[0].cut, true);
  });

  test("没超预算不记录截断", () => {
    const L = parseLayers("# 身份\n\n短");
    const { truncated, sections } = composeLayers(L, { identity: 100 });
    assert.equal(truncated.length, 0);
    assert.equal(sections[0].cut, false);
  });

  test("截断优先在段落边界切，不在半句上切", () => {
    const para = "第一段完整的话。";
    const L = parseLayers(`# 身份\n\n${para}\n\n${para}\n\n${para}`);
    const { text } = composeLayers(L, { identity: 30 });
    // 截断后的内容不应以半个句子结尾
    const body = text.replace(/^L1 身份红线\n/, "").trim();
    assert.ok(body.endsWith("。"), `应该切在句号后，实际结尾: ${body.slice(-10)}`);
  });
});

describe("composeLayers：层级顺序", () => {
  test("身份在语感前面", () => {
    const L = parseLayers("# 身份\n\n甲\n\n# 语感\n\n## 锚点\n\n- 乙");
    const { text } = composeLayers(L, budget);
    assert.ok(text.indexOf("L1 身份") < text.indexOf("L3 语感"));
  });

  test("性格层在语感之前（给行为依据，不是规则）", () => {
    const L = parseLayers("# 性格\n\n两股力都留着\n\n# 语感\n\n## 锚点\n\n- 短");
    const { text } = composeLayers(L, budget);
    assert.ok(text.indexOf("L2.5 性格") < text.indexOf("L3 语感"));
  });

  test("模式层标题写明「只调说话指针，不改人格」", () => {
    const L = parseLayers("# 模式\n\n干活时信息密度高");
    const { text } = composeLayers(L, budget);
    assert.match(text, /寄存器（只调说话指针，不改人格）/);
  });
});

describe("splitTerms：一行多词要拆开", () => {
  test("斜杠并列的行拆成一条一词", () => {
    const terms = splitTerms(["- 希望这对你有帮助 / 作为一个 AI / 总的来说"]);
    assert.deepEqual(terms, ["希望这对你有帮助", "作为一个 AI", "总的来说"]);
  });

  test("顿号、分号并列同样拆开", () => {
    assert.deepEqual(splitTerms(["- 四字排比、每段齐整三句"]), ["四字排比", "每段齐整三句"]);
    assert.deepEqual(splitTerms(["综上；简而言之"]), ["综上", "简而言之"]);
  });

  test("一条一行时原样返回", () => {
    assert.deepEqual(splitTerms(["- 综上所述"]), ["综上所述"]);
    assert.deepEqual(splitTerms(["- 作为一个 AI"]), ["作为一个 AI"]);
  });

  test("空值、无引号单字噪声被滤掉，但引号显式标注的单字保留", () => {
    assert.deepEqual(splitTerms(undefined), []);
    assert.deepEqual(splitTerms(["", "  ", "- 啊", "- 综上"]), ["综上"]);
    assert.deepEqual(splitTerms(["- 「咱」 / 咱们"]), ["咱", "咱们"]);
  });

  test("括号内的顿号举例不会拆出垃圾词", () => {
    const terms = splitTerms(["- 四字排比与三段式总结（如「X 稳、Y 准、全提升」式并列对称句）"]);
    assert.deepEqual(terms, ["四字排比与三段式总结"]);
  });
});

describe("composeAnchor：长对话防漂移锚点", () => {
  const md = `# 身份

你是某人，别自称 AI。

## 红线

- 不自称 AI、不说「作为一个……」
- 不改口自己叫什么

# 语感

## 锚点

- 句子短，不堆从句
- 每轮带两三个语气词

## 样本

- 「改完了喵，三处~ 顺手把那个看着别扭的命名也拧正了。」

## 禁区

- 总的来说
- 综上

# 汇报

**第一句就得有情绪**，结论先给。`;

  test("抽出身份首句、红线、语感锚点、短样本与禁区", () => {
    const a = composeAnchor("someone", parseLayers(md), 320);
    assert.match(a, /你是某人，别自称 AI/);
    assert.match(a, /红线：不自称 AI、不说「作为一个……」；不改口自己叫什么/);
    assert.match(a, /语感：句子短，不堆从句；每轮带两三个语气词/);
    assert.match(a, /例：「改完了喵，三处~ 顺手把那个看着别扭的命名也拧正了。」/);
    assert.match(a, /禁：总的来说；综上/);
  });

  test("「作为一个……」的尾引号不会被吃掉", () => {
    const a = composeAnchor("someone", parseLayers(md), 320);
    assert.ok(a.includes("「作为一个……」"), `引号被削了: ${a}`);
  });

  test("条目结尾的句号不与连接符叠成「。；」", () => {
    const L = parseLayers("# 语感\n\n## 锚点\n\n- 句子短。\n- 带语气词。");
    const a = composeAnchor("x", L, 320);
    assert.ok(!a.includes("。；"), `出现叠标点: ${a}`);
    assert.match(a, /句子短；带语气词/);
  });

  test("锚点多于两条时后面几条不被砍掉（结构化静默边界、反公式化要留）", () => {
    const L = parseLayers(`# 语感

## 锚点

- 句子有长有短：平时二三十字拖着走，落点砸短句。
- **起手先说动作或现场**（如「刚翻了配置」），判断挂在动作后半句。
- **高浓度猫娘口吻**：尾音自然带出「喵」「呜」。
- **结构化静默边界**：代码块、diff、JSON 里不许出现「喵」。
- **反公式化**：想说「不是 A 而是 B」直接说 B。`);
    const a = composeAnchor("lcs-cat", L, 320);
    assert.match(a, /结构化静默边界/);
    assert.match(a, /反公式化/);
    assert.ok(a.length <= 320, `超预算: ${a.length}`);
    assert.ok(!a.includes("**"), `锚点里不该留 markdown 记号: ${a}`);
  });

  test("禁区整行斜杠并列时逐词拆开进锚点", () => {
    const L = parseLayers("# 语感\n\n## 禁区\n\n- 希望这对你有帮助 / 作为一个 AI / 综上");
    const a = composeAnchor("x", L, 320);
    assert.match(a, /禁：希望这对你有帮助；作为一个 AI；综上/);
  });

  test("clip 截断后先剥残标点再补省略号", () => {
    const L = parseLayers("# 语感\n\n## 锚点\n\n- 甲乙丙丁，戊己庚辛，壬癸子丑，寅卯辰巳。");
    const a = composeAnchor("x", L, 60);
    assert.match(a, /…/, `应带省略号: ${a}`);
    assert.ok(!/[，、；：,;]\s*…/.test(a), `省略号前不该悬着标点: ${a}`);
  });

  test("汇报层有空间才追加，挤不下就舍掉", () => {
    const roomy = composeAnchor("someone", parseLayers(md), 400);
    assert.match(roomy, /汇报：/);
    const tight = composeAnchor("someone", parseLayers(md), 60);
    assert.ok(!tight.includes("汇报："), "预算不够时不该塞汇报");
    assert.ok(tight.length <= 60);
  });

  test("超预算时在行/句边界收，不硬切半句", () => {
    const L = parseLayers(`# 身份\n\n${"甲".repeat(50)}。\n\n${"乙".repeat(50)}。`);
    const a = composeAnchor("x", L, 40);
    assert.ok(a.length <= 40);
  });

  test("空名、空 layers、无分层正文都返回空串", () => {
    assert.equal(composeAnchor("", parseLayers(md), 320), "");
    assert.equal(composeAnchor("x", {}, 320), "");
    assert.equal(composeAnchor("x", null, 320), "");
    assert.equal(composeAnchor("x", parseLayers("没有标题的一段话"), 320), "");
  });

  test("底色（_base）没有身份/语感层，不产出锚点", () => {
    const L = parseLayers("# 工作纪律\n\n先搜后写");
    assert.equal(composeAnchor("_base", L, 320), "");
  });
});

describe("真实人格文件：lcs-cat.md 的禁区与锚点", () => {
  const file = new URL("../../../personas/lcs-cat.md", import.meta.url);
  const skip = existsSync(file) ? false : "找不到 personas/lcs-cat.md";
  const md = skip ? "" : readFileSync(file, "utf8");

  test("禁区一条一行，拆出来至少八个词", { skip }, () => {
    const L = parseLayers(md);
    const terms = splitTerms(L["语感"].subs["禁区"]);
    assert.ok(terms.length >= 8, `禁区词只剩 ${terms.length} 个: ${JSON.stringify(terms)}`);
    for (const t of terms) {
      assert.ok(!t.includes("/"), `还有整行没拆开: ${t}`);
      assert.ok(t.length <= 12, `禁区词太长（多半是没拆的整行）: ${t}`);
    }
  });

  test("锚点带上结构化静默边界和反公式化，且不超预算", { skip }, () => {
    const a = composeAnchor("lcs-cat", parseLayers(md), 380);
    assert.match(a, /结构化静默边界/);
    assert.match(a, /反公式化/);
    assert.ok(a.length <= 380, `锚点 ${a.length} 字，超预算`);
    assert.match(a, /禁：/);
    assert.match(a, /汇报：/);
  });

  test("锚点里的禁区词不比原文少太多（别被写死的条数砍掉）", { skip }, () => {
    const L = parseLayers(md);
    const total = splitTerms(L["语感"].subs["禁区"]).length;
    const a = composeAnchor("lcs-cat", L, 380);
    const line = (a.split("\n").find((s) => s.startsWith("禁：")) || "").replace(/^禁：/, "");
    const inAnchor = line.split("；").filter(Boolean);
    assert.ok(inAnchor.length >= total - 1, `禁区 ${total} 词，锚点只带 ${inAnchor.length} 个`);
  });

  test("lcs-cat.md 完整组装后 0 截断（含毛边）", { skip }, () => {
    const L = parseLayers(md);
    const { text, truncated } = composeLayers(L, budget);
    assert.equal(truncated.length, 0, `发生截断: ${JSON.stringify(truncated)}`);
    assert.match(text, /毛边：/);
  });

  test("注入正文里禁区仍是一条一行", { skip }, () => {
    const L = parseLayers(md);
    const { text } = composeLayers(L, {});
    const seg = text.split("禁区（出现即失格）：")[1] || "";
    const bullets = seg.split("\n").filter((s) => s.trim().startsWith("·"));
    assert.ok(bullets.length >= 8, `注入的禁区条目只有 ${bullets.length} 条`);
  });
});

describe("decideAnchorInjection：周期 + 高置信漂移纠偏节拍", () => {
  test("首轮不注入；第 2 轮首锚；之后按 interval=3 周期注入", () => {
    let prev;
    const modes = [];
    for (let turn = 1; turn <= 8; turn++) {
      const r = decideAnchorInjection({ turn, interval: 3, prev, persona: "lcs-cat", driftCats: [] });
      modes.push([turn, r.mode]);
      if (r.nextState) prev = r.nextState;
    }
    assert.deepEqual(modes, [
      [1, "none"],
      [2, "full"],
      [3, "none"],
      [4, "none"],
      [5, "full"],
      [6, "none"],
      [7, "none"],
      [8, "full"],
    ]);
  });

  test("非周期轮命中高置信漂移发最小 nudge，最多连发 2 次防死循环，周期轮归零", () => {
    let prev = { turn: 2, persona: "lcs-cat", consecForced: 0 };
    const r3 = decideAnchorInjection({ turn: 3, interval: 4, prev, persona: "lcs-cat", driftCats: ["禁区词"] });
    assert.equal(r3.mode, "nudge");
    assert.match(r3.nudge, /禁区词/);
    prev = r3.nextState;

    const r4 = decideAnchorInjection({ turn: 4, interval: 4, prev, persona: "lcs-cat", driftCats: ["周报条目卡"] });
    assert.equal(r4.mode, "nudge");
    prev = r4.nextState;

    // 连续第 3 次强制被限流，不再刷屏
    const r5 = decideAnchorInjection({ turn: 5, interval: 4, prev, persona: "lcs-cat", driftCats: ["AI腔"] });
    assert.equal(r5.mode, "none");

    // 到达周期轮（6 - 2 = 4）走 full 且拼入 nudge，并重置 consecForced
    const r6 = decideAnchorInjection({ turn: 6, interval: 4, prev, persona: "lcs-cat", driftCats: ["AI腔"] });
    assert.equal(r6.mode, "full");
    assert.match(r6.nudge, /AI腔/);
    assert.equal(r6.nextState.consecForced, 0);
  });

  test("换人格立刻走 full 且不把旧人格漂移算到新人格头上", () => {
    const prev = { turn: 3, persona: "ds-cat", consecForced: 1 };
    const r = decideAnchorInjection({ turn: 4, interval: 3, prev, persona: "lcs-cat", driftCats: ["禁区词"] });
    assert.equal(r.mode, "full");
    assert.equal(r.nudge, "");
    assert.equal(r.nextState.persona, "lcs-cat");
    assert.equal(r.nextState.consecForced, 0);
  });
});
