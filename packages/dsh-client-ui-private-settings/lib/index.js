/**
 * Node-side half of @yg/dsh-client-ui-private-settings.
 *
 * 这个包只有浏览器侧的内容（往设置页加条目），node 半不挂任何服务。
 * 但 dsh 的 client 行要求包能解析到一个 node 入口，所以这里导出空插件。
 */

const name = "client-ui-private-settings";

function apply() {
  // 无 node 侧行为
}

export { apply, name };
