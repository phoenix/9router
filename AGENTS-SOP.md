# 本机工作流 SOP（Windows / 家里机）

> 由此仓库的本地会话沉淀，上游不含此文件。**任何动手任务（合并 / 修 bug / 跑测试）先读本文件再动手**——这里的每一条都是实际踩坑换来的。机器特定路径仅适用于家里机。

## 上游合并标准流程（2026-10-09 v0.5.99 实战验证）

1. `git fetch upstream`（`.git` 写入需要 danger-full-access，沙箱内会 Permission denied）
2. **预演**：`git merge-tree --write-tree --name-only master upstream/master` 提前看冲突文件
3. 建备份分支 `backup/pre-merge-YYYYMMDD`，再 `git merge upstream/master --no-edit`
4. 冲突解决后，重新生成基线快照并**独立提交**（不要混进 merge commit）：
   ```
   node tests/__baseline__/snapshot-providers.mjs
   node tests/__baseline__/verify-alias.mjs --snapshot
   ```
5. 回归验证用「差集对比」（见下），确认零回归后清理 worktree

### 回归验证铁律：差集，不是绝对数

**回归 = 合并前后失败测试的差集**。套件常态约 100 个既有失败（Windows 环境实测），绝对失败数毫无意义。

```powershell
# 合并前基线（在合并之前，或事后用 backup 分支建 worktree）
git worktree add ..\9router-baseline backup/pre-merge-YYYYMMDD
# ⚠️ worktree 的 tests 依赖必须重装：cd tests && pnpm install --ignore-workspace
#   - robocopy 复制 node_modules 会把 pnpm junction 指向原仓库，全断
#   - 根目录 pnpm install 会把 tests 吸进 workspace，vitest 装不进 tests/

# 两侧同参数跑（cd tests 后）：
npx vitest run unit translator --reporter=json --outputFile=<绝对路径>.json

# 差集比对：写 10 行 node 脚本比两个 JSON 的 failed 集合，new-fails = after - before
```

## 测试运行的硬规则（Windows 陷阱清单）

| 陷阱 | 正确做法 |
|---|---|
| 上游 `verify-no-regression.mjs` 依赖路径里的 `/app/` 段，Windows 全报 `undefined ::`（104 个假回归） | **用本地 `tests/__baseline__/check-regression.mjs`**（af0bdb4e 为此而写） |
| `npx` 是 .ps1 被 execution policy 挡 | 用 `D:\Programs\node\npx.cmd` |
| 自创 `--root .` / `--dir` 参数 → setup.js 解析成 `/@id/E:/…` 路径，**360 个套件全崩** | **`cd tests` 后直接 `npx vitest run <路径>`**，路径相对 tests/ |
| cwd 传 `tests/unit`（cwd 已在 tests 里）→ 空报告（0 tests） | 同上，相对路径 |
| `--outputFile` 用相对路径可能写到意外位置 | 用绝对路径 |
| `tests/__baseline__/baseline-results.json` 是 **Mac 机器误提交的旧产物**（路径 `/Users/Working/router4/app/`） | 绝不能当基线；基线必须同机同环境当场跑 |
| vitest 有失败时退出码 1 是正常的 | 判定看差集，不是退出码 |

## 上游合并的常见测试滞后（上游自己不带）

- **版本号 bump**：golden 快照里 `User-Agent: 9Router/x.y.z`、`X-CLIENT-VERSION` 等过期 → golden-url-header 的 `sanitize()` 应屏蔽版本号（已修：严格 semver 正则，勿吞 `Retry-Count: 0` 这类纯数字头）
- **capabilities 数值变更**：上游改表（如 GLM-5.3 context 200k→1M，#4544）但不更新对应测试断言 → 断言跟能力表走
- **随机动态头**：minimax-code 的 `X-Mavis-Session-Id` 是每次请求的随机 UUID → sanitize 必须屏蔽，否则每次跑都"失败"

## 环境事实

- 本机 Node：`D:\Programs\node\`；pnpm：`X:\.npm\pnpm.cmd`；store：`E:\.pnpm-store\v11`
- vitest 4.x + `tests/vitest.config.js`（setupFiles + `open-sse`/`@` 别名）
- 9router 服务部署在别处（AI 服务器，见 Hindsight），本仓库是开发副本
- **tar 陷阱**：PATH 首位是 msys2 的 GNU tar（`D:\msys64\usr\bin\tar.exe`），它把 `E:\path` 这类盘符绝对路径解析为 `host:path` 远程语法，报 `Cannot connect to E: resolve failed` + `unexpected end of file`（tarball 本身没坏）。**tar 操作一律先 cd 到目标目录再用相对路径**（Windows 自带的 `C:\Windows\System32\tar.exe` 是 libarchive，无此问题但别依赖 PATH 顺序）
