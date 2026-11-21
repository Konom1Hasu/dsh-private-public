import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { projectKey, rankAndDedupe, shouldUseFts } from "../lib/core.mjs";

describe("projectKey：路径归一化与防裂库", () => {
  it("正反斜杠、大小写、重复斜杠、尾部斜杠算出同一个 key", () => {
    const k1 = projectKey("C:\\Users\\KonomiHasu\\.dsh");
    const k2 = projectKey("c:/users/konomihasu/.dsh/");
    const k3 = projectKey("C:\\Users\\KonomiHasu\\\\.dsh\\");
    assert.equal(k1, k2);
    assert.equal(k2, k3);
    assert.equal(k1.length, 12);
  });

  it("不同目录算出不同 key", () => {
    assert.notEqual(projectKey("C:\\projA"), projectKey("C:\\projB"));
  });
});

describe("rankAndDedupe：先排序再去重，防止自家记录被标成外库", () => {
  it("同签名记录在当前库与旧库同时命中时，保留当前库那条（__cur=true）", () => {
    const oldRow = { id: 1, project: "c:/ws", title: "规则A", body: "内容相同", hits: 10, __cur: false };
    const curRow = { id: 2, project: "c:/ws", title: "规则A", body: "内容相同", hits: 1, __cur: true };
    const top = rankAndDedupe([oldRow, curRow], 10);
    assert.equal(top.length, 1);
    assert.equal(top[0].__cur, true);
    assert.equal(top[0].id, 2);
  });

  it("非当前库记录按 hits 降序排列并受 limit 截断", () => {
    const rows = [
      { id: 1, project: "a", title: "t1", body: "b1", hits: 1, __cur: false },
      { id: 2, project: "b", title: "t2", body: "b2", hits: 9, __cur: false },
      { id: 3, project: "c", title: "t3", body: "b3", hits: 5, __cur: false },
    ];
    const top = rankAndDedupe(rows, 2);
    assert.deepEqual(top.map((r) => r.id), [2, 3]);
  });
});

describe("shouldUseFts：trigram 最小字数门槛", () => {
  it("3 字及以上中文走 FTS，2 字走 LIKE 兜底", () => {
    assert.equal(shouldUseFts("孤儿包"), true);
    assert.equal(shouldUseFts("孤儿"), false);
    assert.equal(shouldUseFts("  abc  "), true);
    assert.equal(shouldUseFts("ab"), false);
  });
});
