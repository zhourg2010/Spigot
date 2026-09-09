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

### Tauri 权限:补齐 fs 的三条,新增内容收进 `$APPDATA/spigot/`

**Tauri 的 ACL 是按命令授权的,名字像不代表通用。** 上游 capabilities 里的 fs 权限
只有三条:`fs:allow-read-file` / `fs:allow-write-file` / `fs:allow-exists`。而:

| JS 里写的 | 实际调用的命令 | 需要的权限 | 上游有吗 |
|---|---|---|---|
| `readFile()` | `read_file` | `fs:allow-read-file` | ✅ |
| `writeFile()` | `write_file` | `fs:allow-write-file` | ✅ |
| `exists()` | `exists` | `fs:allow-exists` | ✅ |
| `readTextFile()` | `read_text_file` | `fs:allow-read-text-file` | ❌ |
| `writeTextFile()` | `write_text_file` | `fs:allow-write-text-file` | ❌ |
| `mkdir()` | `mkdir` | `fs:allow-mkdir` | ❌ |

少一条的后果是运行时 `plugin fs|<命令> not allowed by ACL`,而 **`tsc` 和 vitest 都
看不见** —— 只有真装上、点下去才知道。这一条连着栽了两次:先是 `mkdir`(设置存不进去、
「扫描节点」也跟着挂),改掉之后又是 `writeTextFile`。

**改法:把缺的三条加进 `capabilities/migrated.json`,新增的落盘内容收进
`$APPDATA/spigot/` 一个目录。**

中间试过"绕开权限"的路子 —— 不建目录、文件散在 `$APPDATA` 根下、文本走
`readFile`/`writeFile` 加手工编解码。那条路是错的:**那份 capability 的 `fs:scope` 是
`["$APPDATA/**", "$RESOURCE/../**", "**"]`**,这个应用本来就能读写磁盘上任意文件。
在这个前提下再拒绝 `write_text_file`,只是同样的字节、同样的路径、换个命令名不让走 ——
一点安全性都没多,却要付出四个散文件混在上游文件堆里、外加一层二进制包装的代价。

**新增的检查:`scripts/check-capabilities.mjs`**,CI 的 test job 里跑(`pnpm check:caps`,
几百毫秒)。它列出本仓库用到的每一条权限和"谁在用",扫整个 capabilities 目录,缺了就红。

挡两种情况:一是以后加了新的 fs / 插件调用忘了配权限;二是**同步上游时
`migrated.json` 被覆盖**,我们加的几条没了 —— 那样 CI 会红,而不是等包发出去、
装上才发现。反向验过:临时删掉 `fs:allow-write-text-file`,它退出码 1 并指出是谁在用。

顺带保留的一处:**`ensureGeoDb` 绝不往外抛。** 它的契约本来就是"用不了返回 false,
调用方降级",但原来 `exists()` 这些是裸调的 —— 这正是让 mkdir 那次的影响从"存不了设置"
扩大到"连扫描都挂"的原因。一个可选依赖不该有能力把主流程带走。

顺带两处:

- **`ensureGeoDb` 现在绝不往外抛。** 它的契约本来就是"用不了返回 false,调用方降级",
  但原来 `exists()` 这些是裸调的。一个可选依赖不该有能力把主流程带走 ——
  GeoIP 挂了就是国家显示"未知",不该变成"扫描失败"。
- **加了三条测试**钉住"落盘路径不含目录分隔符"。少权限是**运行时**才炸的 ACL 错误,
  类型检查和单元测试都看不见,只有真装上打开才知道;而"往路径里加一层目录"看起来
  是个完全无害的改动。这道断言把它挡在 CI 里。

### 版本号改走自己的线:2.5.4 → 1.0.0

原来三处版本号(`package.json` / `tauri.conf.json` / `Cargo.toml`)都直接沿用上游的
`2.5.4`。**结果是连出两个包却完全分不清**:

| | v2.5.4-r1 | v2.5.4-r2 |
|---|---|---|
| zip 文件名 | `Spigot_2.5.4_x64_portable.zip` | 一模一样 |
| 应用里显示的版本 | 2.5.4 | 一模一样 |
| 唯一区别 | git tag —— 而 tag 不在文件里 | |

