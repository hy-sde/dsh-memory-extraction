---
description: "在压缩检查点自动提取长期记忆：证据投影、提案/规范化流水线、受门控的 ctx.memory 提交，以及持久化的游标/回执/失败账本（Maka 移植，切片 No. 2）。"
kind: "package-reference"
---

# @hy-sde-org/dsh-memory-extraction

[English](README.md) | 中文

## 摘要

`dsh-memory-extraction` 是 Maka 自动记忆提取触发器的 DSH 移植：每次
`compaction/summary` 事件（检查点边界）之后，一个有界、失败开放的流水线投影
检查点范围内**用户撰写**的文本，用辅助模型调用提出并规范化持久事实，并把通过
的事实提交到 `retain`/`learn` 使用的同一项目记忆库。它严格**叠加**在 DSH 显式
记忆能力之上：`retain`/`learn`/`memory_edit` 工具仍是面向模型的路径，移植
有意保留（不移植）Maka 的 `memory_remember`/`memory_extract` 动词。

本包是**主机平面**的 Cordis 插件（`inject: ['memory', 'llm']`，不发布服务）：
每进程只打开一次 `memory_extraction` 控制单元，通过无作用域的
`ctx.on('session/event')` 监听器观察所有会话的事件（作用域过滤器全局接纳无
作用域监听器）。运行按会话串行，绝不阻塞压缩监听器。

### 承重规则（移植自 Maka）

1. **证据仅限用户撰写文本** —— 投影 `source.kind === 'user'` 的
   `user/message` 事件；助手文本仅作解读上下文；工具调用/结果、推理块和插件
   检查点保持不透明。证据有界（12 000 字符 JSON / 单条 4 000 字符 / 64 条）且
   **失败关闭**（溢出则跳过）。
2. **准入经核验** —— 提案 → 准入（对有界证据逐字核验引文 + 密钥拒绝）→
   规范化 → 再准入，每个范围最多 **3 次辅助模型调用**、60 秒超时；失败被包含
   （在运行时边界失败开放）。
3. **游标只推进到已提交边界** —— 空范围仍然推进（记无操作回执，不调用模型）；
   失败范围成为一条待处理记录，由下一次触发重试一次后丢弃。写入顺序为
   条目 → 游标 → 回执，因此游标与回执之间崩溃永远不会重复处理。
4. **幂等是确定性的** —— 操作 id = `memory_` + sha256(`{sessionId, trigger,
   boundarySeq}`)；回执使重放成为空操作，提交侧去重探测修复条目与回执之间的
   崩溃。
5. **排除子代理** —— 门控在每次模型调用后重新检查，默认拒绝子会话
   （`excludeSubagents: true`）。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知局限与延后工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用本包

该行属于**主机组合** —— 它注入主机服务（`memory`、`llm`），每进程打开一次
控制单元，且必须观察所有会话的事件。没有代理预设贡献，也没有工具。

```yaml
# host composition (loaded before any session)
- id: memory-extraction
  name: '@hy-sde-org/dsh-memory-extraction'
  config:
    backend: sqlite           # storage backend hosting the control unit (default sqlite)
    enabled: true             # master switch (default true)
    excludeSubagents: true    # child-agent compactions never extract (default true)
    # provider: <cheap provider id>  # optional; unset uses the session's routed model config
    # model: <cheap model id>        # optional; unset uses the session's routed model config
    importance: 0.5           # bank importance for auto-extracted facts (default 0.5)
    dedupe: true              # probe the bank before committing duplicates (default true)
    timeoutMs: 60000          # auxiliary call timeout (default 60000)
```

其存储后端必须暴露 `kv` 面（shipped 的 `sqlite` 后端可以；`storage-json`
不可以）—— 参见
[示例补丁](../../../apps/cli/config/examples/memory-extraction/cordis.yml)。
引擎本身是纯的，可在无 cordis 下测试：

```ts
import { MemoryExtractionEngine } from '@hy-sde-org/dsh-memory-extraction'

const engine = new MemoryExtractionEngine(ports) // readGate/readEvents/read+write cursor+receipt+failure/commitItems/generate
const result = await engine.execute(snapshot)   // never throws; idempotent by operation id
```

### 接线

插件异步启动：一个 effect 通过
`storage.backend.<backend>.kv.open(MemoryExtractionControlStore.descriptor)`
打开控制单元（`memory_extraction`，版本 1，表 `cursors`/`receipts`/`failures`）
并注册 `session/event` 监听器。后端缺失时记录日志并保持惰性，而不是让组合失败。

<a id="understand-the-implementation"></a>
## 理解实现

- `src/evidence.ts` —— 有界证据投影、覆盖规划（二分收缩、溢出失败关闭）、
  同会话本地化搜索、引文核验。
- `src/proposal.ts` —— 严格手写 JSON 解析（complete/`search_required`/
  `cannot_resolve`/规范化）、把证据标示为**不可信数据**的提示词构建、准入
  （逐字引文、最少 4 字符、密钥拒绝、NFC + 注入中和、内容上限 2 000 字符）。
- `src/control.ts` —— 单个 `KvUnit` 上的持久化游标/回执/失败存储（单一写入
  链；打开时自愈；写入顺序有文档说明）。
- `src/engine.ts` —— 状态机：幂等回执、门控、空范围推进、一次重试后丢弃、
  3 次调用预算、提交顺序。
- `src/events.ts` —— 有损的 DSH 事件投影（仅用户/助手文本，为本地化分组跟踪
  轮次）。
- `src/memory-adapter.ts` —— 基于 `ctx.memory` 的提交面（去重探测 +
  `save`，来源 `'memory_extract'`）与门控工厂。
- `src/runtime.ts` —— 主机接线：按会话的顺序队列、generate 适配器
  （`BlockAssembler`、`AbortSignal.timeout`、路由 provider/model 覆盖）、
  基于真实服务的同步/异步端口实现。

<a id="further-exploration"></a>
## 进一步探索

- 移植来源：Maka 仓库 `packages/runtime/src/memory-extraction.ts`。
- 产生边界事件的压缩生命周期：`@deepseek-ai/dsh-compaction`。

<a id="model-experience"></a>
## 模型体验

流水线对每个含用户文本的检查点范围最多增加 3 次辅助模型调用（提案、可选
本地化、规范化），每次受 `timeoutMs` 约束。大型部署建议把 `provider`/`model`
配置为廉价辅助模型；未配置时使用会话路由的请求头。模型从不接触原始日志或
工具结果 —— 只有有界的用户证据和一小段本地化上下文。

<a id="known-limitations-and-deferred-work"></a>
## 已知局限与延后工作

- **每会话仅一条待处理失败**（重试一次后丢弃）—— Maka 保有更丰富的失败
  状态（如证据增长重试），此处移植为单次延后重试。
- **证据增长不重提取**：失败的检查点只重试一次即丢弃。
- **Maka 侧面未移植**（kind/temporal/scope/tags）；每条提取事实以
  `source: 'memory_extract'` 与配置的重要性落库。
- **无逐动词工具**：`memory_remember`/`memory_extract` 为保留名；显式 DSH
  记忆工具仍是面向模型的路径。
- 去重探测依赖本地记忆库的 `search` 能看到先前提交的行（同进程语义）。
