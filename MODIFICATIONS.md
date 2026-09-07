# Spigot 的来源与改动说明

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

## 改动内容(2026-09-06):设置搬进设置页,Push 页改成节点表 + 服务开关

原来 Deno Push 那一页把两种东西混在一起:**配一次就不动的**(地址、密钥、几个阈值)和
**每天都在干的**(挑节点、推)。混在一起的结果是后者被挤没了 —— 整页就一个"推送"按钮,
推完给几个数字,你根本不知道它到底推了哪些、为什么别的没推。

现在:

| 在哪 | 放什么 |
|---|---|
| 设置页 →「Deno Push」一节 | 推送地址、密钥、节点数上限、延迟上限、最少节点数、严格模式 |
| Deno Push 页 | 服务开关 + 节点表 + 过滤 + 勾选 + 推送 |

### services/deno-push.ts 拆了

原来 `pushToDeno` 一个函数从头干到尾,算到一半的那份"候选节点"用完就扔。而
"先看看有哪些节点再自己挑"要的正是它。拆成四个:

| | |
|---|---|
| `scanNodes()` | 把内核当前加载的节点摊成一张表,**不做任何筛选** |
| `pickForPush()` | 按设置自动筛(GeoIP 美国 + 延迟达标),纯函数,可测 |
| `pushRows()` | 把给定的一批推上去,不管是自动筛的还是手动勾的 |
| `pushToDeno()` | = 上面三个串起来,行为跟以前一模一样 |

**关键是 `pushToDeno` 现在也走 `pushRows`**,不再自带一份筛选逻辑。两份实现迟早会走偏,
而这条路上走偏的后果是"推给家人的节点不对",不会有任何报错。

`roundRobin` 顺手泛型化了 —— 它只做重排、不碰字段,本来就不该绑死在 `ClashProxy` 上。

### 界面上两个刻意的决定

- **推不了的节点也列出来**,只是行是灰的、勾选框禁用,鼠标悬停说明为什么。
  看得见"这个节点为什么没被推"比它默默消失有用得多 —— 以前就是默默消失,
  于是"为什么只推了 12 个"只能靠猜。
- **勾选状态按节点名存,不按下标。** 重新扫描之后顺序会变,存下标等于选错节点。

### 服务开关

对应 Deno 端的 `/switch`(见 nodes-sub 仓库)。地址从 `pushUrl` 推出来
(`new URL('/switch', pushUrl)`),不让用户再填一遍 —— 两个地址永远在同一台服务器上,
分开填只会填错。

### 顺带补了 CI 从来没跑过的测试

`.github/workflows/build.yml` 加了个 `test` job。仓库里一直有 vitest 套件(包括推送
筛选那部分),但**没有任何东西跑它**,等于白写。

单独一个 job 而不是塞进 `build`:它只要 Node、一分钟出结果,塞进 build 得等 Rust 编译完
才知道一个纯逻辑错误,而且四个平台各跑一遍纯属浪费。也**不**让 build 依赖它 ——
测试挂了照样出包,免得一个测试问题把安装包也卡住;但红叉会挂在那儿,看得见。

新增 9 条测试:`pickForPush` 6 条(严格/非严格模式、mislabeled、`delay=0` 不能当成
"极快"、排序),`switchUrlOf` 3 条。

## 改动内容(2026-09-06):可达性过滤 + 拉回服务器现有节点

### 可达性:能做的是「连不连得上」,不是「解不解锁」

做法是让内核拿每个节点去拨一次目标站点(mihomo 的 `delayProxyByName`,就是测延迟那个
接口,只把测试 URL 换成 `claude.ai` 之类)。拨得通 = 这条链路能到那台服务器;
拨不通 = 网络层就到不了(被墙、被机场屏蔽、节点本身死了)。

**它测不出「连得上但对方拒绝服务」** —— 比如节点在新加坡,`claude.ai` 连得上,但
Anthropic 按 IP 段判定地区不给用。要判断那个得看响应正文,而前端没法把任意节点当代理
去发一个能读正文的请求(内核只按当前选中的节点走)。

所以这个过滤器的定位是**排除明显不通的,不是保证能用**。界面上也是这么写的 ——
写清楚比让人误以为筛完就一定能用重要。

三个细节:

- **只测当前筛出来的**,不是全部。几百个节点 × 5 秒超时,全测等到天黑。
- **并发 8 个**。再高会把内核和出口带宽打满,反而测出一堆假超时。
- 超时/拒绝/内核报错一律记 `0`(不通),**不能留 `undefined`**。`undefined` 的含义是
  "还没测过",跟"测了但不通"是两回事;混起来的话过滤器会把没测过的当成通过。
  表格里也是三态:灰点=没测过、绿点=通、红点=不通。

### 拉回服务器上现有的节点