打包脚本的文件名是 `Spigot_${package.json 的 version}_${arch}_portable.zip`,
tag 根本没进去。下载目录里放两个就认不出哪个是哪个,装完也看不出跑的是哪个。

**改成 Spigot 自己的版本线,从 `1.0.0` 起算。** 基线是上游哪一版,写在 README 和
本文件开头,不挤进版本号。

考虑过但否决的写法:**`2.5.4-r2` 这种带后缀的**。在 semver 里 `-` 引出的是 prerelease,
`2.5.4-r2` 排序上**小于** `2.5.4` —— 我们的新构建会显得比上游基线还老。真要恢复
自动更新的话,更新器会把它当降级。

### 版本号由 tag 驱动,不再靠人记得改

上一节把版本号改成了 Spigot 自己的 `1.0.0`,但**没解决机制** —— 下次发版还是要
手动改三个文件(`package.json` / `Cargo.toml` / `tauri.conf.json`),忘一次就又是
两个同名的包。

现在 `build.yml` 在构建前加一步:

    - name: 用 tag 定版本号
      if: github.ref_type == 'tag' || inputs.tag != ''
      run: pnpm release-version <tag>

`release-version.mjs` 是**上游自带的**,它就是干这个的(自动去掉 `v` 前缀、写三处),
之前只是没有任何东西调它。

于是 tag 成了唯一的事实来源:`v1.0.1` → `Spigot_1.0.1_x64_portable.zip` → 应用里
显示 1.0.1。仓库里 `package.json` 的值降级成开发时的默认值。

**但这还剩最后一点人工:版本号仍然要人自己想。** 所以 `tag` 的默认值改成了 `auto` ——
`scripts/next-version.mjs` 查最近一个**正式** Release(`/releases/latest` 本来就跳过
prerelease,dev 构建不会把版本号顶上去),补丁号 +1。要跨小版本/大版本才手填。

版本号由**独立的 `version` job 算一次**,`build` 和 `release` 都用它的输出。两边各算
一次的话,万一中间有人发了个 Release,两边会算出不同的值 —— 那种错排查起来极其费劲:
包名和 Release 名对不上,而两处代码看着都对。

`next-version.mjs` 里有一处刻意的选择:**上一个 tag 解析不了时报错停下,不退回
`v1.0.0`。** 静默退回的话会去发一个早就发过的版本号,而报出来的错是"这个版本发过了",
跟真正的原因(上一个 tag 看不懂)差着十万八千里。

**另加一道拦截:** release job 开头查一次这个 tag 有没有发过。撞上已存在的 tag 时
`action-gh-release` 不会报错,而是往那个已有的 Release 上**追加**资产 —— 结果是一个
Release 里挂着两个不同构建的包,旧的还在。查到就红着停下,并说明怎么办。

放在 release job 开头而不是更早:再往前就得单开一个 job 让 build 依赖它,为一个
不常犯的错误加一道串行依赖不值。这里失败的代价只是"包没发出去,但产物还在这次运行的
Artifacts 里",捡得回来。

验证:`release-version.mjs v1.0.1` 在本地真跑过一遍(临时装了它依赖的 commander),
三处全部改成 `1.0.1`、`v` 前缀正确剥掉;重复版本号的判断拿真实 GitHub API 试过
—— 已存在的 tag 返回 200(拦下),没发过的返回 404(放行)。

### `release` 不再被无关平台的失败卡住

Release 里**只有 Windows 便携版 zip** —— macOS 的 dmg、Linux 的 deb/rpm 都只躺在
Artifacts 里。但 `release` 是 `needs: build`,矩阵里任何一条腿失败,整个 build 就算失败,
release 被跳过。

真发生过一次(2026-09-08,v1.0.0 那轮):macOS ARM 那条腿在**上传产物的最后一步**撞上
GitHub 产物服务的 403 —— 日志里文件已经找到、65MB 也传完了,挂在 `FinalizeArtifact`。
于是一个跟 Release 内容毫无关系的产物,把 Windows 的包卡住了,得手动重跑那条腿。

改法:`release` 加 `always()`,不再因为别的平台失败而跳过。

