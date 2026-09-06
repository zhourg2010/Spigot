# rClash 的来源与改动说明

## 来源

本仓库是 [Clash Verge Rev](https://github.com/clash-verge-rev/clash-verge-rev) 的源码副本，
基于上游 **v2.5.4**（commit `a1dae06`，2026-08-23）。

原作者版权与许可证见仓库根目录的 `LICENSE`（**GNU GPL-3.0-only**）。本副本沿用同一许可证。

## 为什么是复制而不是 fork

纯个人使用，不打算把改动提交回上游，所以直接复制源码而没有建立 fork 关系。

## 迁移记录（2026-08-27）

这份源码原来住在 [nodes-sub](https://github.com/zhourg2010/nodes-sub) 的 `client/` 子目录里，
2026-08-27 用 `git subtree split` 抽出来独立成仓库，三条提交的历史都保留着。
nodes-sub 那边的 `client/` 和 `build-client.yml` 已经删掉，只在 README 里留了一句指路。

## 改动内容（2026-08-24）

在代理页面加了一个「一键推送美国节点到自建 Deno 订阅服务」的按钮，位置在测延迟按钮旁边。

> 2026-08-27 改成了侧边栏独立一页,见下面那一节。这里保留原始记录。

| 文件 | 性质 | 说明 |
|---|---|---|
| `src/services/deno-push.ts` | 新增 | 全部逻辑：读节点、解析、GeoIP 筛美国、选点、推送 |
| `src/components/proxy/deno-push-button.tsx` | 新增 | 按钮和设置面板(后来删了) |
| `src/services/deno-push.test.ts` | 新增 | 单元测试 |
| `src/components/proxy/proxy-head.tsx` | 修改（+5 行） | 一句 import + 三行渲染按钮(后来撤回了) |
| `.github/workflows/` | 替换 | 上游自己的发布/签名/公证/更新器/TG 通知流程，自用不需要，全部删掉。<br>本仓库的构建流程是新写的 `.github/workflows/build.yml` |

除此之外没有改动上游代码。

## 改动内容(2026-08-27):推送功能改成侧边栏独立一页

原来是代理页顶部那排按钮里的一个小图标 + 一个弹窗。现在是左边导航栏**最后一项「Deno Push」**。

理由是弹窗太挤:设置有六项、推送报告有六行,两样挤在一个 460px 的对话框里,而且报告得先
点开设置才看得到。摊成一页之后还能把「先测延迟再推送」这条前提直接写在页面上,而不是藏在
弹窗底部的小字里。

`src/services/deno-push.ts` **一行没改** —— 换掉的只是界面。

| 文件 | 性质 | 说明 |
|---|---|---|
| `src/pages/deno-push.tsx` | 新增 | 整页:推送按钮 + 报告 + 设置表单 |
| `src/components/proxy/deno-push-button.tsx` | **删除** | 被上面那一页取代 |
| `src/components/proxy/proxy-head.tsx` | **撤回改动** | 我们加的 5 行去掉了,这个文件现在**跟上游一模一样** |
| `src/pages/_navigation-meta.ts` | 修改(+6 行) | 加一条 `denoPush` |
| `src/pages/_navigation.tsx` | 修改(+12 行) | 导入页面、加图标和条目 |
| `src/locales/en/layout.json`<br>`src/locales/zh/layout.json` | 修改(各 +1 行) | 导航标签 `"denoPush": "Deno Push"` |
| `src/types/generated/i18n-*.ts` | 生成物 | `node scripts/generate-i18n-keys.mjs` 重新生成,不用手改 |

几个当时想清楚了的点,免得以后重踩:

- **为什么排在最后不用额外处理**:侧边栏顺序是用户可拖拽、存在配置里的。
  `use-nav-menu-order.ts` 的 `resolveMenuOrder` 会把「存下来的顺序里没有的 path」按
  `navItems` 的顺序补在**末尾**,所以老用户升级上来这一项自然排最后,不会插到中间。

- **为什么语言包只改 en 和 zh**:`t()` 是**强类型**的,类型由
  `scripts/generate-i18n-keys.mjs` 从 `src/locales/en` 生成 —— 所以 en 必须有,
  不然 `t('...denoPush')` 直接编译不过。而运行时 `fallbackLng` 是 `zh`,另外 11 种
  语言查不到时会落到 zh。两个都填 `"Deno Push"`,13 种语言就全覆盖了。
  (名字是专有名词,本来也不需要翻译。)

- **图标给了两个一样的**:`icon` 是个数组,`[0]` 是展开态的 MUI 图标,`[1]` 是折叠态
  用的自绘 svg。上游每一项都配了一套 svg,我们没有,`[1]` 给 null 会渲染出一个空洞,
  所以两个位置都用 `CloudUploadOutlinedIcon`。

- **路由不用动**:`_routers.tsx` 是从 `navItems` 生成的,加了导航项路由自动就有了。

- **上游冲突面变大了一点**:从「1 个文件 5 行」变成「4 个上游文件」。但 `proxy-head.tsx`
  回到了跟上游完全一致,新碰的两个导航文件都很小、改动都是**追加**在列表末尾,语言包那两处
  是往 JSON 对象里加一个键 —— 都属于最容易合的那种。

## 改动内容(2026-08-25):改名为 rClash

上游的名字、应用 ID、开机自启任务名等等在系统里都是**全局唯一的键**。如果沿用上游的值,
这个客户端和机器上已经装着的 Clash Verge Rev 会互相打架 —— 共用同一个配置目录、抢同一把
单实例锁、覆盖对方的开机自启任务。所以改名不只是换个显示文字,下面这些是**功能性**的:

| 文件 | 改了什么 | 为什么必须改 |
|---|---|---|
| `src-tauri/tauri.conf.json` | `productName` → `rClash`<br>`identifier` → `io.github.zhourg2010.rclash` | identifier 决定应用数据目录和单实例锁 |
| `src-tauri/tauri.windows.conf.json` | 同上的 `identifier` | 两份配置里的 id 必须一致 |
| `src-tauri/src/utils/dirs.rs` | `APP_ID` / `BACKUP_DIR` | 代码里直接用 APP_ID 拼数据目录,必须和 identifier 对齐 |
| `src-tauri/src/utils/schtasks.rs` | 计划任务名 → `rClash` / `rClash (Admin)` | Windows 计划任务名全局唯一,同名会互相覆盖 |
| `src-tauri/src/utils/init.rs` | `clash://` 协议处理器的显示名 | 注册表里的显示名,改对即可(协议键本身共用是设计如此) |
| `src-tauri/src/lib.rs`、`utils/resolve/window.rs` | 窗口标题 | 纯显示 |
| `src-tauri/src/utils/macos_launch_guard.rs` | 一处兜底文件名 | 纯显示,基本走不到 |
| `src/index.html` | `<title>` | 纯显示 |
| `package.json` | `name` | 纯标识 |
| `src-tauri/tauri.linux.conf.json`、`tauri.macos.conf.json` | `identifier` | **必须改**:这两份是平台覆盖配置,漏改的话 Linux/macOS 构建会用旧 id,跟 dirs.rs 对不上 |
| `src-tauri/packages/windows/installer.nsi` | 4 处 `$APPDATA\<id>\` 路径 | **必须改**:安装/卸载时会删这个目录下的 window-state.json。不改的话删的是**用户真正的 Clash Verge Rev 数据目录** |
| `src-tauri/packages/macos/entitlements.plist` | app group | 必须跟 bundle id 一致 |
| `src-tauri/Cargo.toml` | `[package.metadata.bundle] identifier` | Tauri v2 不读它,但留旧值会误导 |
| `src-tauri/webview2.*.json` | `identifier` + 更新端点 | 固定版 WebView2 的备用配置,当前 workflow 没用到,一并对齐避免以后踩坑 |

**故意没改**的两处:

- `src-tauri/src/utils/dirs.rs` 的 `#[cfg(test)]` 路径夹具 —— 测的是路径长度和
  `sockaddr_un` 104 字节上限,那个字符串只是个"够长的样本",跟品牌无关。
- `src-tauri/packages/macos/info_merge.plist` 的 `AssociatedBundleIdentifiers` ——
  它指的是**系统服务**(clash-verge-service)的真实 bundle id,那个组件确实叫这个名字,
  改了反而对不上。同理,界面文案里"Clash Verge 系统服务"那些字样也全部保留。

**代价:** rClash 用的是全新的应用数据目录,第一次启动是空配置,不会继承 Clash Verge Rev
里已有的订阅和设置。两者可以并存,互不干扰。

`#[cfg(test)]` 里那些用 `"Clash Verge.app"` 当路径夹具的测试**没有动** —— 它们测的是
路径长度和 sockaddr_un 上限那类边界行为,那个字符串只是个够长的样本,跟品牌无关。

### 同时关掉了自动更新

| 改动 | 原因 |
|---|---|
| `bundle.createUpdaterArtifacts` → `false` | 生成更新包需要 `TAURI_SIGNING_PRIVATE_KEY`,那是上游的私钥,我们没有。开着必然构建失败。 |
| `plugins.updater.endpoints` → 指向本仓库 | **这条是安全性的**:端点原本指向上游 clash-verge-rev 的 release。留着的话,「检查更新」会把 rClash 更新成官方 Clash Verge Rev 的构建 —— 推送按钮、改名、全部被覆盖掉。指回本仓库后该文件不存在,检查更新会失败,但绝不会把应用换成别人的构建。 |

想恢复自动更新的话,需要自己生成一对 minisign 密钥(`pnpm tauri signer generate`),
把公钥填进 `plugins.updater.pubkey`,私钥作为 secret 传给 CI,并把
`createUpdaterArtifacts` 改回 `true`。

### 关于 GPL

改名和修改本身是 GPL-3.0 允许的。按 GPL-3.0 §5(a) 的要求,修改过的版本必须带有显著的
修改说明 —— 本文件就是。`LICENSE` 原样保留,上游的版权声明也没有删。
"rClash" 这个名字不代表上游作者的任何背书。

## 同步上游新版本的做法

```bash
# 1. 把上游对应版本的源码拉到临时目录
git clone --depth 1 --branch <新版本tag> \
  https://github.com/clash-verge-rev/clash-verge-rev /tmp/cvr-new

# 2. 先把自己的改动存成补丁(注意:改名之后要带的文件比原来多,见上面那张表)
git diff HEAD -- src/components/proxy/proxy-head.tsx \
  src-tauri/tauri.conf.json src-tauri/tauri.windows.conf.json src/index.html package.json \
  src-tauri/src/utils/dirs.rs src-tauri/src/utils/schtasks.rs src-tauri/src/utils/init.rs \
  src-tauri/src/lib.rs src-tauri/src/utils/resolve/window.rs \
  src-tauri/src/utils/macos_launch_guard.rs > /tmp/my-change.patch

# 3. 用新版本覆盖(注意排除 .git / node_modules / target)
#    然后把三个新增文件拷回来,再 git apply /tmp/my-change.patch

# 4. 验证
pnpm i && pnpm typecheck && pnpm test && pnpm lint
```

如果 `proxy-head.tsx` 那 5 行打不上（上游重构了那个组件），去新版里找到测延迟按钮
（`NetworkCheckRounded` 那个 `IconButton`），在它后面插一行 `<DenoPushButton />` 即可。

## 使用方法

1. 打开**代理**页，先点**测延迟**按钮（推送用的是内核里已有的延迟数据，不会自己重测）
2. 切到左边导航栏最下面的 **Deno Push** 页：
   - 第一次先在下半部分的「设置」里填 Deno 的 `/push` 地址和 `PUSH_KEY`，点保存
   - 然后点「推送美国节点」。这一轮的统计就显示在按钮下面

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

见 `.github/workflows/build.yml`。打 `v*` 的 tag 会自动出 macOS（Apple 芯片 / Intel）、
Windows、Linux 的包并发 Release；推 main 只构建，产物挂在那次运行的 Artifacts 里。

本地构建：

```bash
pnpm i
pnpm run prebuild <目标平台三元组>   # 下载 mihomo 内核 sidecar
pnpm build
```

**没有做代码签名**，首次打开时 macOS 的 Gatekeeper 和 Windows 的 SmartScreen 会拦一下，
按提示放行即可。去掉这些提示需要 Apple 开发者账号和代码签名证书。
