# 本目录的来源与改动说明

## 来源

本目录是 [Clash Verge Rev](https://github.com/clash-verge-rev/clash-verge-rev) 的源码副本，
基于上游 **v2.5.4**（commit `a1dae06`，2026-08-23）。

原作者版权与许可证见同目录下的 `LICENSE`（**GNU GPL-3.0-only**）。本副本沿用同一许可证。

## 为什么是复制而不是 fork

纯个人使用，不打算发布，也不打算把改动提交回上游，所以直接复制源码而没有建立 fork 关系。

## 改动内容（2026-08-24）

在代理页面加了一个「一键推送美国节点到自建 Deno 订阅服务」的按钮，位置在测延迟按钮旁边。

改动刻意做得很薄，**只碰了上游一个文件、共 5 行**，其余全是新增文件 —— 这样以后同步上游
新版本时几乎不会有冲突。

| 文件 | 性质 | 说明 |
|---|---|---|
| `src/services/deno-push.ts` | 新增 | 全部逻辑：读节点、解析、GeoIP 筛美国、选点、推送 |
| `src/components/proxy/deno-push-button.tsx` | 新增 | 按钮和设置面板 |
| `src/services/deno-push.test.ts` | 新增 | 单元测试 |
| `src/components/proxy/proxy-head.tsx` | **修改（+5 行）** | 一句 import + 三行渲染按钮 |
| `.github/workflows/` | 删除 | 上游自己的发布/签名/公证/更新器/TG 通知流程，自用不需要。<br>本项目的构建流程在仓库根目录 `.github/workflows/build-client.yml` |

除此之外没有改动上游代码。

## 同步上游新版本的做法

```bash
# 1. 把上游对应版本的源码拉到临时目录
git clone --depth 1 --branch <新版本tag> \
  https://github.com/clash-verge-rev/clash-verge-rev /tmp/cvr-new

# 2. 先把自己的改动存成补丁
cd client
git diff HEAD -- src/components/proxy/proxy-head.tsx > /tmp/my-change.patch

# 3. 用新版本覆盖(注意排除 .git / node_modules / target)
#    然后把三个新增文件拷回来,再 git apply /tmp/my-change.patch

# 4. 验证
pnpm i && pnpm typecheck && pnpm test && pnpm lint
```

如果 `proxy-head.tsx` 那 5 行打不上（上游重构了那个组件），去新版里找到测延迟按钮
（`NetworkCheckRounded` 那个 `IconButton`），在它后面插一行 `<DenoPushButton />` 即可。

## 使用方法

1. 打开代理页面，先点**测延迟**按钮（推送用的是内核里已有的延迟数据，不会自己重测）
2. 点旁边的**上传图标**：
   - 第一次会弹设置，填 Deno 的 `/push` 地址和 `PUSH_KEY`
   - 之后单击即推送，**右键**可以再改设置

设置存在系统的应用数据目录下 `deno-push/settings.json`（不在本仓库里，密钥不会进 git）。

### 筛选规则

- **只推美国节点**，判据是 GeoIP 查服务器真实 IP，**不看节点名**。
  机场的命名五花八门（`🇺🇸 美国 洛杉矶 01`、`US-LA-01`、`United States 03`…），
  拿名字当门槛会误杀一大片。
- 严格模式（默认开）下，GeoIP 查不到的节点也不要 —— 在"只要美国"的前提下，
  "验证不了"和"验证不通过"应该同等对待。
- 延迟超过阈值（默认 800ms）的不推。
- 按协议轮转选点，取满上限（默认 100）为止 —— 保证各协议都有代表，
  否则订阅服务那边按协议过滤后可能某个客户端一个节点都不剩。
- 凑不够最少节点数（默认 10）就**不推**，保住服务端上一批，防止推空导致全家断网。

## 构建

见仓库根目录的 `.github/workflows/build-client.yml`。打 `client-v*` 的 tag 会自动出
macOS（Apple 芯片 / Intel）、Windows、Linux 的包并发 Release。

本地构建：

```bash
cd client
pnpm i
pnpm run prebuild <目标平台三元组>   # 下载 mihomo 内核 sidecar
pnpm build
```

**没有做代码签名**，首次打开时 macOS 的 Gatekeeper 和 Windows 的 SmartScreen 会拦一下，
按提示放行即可。去掉这些提示需要 Apple 开发者账号和代码签名证书。