**"那 Windows 真挂了怎么办"** —— 由已有的 `fail_on_unmatched_files: true` 兜底:
找不到 zip 就红着失败。那道检查本来是为"空 Release"加的,正好也能承担这件事,
不用再写一层条件。仍然排除 `cancelled`:并发取消(有新构建顶上来)时不该发版。

## 改动内容(2026-09-09):免费节点池的实测(第一步:链接解析 + 服务端通信)

### 为什么验证在客户端做

Deno Deploy 上没有代理内核,拨不了节点 —— 服务端只能记"这条链接长什么样",记不了
"它现在还能不能用"。而免费节点是从公开仓库抓来的,**最常见的死法是凭据失效或被封,
不是端口关闭**:服务器还在跑、端口还开着、TLS 还握手成功,但 uuid 早就作废了。
所以"能不能用"只有真的拨一次才知道,而这台机器上正好有 mihomo。

(所以也没做 TCP / TLS 层面的"可达性验证" —— 那种验证对上面这种死法完全无感,
会给一个已经作废的节点打上"已验证",比没有标记更危险。)

### 怎么让内核认识这些节点

`delayProxyByName` 走的是 mihomo 的 `/proxies/{name}/delay`,**只能测配置里已经加载的
节点**。免费池不在你的订阅里,所以得先塞进去。

用的是 Clash Verge Rev 自带的 **`proxies` 类型 profile**:文件内容是
`{prepend, append, delete}`,`enhance/seq.rs` 的 `use_seq` 会把 `append` 里的节点
**追加**到运行时 `proxies` 列表(不是替换),`enhance_profiles` 让内核重载。
这是上游的一等机制。

排查过程中确认了一件重要的事:**普通 `merge` profile 不能用**。`enhance/merge.rs` 的
`deep_merge` 对非 mapping 一律 `*a = b`,也就是写 `proxies:` 会把用户真正的节点
**整个替换掉**。`merge.rs` 的测试夹具里出现了 `append-proxies`,但那只是夹具 ——
实现里没有对应处理,而且那个测试根本没断言(`let _ = ...`)。真正处理 prepend/append 的
是 `seq.rs`,只对 `rules` / `proxies` / `groups` 三种专用 profile 类型生效。

**一个副作用:** `use_seq` 追加节点之后,还会把这些名字塞进第一个 selector 类型的策略组
(seq.rs:92 起)。测试期间这批节点会出现在代理选择列表里 —— 不会被自动选中、不影响
路由,但看着乱。测完清空 append 就没了。

### 节点名用哈希,不用原名

免费节点的名字是抓来的,什么字符都可能有(emoji、引号、换行),而且**极可能跟用户
自己的节点重名** —— mihomo 遇到重名会拒绝加载整份配置。所以一律改名成
`chk-<uriHash 前 12 位>`:不可能撞、不可能坏 YAML,测完还能凭名字直接映射回 uri_hash
传给服务端,不用另外维护一张表。

### 这一步做了什么

`src/services/free-pool.ts`:

- `parseShareUri()` —— 分享链接 → Clash 节点对象,**是 deno-push.ts 里 `toShareUri`
  的逆运算**,字段映射刻意一一对应
- `checkName()` / `hashOfCheckName()` —— 测试名字与 uri_hash 的双向映射
- `fetchFreePool()` / `reportChecks()` —— 跟 `/free/pool` 和 `/free/verify` 通信

**测试 24 项全过**,其中最重要的是**往返一致**:7 种协议组合(含 reality、ws、grpc、
中文 emoji 名字)经 `toShareUri` → `parseShareUri` 之后关键字段完全一致。
两边对不上的话,"推给家人的"和"测过的"就不是同一个东西 —— 那种错不报任何异常,
只表现为"明明测通了家人却连不上",极难往这上面想。

另外 14 条钉的是**坏输入必须返回 null**:端口越界、reality 缺公钥、vmess 缺 add……
硬塞一个残缺的进去,得到的是永远连不上的节点,而它会被记成"测过了,不通" ——
那是在污染数据,不是在测试。

**还没做:** 注入 profile、逐个拨、进度界面。下一步。
