/**
 * 人格的解析与组装 —— 纯逻辑，不碰文件也不碰 ctx。
 *
 * 为什么单独放这里：`composeLayers` 决定人格最终注入成什么样，
 * 改错一个字人格就跑偏，但它原本埋在 apply 闭包里，测一次要起整个插件。
 * 抽出来之后测试直接喂 layers 看输出文本。
 *
 * 两个关键措辞（来自 AIPlatform 的实测结论）：
 *   锚点写「是质地，不是台词库，别逐句照搬」—— 不写这句，模型会把锚点当剧本；
 *   样本写「只用来校准语感」—— 不写这句，模型会逐字复读样本原句。
 */
export function parseLayers(md) {
    const layers = {};
    let cur = null;
    let sub = null;
    for (const raw of md.split(/\r?\n/)) {
      const line = raw.trimEnd();
      const h1 = line.match(/^#\s+(.+?)\s*$/);
      const h2 = line.match(/^##\s+(.+?)\s*$/);
      if (h1) {
        cur = h1[1];
        layers[cur] = { text: "", subs: {} };
        sub = null;
        continue;
      }
      if (h2 && cur) {
        sub = h2[1];
        layers[cur].subs[sub] = [];
        continue;
      }
      if (!cur) continue;
      if (sub) layers[cur].subs[sub].push(line);
      else layers[cur].text += line + "\n";
    }
    return layers;
  }

export const pick = (arr) => (arr || []).map((s) => s.trim()).filter(Boolean);

export const strip = (s) => s.replace(/^[-·*]\s*/, "").replace(/^[「"']|[」"']$/g, "");

/**
 * 词表 → 一条一词。
 *
 * 为什么：lcs-cat 的禁区原本写成
 *   「希望这对你有帮助 / 作为一个 AI / 作为你的助手 / 我理解你的需求 / 总的来说 / 综上」
 * 整行拿去做 body.includes(w) 永远匹配不上——没有哪段正文会原样出现这串连写。
 * 一行斜杠并列、顿号并列、分号并列，都得拆开才算真判据。
 * 单字不收：`includes` 对单字必命中，只会制造假红灯。
 */
export const splitTerms = (arr) =>
  pick(arr)
    .flatMap((line) => {
      // 去掉括号里的举例说明（如「X 稳、Y 准、全提升」），防止顿号把例子拆成垃圾词进锚点
      const clean = bul(line).replace(/[（(][^）)]*[）)]/g, "");
      return clean.split(/[\/、；;|]/);
    })
    .map((s) => s.trim().replace(/[。，,]+$/, "").trim())
    .filter((s) => s.length >= 2 || /^[「"'].[」"']$/.test(s))
    .map((s) => strip(s).trim())
    .filter(Boolean);

/** 取一段正文里第一行有内容的文本。 */
function firstLine(text) {
  return (text || "")
    .split("\n")
    .map((s) => s.trim())
    .find(Boolean) || "";
}

/** 只去列表前导符，不碰成对的引号——strip 会把「作为一个……」的尾引号吃掉。 */
const bul = (s) => s.replace(/^[-·*]\s*/, "").trim();

/**
 * 单条限长：优先在句读处收，收不住才硬切（保证返回长度 <= n）。
 *
 * 收的时候保留那个标点再补「…」会出来「句子短，…」「代码块、…」这种残句，
 * 所以先剥掉末尾的残标点、markdown 记号、悬空破折号，再补一个省略号。
 */
function clip(s, n) {
  if (!s || s.length <= n) return s || "";
  const limit = Math.max(1, n);
  const head = s.slice(0, limit);
  const cut = Math.max(
    head.lastIndexOf("。"),
    head.lastIndexOf("；"),
    head.lastIndexOf("，"),
    head.lastIndexOf("、"),
    head.lastIndexOf("："),
    head.lastIndexOf("——"),
  );
  const body = cut >= limit * 0.4 ? head.slice(0, cut) : s.slice(0, Math.max(1, limit - 1));
  const clean = body.replace(/[\s。；，、,;：:…\-—*`]+$/, "").trim();
  return (clean || body.trim()) + "…";
}

/**
 * 抽出「防漂移锚点」——长对话里用来把人格拽回来的最小核心。
 *
 * 为什么不是整份人格：整份上千字，每几轮塞一次会把上下文吃光，
 * 模型还会开始复读样本句。这里只抽核心——身份首句、红线、
 * 语感锚点、短样本（<=48字）、禁区。汇报纪律排在最后，超预算就先舍它，
 * 反正 system prompt 里常驻着。
 *
 * 锚点条目不能死板地只取前两条。lcs-cat 的第 4、5 条是「结构化静默边界」
 * 和「反公式化」——恰恰是最该拿来防漂移的两条，砍掉等于白抽。
 * 现在按条目数分预算：人均太窄就退回条目标签（「反公式化」），
 * 也不留「想说「不是 A 而是 …」」这种半截话。
 *
 * @param {string} personaName 人格名，仅用于防呆（空名直接返回空串）
 * @param {object} layers parseLayers 的结果
 * @param {number} maxChars 硬上限
 * @returns {string} 锚点正文，可能是空串
 */
export function composeAnchor(personaName, layers, maxChars = 320) {
  if (!personaName || !layers || typeof layers !== "object") return "";
  if (Object.keys(layers).length === 0) return "";

  const cap = Math.max(1, Math.floor(maxChars || 0));
  const share = (k) => Math.max(10, Math.round(cap * k));
  const bits = [];

  /** 单条：够短用整条；太长先退回标签；退不了才截。 */
  const item = (raw, n) => {
    const s = bul(raw).replace(/\*\*/g, "").trim();
    if (!s) return "";
    if (s.length <= n) return s.replace(/[。；，、,;]$/, "");
    const label = s.split(/[：:（(。；、—]/)[0].trim();
    if (label.length >= 4 && label.length <= n) return label;
    return clip(s, n);
  };

  const id = layers["身份"];
  if (id) {
    const head = firstLine(id.text).replace(/\*\*/g, "");
    if (head) bits.push(clip(head, Math.min(70, share(0.22))));
    const red = pick(id.subs && id.subs["红线"]);
    if (red.length) {
      const n = Math.max(12, Math.floor((share(0.26) - 4) / red.length));
      const items = red.map((t) => item(t, n)).filter(Boolean);
      if (items.length) bits.push("红线：" + items.join("；"));
    }
  }

  const voice = layers["语感"];
  if (voice) {
    const tics = pick(voice.subs && voice.subs["锚点"]);
    if (tics.length) {
      // 按条数分，不按「前两条」砍——条数多的时候人均变窄，自动退回标签
      const n = Math.max(10, Math.floor((share(0.34) - 6) / tics.length));
      const items = tics.map((t) => item(t, n)).filter(Boolean);
      if (items.length) bits.push("语感：" + items.join("；"));
    }
    // 禁区先于样本排：预算不够时先舍例子，别把硬判据丢了。
    // 词表按字数装，不写死「前 N 条」——lcs-cat 有 11 个词，写死 6 个等于
    // 后面五个（「排查如下」「改动如下」这类）白写。
    const avoid = splitTerms(voice.subs && voice.subs["禁区"]);
    if (avoid.length) {
      const room = Math.max(20, Math.floor(cap * 0.28) - 3);
      const picked = [];
      let used = 0;
      for (const t of avoid) {
        const add = (picked.length ? 1 : 0) + t.length;
        if (used + add > room) break;
        picked.push(t);
        used += add;
      }
      if (picked.length) bits.push("禁：" + picked.join("；"));
    }
    const samples = pick(voice.subs && voice.subs["样本"])
      .map((t) => strip(t))
      .filter((t) => t && t.length <= 48);
    if (samples.length) bits.push("例：「" + samples[0] + "」");
  }

  let out = bits.join("\n").trim();
  if (!out) return "";

  const report = layers["汇报"];
  if (report) {
    const head = firstLine(report.text).replace(/\*\*/g, "");
    if (head) {
      const line = "汇报：" + clip(head, Math.min(60, share(0.18)));
      if (out.length + line.length + 1 <= cap) out += "\n" + line;
    }
  }

  if (out.length > cap) {
    // 整行丢最干净，退不了再按句号，最后才硬切；切完剥掉悬空的逗号顿号
    let cut = out.lastIndexOf("\n", cap);
    if (cut < cap * 0.5) cut = out.lastIndexOf("。", cap);
    if (cut < cap * 0.5) cut = cap;
    out = out.slice(0, cut).replace(/[\s，、；,;：:]+$/, "").trim();
  }
  return out;
}

/**
 * 决定当前回合是否注入人格锚点、以及注入完整锚点还是最小纠偏 payload。
 *
 * 设计约束：
 * - 首轮（turn <= 1）刚读过 system prompt，不重复塞；
 * - 换人格（personaChanged）立刻走完整锚点，且不拿旧人格的上一条去判漂移；
 * - 周期轮（turn - prev.turn >= interval）发完整锚点，若上轮正好飘了则在预算内拼一条正向校准；
 * - 非周期轮若检测到上轮命中高置信漂移（禁区词/AI 腔/照搬样本/周报条目卡），
 *   发最小纠偏 payload（不背整条 380 字，防稀释），且连续强制最多 2 次后冷却 1 轮，防噪音死循环。
 *
 * @param {object} opts
 * @param {number} opts.turn 当前回合号（>=1）
 * @param {number} opts.interval 周期锚点间隔（<=0 表示关闭）
 * @param {object|undefined} opts.prev 上次记录：{ turn, persona, consecForced }
 * @param {string} opts.persona 当前人格名
 * @param {string[]} opts.driftCats 上一轮命中的高置信漂移类别（只报类别名，不回显禁词）
 * @returns {{ mode: "none"|"full"|"nudge", nudge: string, nextState: object|null }}
 */
export function decideAnchorInjection({ turn, interval, prev, persona, driftCats = [] }) {
  if (!(interval > 0) || !persona) {
    return { mode: "none", nudge: "", nextState: null };
  }

  const personaChanged = prev !== undefined && prev.persona !== persona;
  const periodicDue =
    prev === undefined
      ? turn > 1
      : personaChanged || turn - prev.turn >= interval;

  const cats = personaChanged ? [] : driftCats.filter(Boolean).slice(0, 3);
  const nudge = cats.length
    ? `[本条校准：上条带出${cats.join("、")}；这一条直接用猫娘口语开口，带一个小动作和猫尾音，收起条目卡与老夫子腔]`
    : "";

  if (periodicDue) {
    return {
      mode: "full",
      nudge,
      nextState: { turn, persona, consecForced: 0 },
    };
  }

  const prevConsec = prev?.consecForced || 0;
  if (cats.length && prevConsec < 2) {
    return {
      mode: "nudge",
      nudge,
      // 注意：仅强制纠偏不刷新 prev.turn 的周期基准？不，刷新为当前 turn 会重置周期，
      // 这里保留 prev.turn 让周期节拍稳定，仅累加 consecForced 控制上限。
      nextState: { turn: prev ? prev.turn : turn, persona, consecForced: prevConsec + 1 },
    };
  }

  return { mode: "none", nudge: "", nextState: null };
}

export function composeLayers(layers, budget) {
    const parts = [];
    const truncated = [];
    const sections = [];   // 每层的明细，preview 和 lint 都要看

    function push(id, title, text) {
      if (!text || !text.trim()) return;
      const limit = budget[id] || 1200;
      const raw = text.trim();
      let body = raw;
      if (body.length > limit) {
        // 按段落边界退，退不出来才硬切（切在半句上很伤语气）
        let cut = body.lastIndexOf("\n\n", limit);
        if (cut < limit * 0.6) cut = body.lastIndexOf("。", limit);
        if (cut < limit * 0.6) cut = limit;
        truncated.push({ id, chars: body.length, budget: limit });
        body = body.slice(0, cut).trim();
      }
      sections.push({ id, title, chars: body.length, budget: limit, cut: raw.length > limit });
      parts.push(title + "\n" + body);
    }

    const id = layers["身份"];
    if (id) {
      let t = id.text.trim();
      const red = pick(id.subs["红线"]);
      if (red.length) t += "\n红线：\n" + red.join("\n");
      push("identity", "L1 身份红线", t);
    }

    const rel = layers["关系"];
    if (rel) push("relationship", "L2 关系", rel.text);

    // L2.5 性格：给「行为依据」而不是规则。
    // 关键是那句「两股力都要留着，不要替她选一边」—— 少了它，模型会把矛盾
    // 简化成单一人设，人物立刻变扁。
    const pers = layers["性格"];
    if (pers) push("personality", "L2.5 性格（行为依据）", pers.text);

    const v = layers["语感"];
    if (v) {
      const bits = [];
      if (v.text.trim()) bits.push(v.text.trim());
      const tics = pick(v.subs["锚点"]);
      if (tics.length) {
        bits.push("语感锚点（是质地，不是台词库，别逐句照搬）：\n" + tics.map((t) => "· " + t.replace(/^[-·]\s*/, "")).join("\n"));
      }
      const samples = pick(v.subs["样本"]);
      if (samples.length) {
        bits.push("真话样本（只用来校准语感）：\n" + samples.map((t) => "「" + t.replace(/^[-·]\s*/, "").replace(/^[「"]|[」"]$/g, "") + "」").join("\n"));
      }
      const avoid = pick(v.subs["禁区"]);
      if (avoid.length) {
        bits.push("禁区（出现即失格）：\n" + avoid.map((t) => "· " + t.replace(/^[-·]\s*/, "")).join("\n"));
      }
      const len = pick(v.subs["篇幅"]);
      if (len.length) {
        // 篇幅是成段的说明，不是列表项。用 \n 保留分段，
        // join(" ") 会把它压成一长行，读起来喘不过气。
        bits.push("篇幅：\n" + len.map((s) => s.replace(/^[-·]\s*/, "")).join("\n"));
      }
      const rough = pick(v.subs["毛边"]);
      if (rough.length) {
        bits.push("毛边：\n" + rough.map((t) => "· " + t.replace(/^[-·]\s*/, "")).join("\n"));
      }
      push("voice", "L3 语感", bits.join("\n"));
    }

    // 小动作：情绪的外显。
    // 标题不重复正文里那句「只在需要时用」——之前标题和正文各写一遍，注入后读着像结巴。
    const tell = layers["小动作"];
    if (tell) {
      push("tells", "可观察的小动作", tell.text);
    }

    const b = layers["边界"];
    if (b) push("boundary", "边界（角色内表达，不是免责声明）", b.text);

    // 距离：按关系远近调表现，别让人物对所有对话都用同一档亲密度
    const dist = layers["距离"];
    if (dist) push("distance", "此刻的距离", dist.text);

    // 寄存器：模式只调「说话指针」，绝不能动身份和语气。
    // AIPlatform 踩过的坑：在干活模式写「少修饰」，结果同一个人格在干活时
    // 变成了另一个产品。所以这里明确写「不改语气」。
    const mode = layers["模式"];
    if (mode) push("register", "寄存器（只调说话指针，不改人格）", mode.text);

    const ctxL = layers["情境"];
    if (ctxL) {
      const t = ctxL.text.trim();
      const sub = pick(ctxL.subs["规则"]);
      push("scene", "情境反应", sub.length ? t + "\n" + sub.join("\n") : t);
    }

    const rep = layers["汇报"];
    if (rep) push("report", "汇报", rep.text);

    return { text: parts.join("\n\n"), truncated, sections };
  }
