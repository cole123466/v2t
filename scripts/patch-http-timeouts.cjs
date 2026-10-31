#!/usr/bin/env node
"use strict";
/**
 * 放宽 Node 对「请求体传输时长」的限制。
 *
 * 大视频经外网窄上行链路上传，request body 可能远超 Node 默认的
 * requestTimeout=300s（5 分钟）——一旦 5 分钟内 body 没收完，连接被服务端
 * 掐断，前端表现为「上传中断，文件不完整」（uploads 卡在某个百分比后 5 分钟报错）。
 *
 * 这里把 requestTimeout 关掉（0 = disabled）：请求头阶段的防护仍由
 * headersTimeout（60s）承担，恶意慢速请求不再成为服务端问题；
 * 真正卡死的上传由浏览器端 xhr.timeout（30 分钟）与用户取消兜底。
 */
const http = require("node:http");
const https = require("node:https");

const REQUEST_TIMEOUT_MS = 0; // 0 = 关闭 request body 总时长限制

for (const mod of [http, https]) {
  const original = mod.createServer;
  mod.createServer = function patchedCreateServer(...args) {
    const server = original.apply(this, args);
    server.requestTimeout = REQUEST_TIMEOUT_MS;
    return server;
  };
}
