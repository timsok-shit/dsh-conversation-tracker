// dsh-conversation-tracker 的 host 侧：无行为（纯 client 修复/增强插件）。
// 本文件仅作为 loader entry 存在，使 cordis 将其装配为条目，
// 从而由 client-modules 扫描发现并注入 /plugins/dsh-conversation-tracker/client.js。
function apply() {}

module.exports = { apply }