对应 Deno 端新加的 `GET /push`(见 nodes-sub 仓库)。**不读订阅链接** —— 那些链接经过
协议过滤、数量截断、停用剔除,拿到的是加工过的结果,原样推回去会把加工固化(比如某条
链接只发 vless,拉回去再推,别的协议就永久没了)。

面板里停用的节点也列出来并标灰,因为服务端返回时保留了 `#OFF# ` 前缀 —— 不这么做的话
"拉回来再推回去"会把后台手动停用的节点全部悄悄启用。

| 文件 | 改了什么 |
|---|---|
| `src/services/deno-push.ts` | 新增 `REACH_TARGETS` / `testReach` / `fetchRemotePool` / `nameOfUri` |
| `src/pages/deno-push.tsx` | 可达性按钮 + 过滤下拉 + 表格三态圆点列 + 服务器现状面板 |
| `src/services/deno-push.test.ts` | `nameOfUri` 3 条 |

## 改动内容(2026-09-06):Windows 便携版

上游本来就支持便携模式,而且不需要动 Rust —— exe 旁边放一个空的 `.config/PORTABLE`,
`src-tauri/src/utils/dirs.rs` 的 `init_portable_flag()` 读到它就把配置目录从
`%APPDATA%\<APP_ID>` 切到 `<exe目录>\.config\<APP_ID>`,更新器也会自动跳过
(见 `core/updater.rs`)。打包脚本 `scripts/portable.mjs` 上游也有,`package.json`
里的 `pnpm portable` 就是它 —— 只是上游那套调用它的 workflow 被我们删掉了。

所以这次只做两件事:**修脚本** + **在 workflow 里调它**。

| 文件 | 改了什么 |
|---|---|
| `scripts/portable.mjs` | 见下面三条 |
| `.github/workflows/build.yml` | Windows 那个 job 加一步 `pnpm portable <target>`,产物路径加上 `Spigot_*_portable.zip` |

`portable.mjs` 上游那版**对本仓库是坏的**,三处:

1. **release 目录找错了。** 上游写 `./src-tauri/target/<triple>/release`,但根目录的
   `Cargo.toml` 是 `[workspace]`、`src-tauri` 只是成员之一,**Cargo 工作区的 target 在
   工作区根**。改成 `./target/<triple>/release`。跟 `build.yml` 里缓存和产物路径栽过的
   是同一个坑。

2. **主程序名硬编码成 `clash-verge.exe`。** 我们 `productName` 改成了 Spigot,
   `tauri build` 会把 cargo 产出的 `clash-verge.exe` 重命名成 `Spigot.exe`。
   改成从 `tauri.conf.json` 读 `productName`,并保留 Cargo 包名当兜底 —— 万一以后
   Tauri 改了重命名行为,不至于莫名其妙找不到文件。找不到时会把目录里实际有哪些 `.exe`
   列出来,光一个 ENOENT 在 CI 日志里没法查。

3. **失败被吞了。** 上游结尾是 `.catch(console.error)` —— 打包失败照样退出码 0。
   那样 CI 会绿着跑完,最后发一个**没有便携版的 Release**,而且没人会注意到。
   改成非零退出;缺内核、缺资源目录也一律直接失败,不 warn ——
   少了内核的便携包就是个开不起来的壳,发出去比不发更糟。

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

## 改动内容(2026-08-25 改名,2026-09-06 定名 Spigot)

> **名字沿革:** 这一节最早改成的名字是 `rClash`,只在内部构建过一版就换掉了 ——
> 名字里带 "Clash" 既容易被当成上游的官方分支,也让它在任何一台机器上都一眼可辨。
> 现在的名字是 **Spigot**(水龙头/阀门):节点从这儿流向自建订阅服务,
> Deno Push 页上那个 404 开关本质就是把阀门拧上。下面表格里的值都是当前值。

上游的名字、应用 ID、开机自启任务名等等在系统里都是**全局唯一的键**。如果沿用上游的值,
这个客户端和机器上已经装着的 Clash Verge Rev 会互相打架 —— 共用同一个配置目录、抢同一把
单实例锁、覆盖对方的开机自启任务。所以改名不只是换个显示文字,下面这些是**功能性**的:

| 文件 | 改了什么 | 为什么必须改 |
|---|---|---|
| `src-tauri/tauri.conf.json` | `productName` → `Spigot`<br>`identifier` → `io.github.zhourg2010.spigot` | identifier 决定应用数据目录和单实例锁 |
| `src-tauri/tauri.windows.conf.json` | 同上的 `identifier` | 两份配置里的 id 必须一致 |
| `src-tauri/src/utils/dirs.rs` | `APP_ID` / `BACKUP_DIR` | 代码里直接用 APP_ID 拼数据目录,必须和 identifier 对齐 |
| `src-tauri/src/utils/schtasks.rs` | 计划任务名 → `Spigot` / `Spigot (Admin)` | Windows 计划任务名全局唯一,同名会互相覆盖 |
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

