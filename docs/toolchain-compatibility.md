# 工具链兼容性验证记录

## 2026-08-20：初始候选组合（失败）

### 验证环境

- Node.js：24.15.0，官方 Linux x64 临时运行时
- pnpm：10.34.5
- workspace：`apps/web`、`packages/contracts`、`packages/domain`、`packages/db`
- 锁文件：根级 `pnpm-lock.yaml`

### 结果

| 检查         | 结果       | 证据摘要                                                                                                                         |
| ------------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 精确依赖安装 | 有条件失败 | 依赖与锁文件生成完成，但出现 TypeScript 7 / typescript-eslint 及 ESLint 10 / Next.js 传递插件的 peer 不满足；按 D-183 不计为通过 |
| 独立类型检查 | 通过       | 4 个 workspace 全部通过 TypeScript 7.0.2 严格检查                                                                                |
| 单元测试     | 通过       | Vitest 4.1.11：3 个测试文件、4 个测试全部通过                                                                                    |
| 生产构建     | 通过       | Next.js 16.3.1 编译、TypeScript 检查和页面生成通过；`/` 与 `/attribution` 为动态服务端路由                                       |
| lint         | 失败       | typescript-eslint 8.67.0 检测到 TypeScript 7.0.2 后主动终止，因为 TypeScript 7.0 暂不提供其所需程序化 API                        |

### 兼容性结论

当前组合不能冻结。TypeScript 7.0.2 的命令行编译能力可用，但 lint 工具仍需要 TypeScript 6 程序化 API；同时 `eslint-config-next` 的传递插件尚未声明支持 ESLint 10。正式功能扩展保持暂停，直至独立批准并验证兼容修订。

### 修订方案

- 保留 TypeScript 7.0.2 作为应用类型检查器。
- 按 TypeScript 官方并行方案增加 `@typescript/typescript6` 6.0.2 API 兼容包。
- ESLint 从 10.8.1 调整为其传递插件均声明支持的 9.39.5。

该修订随后获得批准，并按下述最终组合完成验证。

## 2026-08-20：D-184 修订组合（通过）

### 最终组合

- TypeScript 7.0.2：全部 workspace 的权威命令行类型检查器。
- `@typescript/typescript6` 6.0.2：根级 `typescript` API 兼容包，仅供 ESLint 工具链。
- TypeScript 7.0.2 Web 直接依赖：供 Next.js `experimental.useTypeScriptCli` 构建检查。
- ESLint 9.39.5、typescript-eslint 8.67.0、eslint-config-next 16.3.1。

### 最终结果

| 检查         | 结果 | 证据摘要                                                                                 |
| ------------ | ---- | ---------------------------------------------------------------------------------------- |
| 冻结安装     | 通过 | pnpm 10.34.5 在 `strict-peer-dependencies=true` 下完成，冻结锁文件复验通过，无 peer 冲突 |
| lint         | 通过 | ESLint 9.39.5 对正式 workspace 和根级配置零错误、零警告                                  |
| 独立类型检查 | 通过 | 4 个 workspace 全部使用 TypeScript 7.0.2 通过严格检查                                    |
| 单元测试     | 通过 | Vitest 4.1.11：3 个测试文件、4 个测试全部通过                                            |
| 生产构建     | 通过 | Next.js 16.3.1 在 TypeScript 7 CLI 模式完成构建；`/` 与 `/attribution` 为动态服务端路由  |

### 结论

D-184 修订组合满足 D-183，可以正式冻结。初始失败组合继续保留为负面兼容性证据；升级 TypeScript、ESLint、typescript-eslint 或 Next.js 时必须重新执行完整闸门。
