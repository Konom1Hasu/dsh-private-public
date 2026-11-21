/**
 * 任务状态机的回归测试。
 *
 * 原则：测「输入 → 输出」的行为，不测内部结构。
 * 改实现（换数据结构、换算法）不该让这些测试红；改行为才该红。
 *
 * 跑：node --test packages/dsh-private-tasks/test/
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  TASK_STATES,
  BLOCK_KINDS,
  TaskError,
  assertState,
  assertBlockKind,
  assertBlockQuestion,
  canOverrideBlock,
  canUnblock,
  canStartRun,
  statusAfterRunEnd,
  statusAfterUnblock,
  displayState,
} from "../lib/core.mjs";

describe("状态合法性", () => {
  test("五种合法状态都能通过", () => {
    for (const s of TASK_STATES) assert.equal(assertState(s), s);
  });

  test("未知状态被拒，且带 code", () => {
    assert.throws(() => assertState("doing"), (e) => e instanceof TaskError && e.code === "bad-state");
  });

  test("空值不会被当成合法状态", () => {
    assert.throws(() => assertState(""), (e) => e.code === "bad-state");
    assert.throws(() => assertState(undefined), (e) => e.code === "bad-state");
  });

  test("阻塞原因只认四个枚举", () => {
    for (const k of BLOCK_KINDS) assert.equal(assertBlockKind(k), k);
    assert.throws(() => assertBlockKind("because"), (e) => e.code === "bad-kind");
  });
});

describe("模型标阻塞必须给问题", () => {
  test("模型不给 question 被拒", () => {
    assert.throws(
      () => assertBlockQuestion("model", ""),
      (e) => e.code === "need-question",
    );
    assert.throws(() => assertBlockQuestion("model", undefined), (e) => e.code === "need-question");
  });

  test("只有空白也算没给", () => {
    assert.throws(() => assertBlockQuestion("model", "   \n\t "), (e) => e.code === "need-question");
  });

  test("模型给了问题就放行", () => {
    assert.equal(assertBlockQuestion("model", "先做哪个"), "先做哪个");
  });

  test("人工和系统不需要给问题", () => {
    assert.equal(assertBlockQuestion("human", undefined), null);
    assert.equal(assertBlockQuestion("system", undefined), null);
  });
});

describe("阻塞覆盖优先级：人工 > 系统 > 模型", () => {
  test("没人标过，谁都能标", () => {
    assert.equal(canOverrideBlock(undefined, "model"), true);
    assert.equal(canOverrideBlock(undefined, "human"), true);
  });

  test("人工标了，模型和系统都盖不了", () => {
    assert.equal(canOverrideBlock("human", "model"), false);
    assert.equal(canOverrideBlock("human", "system"), false);
  });

  test("系统标了，模型盖不了，人工可以", () => {
    assert.equal(canOverrideBlock("system", "model"), false);
    assert.equal(canOverrideBlock("system", "human"), true);
  });

  test("模型标了，系统和人工都能盖", () => {
    assert.equal(canOverrideBlock("model", "system"), true);
    assert.equal(canOverrideBlock("model", "human"), true);
  });

  test("同级可以互相覆盖（模型重标一次不算越权）", () => {
    assert.equal(canOverrideBlock("model", "model"), true);
  });
});

describe("解除阻塞", () => {
  test("人工标的只能人工解", () => {
    assert.equal(canUnblock("human", "human"), true);
    assert.equal(canUnblock("human", "model"), false);
    assert.equal(canUnblock("human", "system"), false);
  });

  test("系统或模型标的，人工能解", () => {
    assert.equal(canUnblock("system", "human"), true);
    assert.equal(canUnblock("model", "human"), true);
  });
});

describe("执行记录开闭", () => {
  test("完成或取消的任务不能再开 run", () => {
    assert.equal(canStartRun("done"), false);
    assert.equal(canStartRun("cancelled"), false);
  });

  test("其余状态都能开", () => {
    assert.equal(canStartRun("pending"), true);
    assert.equal(canStartRun("in_progress"), true);
    assert.equal(canStartRun("blocked"), true);
  });
});

describe("run 结束后任务的状态流转", () => {
  test("执行失败不完结任务 —— 任务还在，只是这次没成", () => {
    assert.equal(statusAfterRunEnd("in_progress", "failed", 0), "in_progress");
  });

  test("失败时任务原本是 pending，会推进到 in_progress", () => {
    assert.equal(statusAfterRunEnd("pending", "failed", 0), "in_progress");
  });

  test("成功但还有别的 run 在跑，任务不结", () => {
    assert.equal(statusAfterRunEnd("in_progress", "done", 1), "in_progress");
  });

  test("成功且没有别的 run，任务完成", () => {
    assert.equal(statusAfterRunEnd("in_progress", "done", 0), "done");
  });

  test("放弃（abandoned）也不完结任务", () => {
    assert.equal(statusAfterRunEnd("in_progress", "abandoned", 0), "in_progress");
  });
});

describe("解除阻塞后的状态回退", () => {
  test("从 pending 来的回 pending，不假装在做", () => {
    assert.equal(statusAfterUnblock("pending", false), "pending");
  });

  test("从 in_progress 来的回 in_progress", () => {
    assert.equal(statusAfterUnblock("in_progress", true), "in_progress");
  });

  test("旧数据没有记录时按有没有跑过推断", () => {
    assert.equal(statusAfterUnblock(undefined, true), "in_progress");
    assert.equal(statusAfterUnblock(undefined, false), "pending");
  });

  test("记录里存的是 blocked 本身时不采信", () => {
    assert.equal(statusAfterUnblock("blocked", false), "pending");
  });

  test("记录里是非法值时不采信", () => {
    assert.equal(statusAfterUnblock("garbage", true), "in_progress");
  });
});

describe("对外展示状态", () => {
  const fresh = { status: "in_progress", updated_at: Date.now() };
  const stale = { status: "in_progress", updated_at: Date.now() - 30 * 60_000 };

  test("阻塞和完结直接透传", () => {
    assert.equal(displayState({ status: "blocked" }, 0), "blocked");
    assert.equal(displayState({ status: "done" }, 0), "done");
    assert.equal(displayState({ status: "cancelled" }, 0), "cancelled");
  });

  test("有 run 在跑就是在做", () => {
    assert.equal(displayState({ status: "pending" }, 1), "in_progress");
  });

  test("标着在做但很久没动，报 stalled", () => {
    assert.equal(displayState(stale, 0), "stalled");
    assert.equal(displayState(fresh, 0), "in_progress");
  });

  test("没有 run 也没有更新时间，不误报 stalled", () => {
    assert.equal(displayState({ status: "pending" }, 0), "pending");
  });
});
