/**
 * @yg/dsh-client-ui-agents 的 node 侧壳。
 *
 * 这个包只有浏览器侧的 UI（右侧栏「Agent 编队」页），node 端不挂任何服务。
 * 但 dsh 的 client 行要求包能解析到一个 node 入口，所以这里导出空插件。
 * 数据仍由 @yg/dsh-private-agents 的 /private/agents.json 提供。
 */

const name = "client-ui-agents";

function apply() {
  // node 侧无事可做
}

export { apply, name };
