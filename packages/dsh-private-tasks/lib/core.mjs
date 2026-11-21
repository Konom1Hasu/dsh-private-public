/**
 * 任务状态机的纯逻辑。
 *
 * 为什么抽出来：这些判断（状态合法、谁能覆盖谁的阻塞、模型要不要给问题）
 * 是整块最该测的部分，但它们原本埋在 `blockTask` / `setStatus` 里，
 * 那两处都连着 SQLite，测一次要建库、造数据、清理，成本高到没人愿意写。
 * 抽成纯函数之后，测试只喂输入看输出，不碰数据库。
 *
 * 模块本身不 import 任何东西，所以测试也不需要 dsh 的依赖。
 */

/** 任务状态。blocked 单独存在，因为它要人介入，和「正在做」是不同性质。 */
export const TASK_STATES = ["pending", "in_progress", "blocked", "done", "cancelled"];

/** 阻塞原因。限定枚举，防止模型用自由文本把 blocked 变成垃圾桶。 */
export const BLOCK_KINDS = ["need_decision", "need_credential", "need_external_info", "system_timeout"];

/**
 * 谁能改 blocked：人工 > 系统 > 模型。
 *
 * 优先级不是礼节，是防滥用：模型自己报「阻塞」的成本必须高于自己解决。
 */
export const BLOCK_PRIORITY = { model: 1, system: 2, human: 3 };

/** run 的终态。failed 不等于任务失败，只是这次执行没成。 */
export const RUN_STATES = ["running", "done", "failed", "abandoned"];

/** 判定用的小错误，调用方靠 code 区分，不靠 message 文本。 */
export class TaskError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function assertState(status) {
  if (!TASK_STATES.includes(status)) {
    throw new TaskError("bad-state", `未知状态: ${status}`);
  }
  return status;
}

export function assertBlockKind(kind) {
  if (!BLOCK_KINDS.includes(kind)) {
    throw new TaskError("bad-kind", `kind 必须是 ${BLOCK_KINDS.join(" / ")}`);
  }
  return kind;
}

/**
 * 模型标阻塞必须写清 question。
 *
 * 写不出具体问题，说明它自己还能继续推进 —— 这道闸就是防「什么都报阻塞」
 * 把 blocked 这个状态用废。
 */
export function assertBlockQuestion(by, question) {
  if (by !== "model") return question ?? null;
  const q = String(question ?? "").trim();
  if (!q) {
    throw new TaskError(
      "need-question",
      "模型标阻塞必须写清 question（要人回答什么）。写不出具体问题，说明你自己还能继续推进，别报阻塞。",
    );
  }
  return q;
}

/**
 * 现有阻塞能否被新的来源覆盖。
 *
 * 人工标的只有人工能改；系统能盖模型的；模型盖不了任何人。
 * 返回 true 表示可以覆盖。
 */
export function canOverrideBlock(existingBy, incomingBy) {
  if (!existingBy) return true;
  const prev = BLOCK_PRIORITY[existingBy] ?? 0;
  const cur = BLOCK_PRIORITY[incomingBy] ?? 0;
  return cur >= prev;
}

/** 人工标的阻塞只能人工解除。 */
export function canUnblock(existingBy, by) {
  if (existingBy !== "human") return true;
  return by === "human";
}

/** 已完成或已取消的任务不能再开执行记录。 */
export function canStartRun(status) {
  return status !== "done" && status !== "cancelled";
}

/**
 * 一次 run 结束后任务该是什么状态。
 *
 * 关键：失败不自动完结任务 —— 任务还在，只是这次执行没成，可以重试。
 * 只有「全部 run 都结束了且这次成功」才算完成。
 */
export function statusAfterRunEnd(taskStatus, runStatus, otherRunningCount) {
  if (runStatus !== "done") return taskStatus === "pending" ? "in_progress" : taskStatus;
  if (otherRunningCount > 0) return taskStatus;
  return "done";
}

/**
 * 解除阻塞后任务回到什么状态。
 *
 * 不能一律回 in_progress：一条还没开始的 pending 任务被标阻塞再解除，
 * 它仍然是没开始，硬推成「在做」会让工作台显示假进度。
 *
 * 优先用阻塞前记下的状态；没有记录（旧数据）才按「有没有跑过」推断。
 */
export function statusAfterUnblock(statusBefore, hasRuns) {
  if (statusBefore && TASK_STATES.includes(statusBefore) && statusBefore !== "blocked") {
    return statusBefore;
  }
  return hasRuns ? "in_progress" : "pending";
}

/**
 * 任务当前该显示的状态标签。
 *
 * 和 status 分开：status 是存的值，这里是对外展示的判定，
 * 因为「卡住」要看有没有 run 在跑、跑了多久。
 */
export function displayState(task, runningCount, stallMinutes = 20) {
  if (task.status === "blocked") return "blocked";
  if (task.status === "done") return "done";
  if (task.status === "cancelled") return "cancelled";
  if (runningCount > 0) return "in_progress";
  if (task.status === "in_progress") {
    // 标着在做但没有 run 在跑 —— 可能刚结束，也可能是状态没更新
    const stale = task.updated_at && Date.now() - task.updated_at > stallMinutes * 60_000;
    return stale ? "stalled" : "in_progress";
  }
  return "pending";
}
