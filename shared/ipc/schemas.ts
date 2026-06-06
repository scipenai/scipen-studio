/**
 * @file schemas.ts — IPC 边界中央 schema 注册表(cross-process)
 *
 * @description
 *   与 main 端 `src/main/ipc/ipcSchemas.ts`(校验 invoke args 入境)对称 ——
 *   本文件提供两类入境校验:
 *
 *   - `eventSchemas`:校验 event payload(`webContents.send` → renderer)。
 *     两条消费路径都守门 —— preload `createSafeListener`(`window.api.xxx.onYyy`
 *     包装桥)与 renderer `onEvent`(`window.electron.ipcRenderer.on` 通用桥)
 *     共用同一份注册表。
 *
 *   - `invokeResultSchemas`:校验 invoke 返回值(`ipcRenderer.invoke` resolve)。
 *     main 端 `channelSchemas` 守 args 入境,本表与之配对守 result 入境,
 *     形成"双向都守边界"的 RPC 契约。
 *
 *   设计要点:
 *   - **渐进迁移**:两个 Map 命中即校验,没命中则透传 —— 旧 channel 不必一次性
 *     补齐,新 channel 默认强制声明。
 *   - **单一来源**:schema 反推 TS 类型(`z.infer`),与 `shared/ipc/*.ts` 的
 *     interface 共存。运行期事实以 schema 为准。
 *   - **共享 atom schemas**:某些 channel 的 invoke 返回值与 event payload 共形
 *     (如 `App_CheckUpdate` invoke 与 `App_UpdateStatus` event 都返回
 *     `UpdateStatus`),用同一份 schema 复用。
 *
 *   新 channel 接入流程:
 *   1. 在 `shared/ipc/<domain>-contract.ts` 定义 TS interface(IDE 类型提示)。
 *   2. 此文件用 zod 写对应 schema。
 *   3. 注册到 `eventSchemas` 或 `invokeResultSchemas`(或两者)。
 *   4. 白名单 `preload/api/_shared.ts` 的 ALLOWED_{INVOKE,EVENT}_CHANNELS 加 channel。
 *   5. 消费侧无需自己 guard —— 边界已守门。
 */

import { z } from 'zod';
import { IpcChannel } from './channels';

// ============================================================================
// Reusable atom schemas
// ============================================================================

/**
 * `UpdateStatus`(`shared/ipc/app-contract.ts`)的运行期 schema。同时被
 * `App_UpdateStatus` event 与 `App_CheckUpdate` invoke 返回值复用。
 *
 * 仅校验"够 destructure 不炸"的关键字段(`state` 字面量集合 + `currentVersion`
 * 必填字符串)。`info` / `progress` / `error` 可选 —— 渐进式严格,不阻塞已知
 * 合法的历史 payload 形状。
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
// Event channel registry — 校验 main → renderer 推送 payload
// ============================================================================

/**
 * Event payload 校验表。preload `createSafeListener` 与 renderer `onEvent` 均
 * 在 forward 前 safeParse。
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

// ============================================================================
// Invoke result registry — 校验 main → renderer invoke 返回值
// ============================================================================

/**
 * Invoke 返回值校验表。renderer `invoke<T>` 在 await 后 safeParse,非法 throw
 * `IpcResultValidationError`,消费者可用 try/catch 处理为网络错误等价物。
 *
 * 与 main 端 `channelSchemas`(args 入境)配对,形成 RPC 双向边界守门 ——
 * args 入境由 main 守,result 入境由 renderer 守。
 */
export const invokeResultSchemas: ReadonlyMap<IpcChannel, z.ZodSchema> = new Map<
  IpcChannel,
  z.ZodSchema
>([[IpcChannel.App_CheckUpdate, updateStatusSchema]]);

/**
 * Invoke 返回值校验失败时抛出。让消费者能用 `instanceof` 区分"IPC 透传错误"
 * (handler 自己 throw 的)与"边界校验拒收"(handler return 值不合形状)。
 */
export class IpcResultValidationError extends Error {
  constructor(
    public readonly channel: IpcChannel,
    public readonly issues: unknown
  ) {
    super(`[invoke] '${channel}' returned malformed payload`);
    this.name = 'IpcResultValidationError';
  }
}