**代价:** Spigot 用的是全新的应用数据目录,第一次启动是空配置,不会继承 Clash Verge Rev
里已有的订阅和设置。两者可以并存,互不干扰。

`#[cfg(test)]` 里那些用 `"Clash Verge.app"` 当路径夹具的测试**没有动** —— 它们测的是
路径长度和 sockaddr_un 上限那类边界行为,那个字符串只是个够长的样本,跟品牌无关。

### 同时关掉了自动更新

| 改动 | 原因 |
|---|---|
| `bundle.createUpdaterArtifacts` → `false` | 生成更新包需要 `TAURI_SIGNING_PRIVATE_KEY`,那是上游的私钥,我们没有。开着必然构建失败。 |
| `plugins.updater.endpoints` → 指向本仓库 | **这条是安全性的**:端点原本指向上游 clash-verge-rev 的 release。留着的话,「检查更新」会把 Spigot 更新成官方 Clash Verge Rev 的构建 —— 推送按钮、改名、全部被覆盖掉。指回本仓库后该文件不存在,检查更新会失败,但绝不会把应用换成别人的构建。(仓库拆分那阵这个端点一度还指着 `nodes-sub`,改名时一并修正成 `zhourg2010/Spigot`。) |

想恢复自动更新的话,需要自己生成一对 minisign 密钥(`pnpm tauri signer generate`),
把公钥填进 `plugins.updater.pubkey`,私钥作为 secret 传给 CI,并把
`createUpdaterArtifacts` 改回 `true`。

### 关于 GPL

改名和修改本身是 GPL-3.0 允许的。按 GPL-3.0 §5(a) 的要求,修改过的版本必须带有显著的
修改说明 —— 本文件就是。`LICENSE` 原样保留,上游的版权声明也没有删。
"Spigot" 这个名字不代表上游作者的任何背书。

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

见 `.github/workflows/build.yml`。打 `v*` 的 tag 会构建四个平台并发 Release,
但 **Release 上只挂 Windows 便携版 zip** —— 平台照常全建(那是 CI 的价值:平台特有的
编译错误还得靠它发现),只是不都往 Release 上挂。macOS/Linux 的包和 Windows 安装版
在那次运行的 Artifacts 里,保留 30 天。推 main 只构建,不发 Release。

本地构建：

```bash
pnpm i
pnpm run prebuild <目标平台三元组>   # 下载 mihomo 内核 sidecar
pnpm build
```

**没有做代码签名**，首次打开时 macOS 的 Gatekeeper 和 Windows 的 SmartScreen 会拦一下，
按提示放行即可。去掉这些提示需要 Apple 开发者账号和代码签名证书。

## 改动内容(2026-09-06):Deno Push 页的性能优化

背景:实际用它的机器是一台老 Mac mini,机场有 500 个左右的节点。这一页当时是全量
渲染的 MUI 表格 —— 上游的代理列表、日志、连接页都上了虚拟化,唯独这一页没有,
因为它是新加的,没沿用那套。

改的都是新增文件和新增代码,**没有动上游文件**。

### 节点表(新文件 `src/components/deno-push/node-table.tsx`)

原来单行的构成:`TableRow` + 8×`TableCell` + `Chip` + `Checkbox` + **4 个 `Tooltip`**
+ 6 个内联 `sx` 对象 ≈ 15 个 MUI 元素。500 个节点全量渲染就是约 17500 个 React 元素、
3000 次 emotion 样式序列化、2000 个 Tooltip 实例,而且**每敲一个搜索字符重来一遍**。

三件事一起做:

| 改动 | 说明 |
|---|---|
| 虚拟化 | `@tanstack/react-virtual`,仓库本来就有(代理列表和日志页在用)。渲染量跟节点总数脱钩,只画视口里那二三十行 |
| 单行不用任何 MUI | CSS grid 排版 + 原生 `<input type=checkbox>` + 原生 `title` 属性。原生 title 的显示效果跟 `Tooltip` 一样,成本是零 |
| 行组件 `memo`,只收原始值 | `checked` 传 boolean 而不是整个 `Set`;`onToggle` 用 `useCallback` + 函数式 `setState` 保证引用稳定。否则勾一个框会重渲视口里所有行 |

行高固定,所以**不挂 `measureElement`** —— 那会给每个渲染出来的行装一个 `ResizeObserver`,
而行高是常量,量了也白量。

搜索框用 `useDeferredValue` 而不是 debounce:输入框始终用最新值立刻回显,表格在低优先级里
用"落后一拍"的值重算,中途再敲一个字符上一轮直接作废。好处是不用猜延迟多少毫秒合适,
快机器上一点都不慢。

