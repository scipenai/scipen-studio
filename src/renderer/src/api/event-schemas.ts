/**
 * @file event-schemas.ts — 渲染层入境的 IPC 事件 payload 中央 schema
 *
 * @description
 *   与 main 端 `src/main/ipc/ipcSchemas.ts`(校验 invoke args 入境)对称 —— 这里
 *   校验 event payload 入境(`webContents.send` → renderer)。任何形状不合法的推送
 *   在通用 `onEvent` 入口处直接 drop,等同于"网络丢包",杜绝下游消费者 destructure
 *   undefined / 字段缺失的 render-time 崩溃。
 *
 *   设计要点:
 *   - **渐进迁移**:`eventSchemas` Map 命中即校验,没命中则透传 —— 旧 channel 不必
 *     一次性补齐,新 channel 默认强制声明。
 *   - **单一来源**:schema 反推 TS 类型(`z.infer`),与 `shared/ipc/*.ts` 的
 *     interface 共存:interface 描述结构(供 IDE / 编译期),schema 描述"是否合法"
 *     (供运行期)。当二者写法分歧,以 schema 为准(运行期事实)。
 *   - **共享给 invoke 返回值**:某些 channel 的 invoke 返回值与 event payload 共形
 *     (如 `App_CheckUpdate` 返回 `UpdateStatus`,与 `App_UpdateStatus` event 同形),
 *     可复用同一份 schema —— 见下方 `updateStatusSchema` 的 export。
 *
 *   未来新 event channel 接入流程:
 *   1. 在 `shared/ipc/<domain>-contract.ts` 定义 TS interface(IDE 类型提示)。
 *   2. 此文件用 zod 写对应 schema,注册到 `eventSchemas`。
 *   3. 在 `ALLOWED_EVENT_CHANNELS` 白名单加 channel(`preload/api/_shared.ts`)。
 *   4. 消费侧 `api.xxx.onYyy` 单行透传给 `onEvent`,无需自己 guard。
 */

import { z } from 'zod';
import { IpcChannel } from '../../../../shared/ipc/channels';

// ============================================================================
// Reusable atom schemas
// ============================================================================

/**
 * `UpdateStatus`(`shared/ipc/app-contract.ts`)的运行期 schema。同时被
 * `App_UpdateStatus` event 与 `App_CheckUpdate` invoke 返回值复用。
 *
 * 仅校验"够 destructure 不炸"的关键字段(`state` 字面量集合 + `currentVersion`
 * 必填字符串)。`info` / `progress` / `error` 可选 —— 渐进式严格,不阻塞已知合法的
 * 历史 payload 形状。
 */
export const updateStatusSchema = z.object({
  state: z.enum([
    'idle',
    'checking',
    'available',
    'not-available',
    'downloading',
    'downloaded',
    'error',
  ]),
  currentVersion: z.string(),
  info: z
    .object({
      version: z.string(),
      releaseNotes: z.string().optional(),
      releaseDate: z.string().optional(),
    })
    .optional(),
  progress: z
    .object({
      percent: z.number(),
      bytesPerSecond: z.number(),
      total: z.number(),
      transferred: z.number(),
    })
    .optional(),
  error: z.string().optional(),
});

// ============================================================================
// Event channel registry
// ============================================================================

/**
 * 渠道 → schema 注册表。`onEvent` 在 forward 给消费者之前,会用 schema 校验 payload。
 * 没在表里的 channel 走透传(向后兼容,渐进迁移)。
 *
 * 维护原则:
 * - **结构化对象 payload**(消费者会 destructure 字段)— 必须注册 schema。
 * - **字符串 / 数字 / void payload** — 注册与否皆可(destructure 不会崩)。
 * - **高频推送通道**(状态机驱动 UI)— 建议注册,避免单帧 race 把组件 state 顶坏。
 */
export const eventSchemas: ReadonlyMap<IpcChannel, z.ZodSchema> = new Map<
  IpcChannel,
  z.ZodSchema
>([[IpcChannel.App_UpdateStatus, updateStatusSchema]]);