「服务器上现在有什么」那个面板也 `useMemo` 了 —— 它同样可能几百行,而且原来会跟着
整页一起重建,包括每次敲搜索框(跟它毫无关系)。

### 并发池(`mapPool`)

原来是"固定大小批次 + `Promise.all`":切 8 个一批,整批等最慢的那个。测可达性的超时是
5 秒,一批里只要有一个节点是死的,另外 7 个 0.3 秒测完也得干等 5 秒。

500 个节点、其中 60 个不通:切批次约 **3.5 分钟**,并发池约 **65 秒**。

`scanNodes` 里的 DNS 解析(8 秒超时,并发 16)是同一个毛病,一并改了。

进度回调加了时间节流(200ms):那头是 React 的 `setState`,一个节点回调一次就是
500 次重渲,比测试本身还费。

### GeoIP 库改用 typed array

线上那个 CSV 是 6.79 MB、约 30 万条。同规模合成数据实测(Node 24,`heapUsed + arrayBuffers`,
前后都手动 GC):

| | `number[]`×2 + `string[]` | `Uint32Array`×2 + `Uint16Array` |
|---|---|---|
| 常驻内存 | 16.6 MB | **3.0 MB** |
| 解析耗时 | 119 ms | **54 ms** |
| 二分查询(500 次 × 200 轮) | 4 ms | 4 ms |

两位国家码打包进一个 `uint16`(高字节第一个字符,低字节第二个)。解析改成手动走行游标,
不再 `split('\n')` —— 那会一次性造出三十万个临时字符串,峰值内存比库本身还大。

**查询速度没有变化**,不要当成卖点。最初这里以为连续内存会让二分变快,实测反而是
4ms → 6ms(每次查询 `fromCharCode` 新建一个字符串),加了国家码缓存才拉回持平。

顺带修掉解析里两个会静默出错的地方:IP 超出 uint32 范围的行原本会被 `Uint32Array`
**静默截断**成一个完全错误的区间;国家码被行尾截断的行会去读下一行的字符凑数。
现在两种都直接丢掉,并有测试覆盖。

### 第二轮:不重复干同样的活

上一轮解决的是「一次操作有多慢」,这一轮是「同样的活为什么要干第二遍」。

**DNS 结果落盘。** 500 个节点的扫描里 DNS 是最慢的一步(并发 16,每个 DoH 往返几十到
几百毫秒,解析不了的要等满 8 秒)。原来缓存只在内存里,每次开应用都从零重解析。
现在存到 `deno-push/dns-cache.json`,TTL 24 小时。

**只把成功的结果落盘,失败的只留在内存里。** 断网时 500 个域名会全部解析失败,
如果连 null 一起存下来,下一次(哪怕网络已经好了)整张表的 IP 都是"解析不了"、
国家全是未知、自动勾选一个都选不上 —— 而且看不出是缓存的锅。

取舍要说清楚:落盘之后机场万一换 IP,最多有 24 小时按旧 IP 判国家。延迟数据仍是
每次实时从内核拿的,所以死节点照样被阈值挡掉。TTL 再短就没意义 —— 一天扫一次的话
12 小时的 TTL 等于缓存永远不命中。

**运行时配置的解析结果缓存。** 合并后的配置几百 KB(节点 + 规则 + 策略组),
`js-yaml` 是同步的,解析期间界面完全卡住。而「重新扫描」最常见的用途是取新的延迟,
配置根本没变。拿整段文本当 key 直接比较 —— 几百 KB 的 memcmp 是零点几毫秒,
比任何 hash 都快且不会碰撞。

**重新扫描保留可达性结果**(`carryOverReach`)。原来点一次「重新扫描」就把
claude/gpt/gemini 三轮的结果清空,而重测一轮 500 个节点要一分多钟。
**认的是 name + server + port 三者都一样**,不是只认名字:机场经常沿用节点名换掉
后端,那种情况下旧结果是错的,宁可标成灰点让你重测,也不能显示绿点说它通。

### 设置页:Deno Push 一节从右栏挪到左栏

设置页是两栏。按设置条目数算,原来是左 14(系统 2 + Clash 内核 12)/ 右 25
(Verge 基础 10 + Verge 高级 11 + Deno Push 4)—— 右栏差不多是左栏的两倍长,
而新增的这一节又加在长的那一边。挪到左栏末尾之后是 18 / 21,两栏基本齐平。

代价是左栏「内核 / 系统」的归类不再严格。接受这个代价:一个要滚半天才到底的页面,
比归类不纯粹更影响用。

(考虑过做成可拖拽的 —— 仓库里本来就有 @dnd-kit,上游在 profile / 规则编辑器等处
用了。没做:跨两栏的拖拽要处理列间移动和落点判定,顺序还得持久化,而 IVergeConfig
在 Rust 侧是强类型的、加字段就要动 Rust。对一个几个月开一次的页面不划算。)
